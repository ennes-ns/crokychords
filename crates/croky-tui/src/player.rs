//! MIDI playback: `schedule` turns a song into timed note events (pure, tested), `Player`
//! runs them on a thread against a midir output with absolute deadlines and records how late
//! each send was, so the screen can show the real scheduler jitter.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use croky_core::{is_rest_token, parse_token, voice_chord, Song};
use midir::MidiOutputConnection;

/// MIDI channel 1.
pub const CHANNEL: u8 = 0;
pub const VELOCITY: u8 = 90;
/// Note length as a fraction of the chord length, so repeated chords re-attack.
pub const GATE: f64 = 0.95;
/// usize::MAX in `Shared::chord` means "not playing".
pub const IDLE: usize = usize::MAX;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    /// Beats from song start.
    pub beat: f64,
    pub message: [u8; 3],
    /// Index into `song.chords` of the chord this event belongs to.
    pub chord: usize,
}

/// Note events of the song: bass in octave 2 plus a close voicing from octave 4 (the
/// `voiceChord` defaults), note-offs before note-ons at equal times. Rests are silent.
pub fn schedule(song: &Song) -> Vec<Event> {
    let key = song.key();
    let mut events = Vec::new();
    let mut start = 0.0;
    for (i, c) in song.chords.iter().enumerate() {
        let chord_start = start;
        start += c.beats;
        if is_rest_token(&c.token) {
            continue;
        }
        let Ok(chord) = parse_token(&c.token) else {
            continue;
        };
        let mut notes = voice_chord(&chord, key, 2, 4);
        notes.sort_unstable();
        notes.dedup();
        for n in notes
            .into_iter()
            .filter_map(|n| u8::try_from(n).ok())
            .filter(|n| *n < 128)
        {
            events.push(Event {
                beat: chord_start,
                message: [0x90 | CHANNEL, n, VELOCITY],
                chord: i,
            });
            events.push(Event {
                beat: chord_start + c.beats * GATE,
                message: [0x80 | CHANNEL, n, 0],
                chord: i,
            });
        }
    }
    // Stable: at equal beats note-offs (0x80) come before note-ons (0x90).
    events.sort_by(|a, b| {
        a.beat
            .total_cmp(&b.beat)
            .then(a.message[0].cmp(&b.message[0]))
    });
    events
}

/// State shared between the scheduler thread and the UI.
#[derive(Default)]
pub struct Shared {
    pub stop: AtomicBool,
    pub chord: AtomicUsize,
    /// Worst lateness of a send against its deadline in this run, in microseconds.
    pub max_late_us: AtomicU64,
    pub sent: AtomicU64,
}

pub struct Player {
    pub out: Arc<Mutex<MidiOutputConnection>>,
    pub port_name: String,
    pub shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
}

impl Player {
    pub fn new(out: MidiOutputConnection, port_name: String) -> Player {
        let shared = Arc::new(Shared::default());
        shared.chord.store(IDLE, Ordering::Relaxed);
        Player {
            out: Arc::new(Mutex::new(out)),
            port_name,
            shared,
            handle: None,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.handle.as_ref().is_some_and(|h| !h.is_finished())
    }

    pub fn play(&mut self, song: &Song, looped: bool) {
        self.stop();
        let events = schedule(song);
        let total = song.total_beats();
        let seconds_per_beat = 60.0 / song.tempo;
        let shared = Arc::clone(&self.shared);
        let out = Arc::clone(&self.out);
        shared.stop.store(false, Ordering::Relaxed);
        shared.max_late_us.store(0, Ordering::Relaxed);
        shared.sent.store(0, Ordering::Relaxed);
        self.handle = Some(thread::spawn(move || {
            run(&events, total, seconds_per_beat, looped, &shared, &out);
        }));
    }

    pub fn stop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.shared.chord.store(IDLE, Ordering::Relaxed);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stop();
    }
}

fn send(out: &Mutex<MidiOutputConnection>, message: &[u8]) {
    if let Ok(mut conn) = out.lock() {
        let _ = conn.send(message);
    }
}

fn run(
    events: &[Event],
    total_beats: f64,
    seconds_per_beat: f64,
    looped: bool,
    shared: &Shared,
    out: &Mutex<MidiOutputConnection>,
) {
    let mut sounding = [false; 128];
    let mut t0 = Instant::now();
    'outer: loop {
        for e in events {
            let deadline = t0 + Duration::from_secs_f64(e.beat * seconds_per_beat);
            // Sleep in short slices so stop stays responsive, then send at the deadline.
            loop {
                if shared.stop.load(Ordering::Relaxed) {
                    break 'outer;
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                thread::sleep((deadline - now).min(Duration::from_millis(20)));
            }
            let late = Instant::now().saturating_duration_since(deadline);
            shared
                .max_late_us
                .fetch_max(late.as_micros() as u64, Ordering::Relaxed);
            send(out, &e.message);
            shared.sent.fetch_add(1, Ordering::Relaxed);
            let note = usize::from(e.message[1] & 0x7f);
            sounding[note] = e.message[0] & 0xf0 == 0x90;
            if sounding[note] {
                shared.chord.store(e.chord, Ordering::Relaxed);
            }
        }
        if !looped || events.is_empty() {
            // Let the last chord finish before reporting idle.
            let end = t0 + Duration::from_secs_f64(total_beats * seconds_per_beat);
            while Instant::now() < end && !shared.stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(10));
            }
            break;
        }
        t0 += Duration::from_secs_f64(total_beats * seconds_per_beat);
    }
    for (note, on) in sounding.iter().enumerate() {
        if *on {
            send(out, &[0x80 | CHANNEL, note as u8, 0]);
        }
    }
    send(out, &[0xB0 | CHANNEL, 123, 0]); // all notes off
    shared.chord.store(IDLE, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_chords_and_skips_rests() {
        let song = Song::from_json(
            r#"{"schema":1,"title":"t","key":{"tonic":"C","mode":"major"},"tempo":120,
            "meter":{"beats":4,"unit":4},"chords":[{"token":"I","beats":4},
            {"token":"rest","beats":2},{"token":"V","beats":2}]}"#,
        )
        .unwrap();
        let events = schedule(&song);
        // I = C2 C4 E4 G4, V = G2 G4 B4 D5: 8 notes, each on + off.
        assert_eq!(events.len(), 16);
        assert_eq!(events[0].message, [0x90, 36, VELOCITY]);
        let v_on: Vec<_> = events
            .iter()
            .filter(|e| e.chord == 2 && e.message[0] == 0x90)
            .collect();
        assert!(v_on.iter().all(|e| e.beat == 6.0));
        assert_eq!(
            v_on.iter().map(|e| e.message[1]).collect::<Vec<_>>(),
            vec![43, 67, 71, 74]
        );
        let last = events.last().unwrap();
        assert_eq!(last.message[0], 0x80);
        assert!((last.beat - (6.0 + 2.0 * GATE)).abs() < 1e-9);
    }
}
