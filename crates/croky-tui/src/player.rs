//! Band playback to MIDI. `plan_song` renders the song with core's `render_song` (every unmuted
//! track with its pattern) plus `render_melody`, exactly what the web app schedules. `Transport`
//! walks those events on a growing timeline (pure, tested): pass 0 plays from the start position
//! to the loop end, pass k ≥ 1 plays the loop range again, shifted by k range lengths, so the
//! jump back has no gap (`docs/specs/loop-v1.md`). `Player` owns a scheduler thread that sends
//! every message at its absolute deadline (optionally under SCHED_FIFO) and records how late each
//! send was; commands (play, stop, follow an edit, change the loop, audition) reach it over a
//! channel and apply at once.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use croky_core::{
    parse_token, render_melody, render_song, voice_chord, NoteEvent, RenderOptions, Song,
};

use crate::edit::{loop_bounds, LoopRange};

pub const NOTE_ON: u8 = 0x90;
pub const NOTE_OFF: u8 = 0x80;
pub const CONTROL_CHANGE: u8 = 0xB0;
pub const ALL_SOUND_OFF: u8 = 120;
pub const ALL_NOTES_OFF: u8 = 123;
/// How long an audition (a picked chord while stopped) sounds.
pub const AUDITION: Duration = Duration::from_millis(600);
pub const AUDITION_VELOCITY: u8 = 90;
/// Longest the scheduler waits for a command before it re-checks its deadlines.
const MAX_WAIT: Duration = Duration::from_millis(20);
/// Below this much time to the next deadline the thread sleeps instead of waiting on the channel.
const FINE_WAIT: Duration = Duration::from_millis(2);

/// Where the scheduler sends its bytes: a midir connection, or a recorder in tests.
pub trait Sink: Send + 'static {
    fn send(&mut self, message: &[u8]);
}

impl Sink for midir::MidiOutputConnection {
    fn send(&mut self, message: &[u8]) {
        // A send error (port gone) must not stop the clock.
        let _ = midir::MidiOutputConnection::send(self, message);
    }
}

/// The song as note events in beats and what playback needs besides.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// Unmuted tracks and the melody, sorted by start (ties keep the band first).
    pub events: Vec<NoteEvent>,
    pub total: f64,
    pub seconds_per_beat: f64,
    /// Every channel of the band and the melody (All Notes Off goes to these).
    pub channels: Vec<u8>,
}

/// `planSong` of the web scheduler, plus the channels.
pub fn plan_song(song: &Song) -> Plan {
    let tracks = song.tracks.as_deref().unwrap_or_default();
    let mut events = render_song(song, tracks, RenderOptions::default());
    events.extend(render_melody(song, RenderOptions::default()));
    // Stable: the band stays before the melody at equal starts.
    events.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut channels: Vec<u8> = tracks
        .iter()
        .map(|t| t.channel)
        .chain(song.melody.as_ref().map(|m| m.channel))
        .map(|c| (c & 0x0f) as u8)
        .collect();
    channels.sort_unstable();
    channels.dedup();
    Plan {
        events,
        total: song.total_beats(),
        seconds_per_beat: 60.0 / song.tempo,
        channels,
    }
}

/// Index of the first event starting at or after `beat` (events sorted by start).
pub fn first_event_at(events: &[NoteEvent], beat: f64) -> usize {
    events.partition_point(|e| e.start < beat)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Note-on of `plan.events[i]`.
    Note(usize),
    /// The playhead jumps from the loop end back to the loop start.
    Wrap,
    /// A song that does not loop has played to its end.
    End,
}

/// Position on the playback timeline. Timeline beats keep growing while looping; pass 0 maps
/// them 1:1 to song beats.
#[derive(Clone, Debug)]
pub struct Transport {
    pub plan: Plan,
    pub looping: bool,
    pub range: Option<LoopRange>,
    /// Timeline beat that the scheduler anchors to a time.
    pub anchor_beat: f64,
    pass: u64,
    index: usize,
}

impl Transport {
    /// Start at song beat `from` (the web scheduler's `start`: past the end it starts over, from
    /// the loop start when looping).
    pub fn new(plan: Plan, looping: bool, range: Option<LoopRange>, from: f64) -> Transport {
        let mut t = Transport {
            plan,
            looping,
            range,
            anchor_beat: 0.0,
            pass: 0,
            index: 0,
        };
        let from = from.clamp(0.0, t.plan.total.max(0.0));
        let (start, end) = t.bounds();
        let last = if looping { end } else { t.plan.total };
        let beat = match (from >= last, looping) {
            (false, _) => from,
            (true, true) => start,
            (true, false) => 0.0,
        };
        t.anchor(beat);
        t
    }

    /// The part that plays: the loop range clipped to the song, or the whole song.
    pub fn bounds(&self) -> (f64, f64) {
        if self.looping {
            let b = loop_bounds(self.range, self.plan.total);
            (b.start, b.end)
        } else {
            (0.0, self.plan.total)
        }
    }

    fn anchor(&mut self, beat: f64) {
        self.anchor_beat = beat;
        self.pass = 0;
        self.index = first_event_at(&self.plan.events, beat);
    }

    /// The next step and its timeline beat.
    pub fn peek(&self) -> (f64, Step) {
        if self.plan.total <= 0.0 {
            return (self.anchor_beat, Step::End);
        }
        let (start, end) = self.bounds();
        let offset = self.pass as f64 * (end - start);
        match self.plan.events.get(self.index) {
            Some(e) if e.start < end => (e.start + offset, Step::Note(self.index)),
            _ if self.looping => (end + offset, Step::Wrap),
            _ => (self.plan.total, Step::End),
        }
    }

    /// Consume the step `peek` returned.
    pub fn advance(&mut self, step: Step) {
        match step {
            Step::Note(_) => self.index += 1,
            Step::Wrap => {
                self.pass += 1;
                let (start, _) = self.bounds();
                self.index = first_event_at(&self.plan.events, start);
            }
            Step::End => {}
        }
    }

    /// Length of event `i` in beats; while looping a note is cut at the loop end.
    pub fn duration(&self, i: usize) -> f64 {
        let e = &self.plan.events[i];
        if self.looping {
            e.duration.min(self.bounds().1 - e.start)
        } else {
            e.duration
        }
    }

    /// Timeline beat → song beat: wrapped into the loop range while looping, else clamped.
    pub fn song_beat(&self, beat: f64) -> f64 {
        if !self.looping {
            return beat.min(self.plan.total);
        }
        let (start, end) = self.bounds();
        let length = end - start;
        if beat < end || length <= 0.0 {
            return beat;
        }
        beat - ((beat - start) / length).floor() * length
    }

    /// Apply a change while playing (the web scheduler's `#rebase`): `position` is the song beat
    /// under the old settings; the timeline restarts there (pass 0), or at the loop start when
    /// the position is past the new loop end.
    pub fn rebase(&mut self, position: f64, change: impl FnOnce(&mut Transport)) {
        change(self);
        let (start, end) = self.bounds();
        let beat = if self.looping && position >= end {
            start
        } else {
            position.min(self.plan.total.max(0.0))
        };
        self.anchor(beat);
    }
}

/// Lateness of sends against their deadlines: a histogram in 10 µs buckets.
pub struct LateStats {
    buckets: [AtomicU64; LATE_BUCKETS],
    max_us: AtomicU64,
}

const LATE_BUCKETS: usize = 100;
const LATE_BUCKET_US: u64 = 10;

impl Default for LateStats {
    fn default() -> Self {
        LateStats {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            max_us: AtomicU64::new(0),
        }
    }
}

impl LateStats {
    fn reset(&self) {
        for b in &self.buckets {
            b.store(0, Ordering::Relaxed);
        }
        self.max_us.store(0, Ordering::Relaxed);
    }

    fn record(&self, late: Duration) {
        let us = late.as_micros() as u64;
        let i = ((us / LATE_BUCKET_US) as usize).min(LATE_BUCKETS - 1);
        self.buckets[i].fetch_add(1, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }

    /// (messages, p99 as the upper edge of its 10 µs bucket, max), in µs.
    pub fn summary(&self) -> (u64, u64, u64) {
        let counts: Vec<u64> = self
            .buckets
            .iter()
            .map(|b| b.load(Ordering::Relaxed))
            .collect();
        let total: u64 = counts.iter().sum();
        let max = self.max_us.load(Ordering::Relaxed);
        let rank = total.saturating_mul(99).div_ceil(100);
        let mut seen = 0;
        for (i, c) in counts.iter().enumerate() {
            seen += c;
            if total > 0 && seen >= rank {
                return (total, ((i as u64 + 1) * LATE_BUCKET_US).min(max), max);
            }
        }
        (total, max, max)
    }
}

/// State shared between the scheduler thread and the screen.
pub struct Shared {
    pub playing: AtomicBool,
    /// Song beat of the playhead as f64 bits; NaN when stopped.
    position: AtomicU64,
    pub late: LateStats,
    /// How the scheduler thread runs: `SCHED_FIFO 40`, or `normal (...)` with the reason.
    pub sched: Mutex<String>,
}

impl Default for Shared {
    fn default() -> Self {
        Shared {
            playing: AtomicBool::new(false),
            position: AtomicU64::new(f64::NAN.to_bits()),
            late: LateStats::default(),
            sched: Mutex::new(String::new()),
        }
    }
}

enum Command {
    Play {
        plan: Plan,
        from: f64,
        looping: bool,
        range: Option<LoopRange>,
    },
    Update(Plan),
    SetLoop {
        looping: bool,
        range: Option<LoopRange>,
    },
    Stop,
    Audition(Vec<[u8; 3]>),
    Quit,
}

pub struct Player {
    pub port_name: String,
    pub shared: Arc<Shared>,
    tx: Sender<Command>,
    handle: Option<JoinHandle<()>>,
}

impl Player {
    /// Start the scheduler thread on `sink`. `priority` > 0 asks for SCHED_FIFO at that priority
    /// (normal scheduling when the system refuses; the screen says why).
    pub fn new(sink: impl Sink, port_name: String, priority: i32) -> Player {
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let thread_shared = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name("croky-scheduler".into())
            .spawn(move || {
                let sched = set_realtime(priority);
                if let Ok(mut s) = thread_shared.sched.lock() {
                    *s = sched;
                }
                Scheduler::new(sink, &thread_shared).run(&rx);
            })
            .expect("spawn the scheduler thread");
        Player {
            port_name,
            shared,
            tx,
            handle: Some(handle),
        }
    }

    pub fn is_playing(&self) -> bool {
        self.shared.playing.load(Ordering::Relaxed)
    }

    /// Playhead in song beats while playing.
    pub fn position(&self) -> Option<f64> {
        let beat = f64::from_bits(self.shared.position.load(Ordering::Relaxed));
        (self.is_playing() && !beat.is_nan()).then_some(beat)
    }

    pub fn sched(&self) -> String {
        self.shared
            .sched
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    /// Play `song` from song beat `from` (the caller picks the loop start, 0 or the selection).
    pub fn play(&self, song: &Song, from: f64, looping: bool, range: Option<LoopRange>) {
        self.shared.playing.store(true, Ordering::Relaxed);
        let _ = self.tx.send(Command::Play {
            plan: plan_song(song),
            from,
            looping,
            range,
        });
    }

    /// Follow an edit while playing (chords, key, tempo, tracks): re-render and re-anchor at
    /// the current position; notes already sounding end as planned.
    pub fn update(&self, song: &Song) {
        let _ = self.tx.send(Command::Update(plan_song(song)));
    }

    pub fn set_loop(&self, looping: bool, range: Option<LoopRange>) {
        let _ = self.tx.send(Command::SetLoop { looping, range });
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Command::Stop);
    }

    /// Sound `token` in the song's key for `AUDITION` on `channel` (0-15), unless playing.
    pub fn audition(&self, song: &Song, token: &str, channel: u8) {
        let Ok(chord) = parse_token(token) else {
            return;
        };
        let notes = voice_chord(&chord, song.key(), 3, 4)
            .into_iter()
            .filter_map(|n| u8::try_from(n).ok().filter(|n| *n < 128))
            .map(|n| [NOTE_ON | (channel & 0x0f), n, AUDITION_VELOCITY])
            .collect();
        let _ = self.tx.send(Command::Audition(notes));
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Quit);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Ask for SCHED_FIFO at `priority` for the calling thread and a 1 ns timer slack (so sleeps
/// end on time even without real-time scheduling). Returns a description for the screen.
fn set_realtime(priority: i32) -> String {
    // SAFETY: PR_SET_TIMERSLACK only changes the calling thread's timer slack.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_TIMERSLACK, 1 as libc::c_ulong, 0, 0, 0);
    }
    if priority <= 0 {
        return "normal".into();
    }
    let param = libc::sched_param {
        sched_priority: priority,
    };
    // SAFETY: a valid param for the calling thread; only its scheduling changes.
    let rc = unsafe { libc::pthread_setschedparam(libc::pthread_self(), libc::SCHED_FIFO, &param) };
    if rc == 0 {
        format!("SCHED_FIFO {priority}")
    } else {
        format!("normal ({})", std::io::Error::from_raw_os_error(rc))
    }
}

struct Scheduler<'a, S: Sink> {
    sink: S,
    shared: &'a Shared,
    /// Playing: the transport and the time its anchor beat sounds.
    transport: Option<(Transport, Instant)>,
    /// Pending note-offs: (time, channel, note).
    offs: BinaryHeap<Reverse<(Instant, u8, u8)>>,
    /// How many note-ons of each channel/note are sounding; the note-off goes out at zero, so a
    /// retriggered note is not cut by the end of the earlier one.
    held: [[u16; 128]; 16],
    /// Channels that received notes since the last All Notes Off (bit per channel).
    used: u16,
}

impl<'a, S: Sink> Scheduler<'a, S> {
    fn new(sink: S, shared: &'a Shared) -> Self {
        Scheduler {
            sink,
            shared,
            transport: None,
            offs: BinaryHeap::new(),
            held: [[0; 128]; 16],
            used: 0,
        }
    }

    fn run(mut self, rx: &Receiver<Command>) {
        loop {
            self.fire_due();
            self.publish_position();
            let command = match self.next_deadline() {
                None => rx.recv().ok().or(Some(Command::Quit)),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left > FINE_WAIT {
                        match rx.recv_timeout((left - FINE_WAIT / 2).min(MAX_WAIT)) {
                            Ok(c) => Some(c),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => Some(Command::Quit),
                        }
                    } else {
                        match rx.try_recv() {
                            Ok(c) => Some(c),
                            Err(TryRecvError::Empty) => {
                                thread::sleep(left);
                                None
                            }
                            Err(TryRecvError::Disconnected) => Some(Command::Quit),
                        }
                    }
                }
            };
            if let Some(command) = command {
                if !self.handle(command) {
                    return;
                }
            }
        }
    }

    fn time_at(t: &Transport, anchor: Instant, beat: f64) -> Instant {
        let secs = (beat - t.anchor_beat) * t.plan.seconds_per_beat;
        if secs >= 0.0 {
            anchor + Duration::from_secs_f64(secs)
        } else {
            anchor
                .checked_sub(Duration::from_secs_f64(-secs))
                .unwrap_or(anchor)
        }
    }

    fn timeline_beat(t: &Transport, anchor: Instant, now: Instant) -> f64 {
        let ahead = now.saturating_duration_since(anchor).as_secs_f64();
        t.anchor_beat + ahead / t.plan.seconds_per_beat
    }

    /// The next transport step and when it is due; an End waits for the last note-offs.
    fn next_step(&self) -> Option<(Instant, Step)> {
        let (t, anchor) = self.transport.as_ref()?;
        let (beat, step) = t.peek();
        if step == Step::End && !self.offs.is_empty() {
            return None;
        }
        Some((Self::time_at(t, *anchor, beat), step))
    }

    fn next_deadline(&self) -> Option<Instant> {
        let off = self.offs.peek().map(|Reverse((t, _, _))| *t);
        let step = self.next_step().map(|(t, _)| t);
        match (off, step) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Send everything that is due, in time order; at equal times note-offs go first.
    fn fire_due(&mut self) {
        loop {
            let now = Instant::now();
            let off = self.offs.peek().map(|Reverse((t, _, _))| *t);
            let step = self.next_step();
            match (off, step) {
                (Some(o), s) if o <= now && s.is_none_or(|(t, _)| o <= t) => {
                    if let Some(Reverse((at, ch, note))) = self.offs.pop() {
                        self.note_off(ch, note, now.saturating_duration_since(at));
                    }
                }
                (_, Some((at, step))) if at <= now => self.fire(step, at, now),
                _ => return,
            }
        }
    }

    fn fire(&mut self, step: Step, at: Instant, now: Instant) {
        let late = now.saturating_duration_since(at);
        let Some((t, _)) = self.transport.as_mut() else {
            return;
        };
        t.advance(step);
        match step {
            Step::Note(i) => {
                let e = &t.plan.events[i];
                let (ch, note) = ((e.channel & 0x0f) as u8, (e.note & 0x7f) as u8);
                let velocity = e.velocity.clamp(1, 127) as u8;
                let beats = t.duration(i).max(0.0);
                let off = at + Duration::from_secs_f64(beats * t.plan.seconds_per_beat);
                self.offs.push(Reverse((off, ch, note)));
                self.note_on(ch, note, velocity, late);
            }
            Step::Wrap => {
                let channels = t.plan.channels.clone();
                self.release_all(&channels);
            }
            Step::End => self.finish(),
        }
    }

    fn note_on(&mut self, ch: u8, note: u8, velocity: u8, late: Duration) {
        self.sink.send(&[NOTE_ON | ch, note, velocity]);
        self.shared.late.record(late);
        let held = &mut self.held[usize::from(ch)][usize::from(note)];
        *held = held.saturating_add(1);
        self.used |= 1 << ch;
    }

    fn note_off(&mut self, ch: u8, note: u8, late: Duration) {
        let held = &mut self.held[usize::from(ch)][usize::from(note)];
        if *held == 0 {
            return;
        }
        *held -= 1;
        if *held == 0 {
            self.sink.send(&[NOTE_OFF | ch, note, 0]);
            self.shared.late.record(late);
        }
    }

    /// Note-offs for everything sounding, then All Notes Off on the used channels plus
    /// `channels`; pending note-offs are dropped. Returns the channel mask it covered.
    fn release_all(&mut self, channels: &[u8]) -> u16 {
        for ch in 0..16u8 {
            for note in 0..128u8 {
                if self.held[usize::from(ch)][usize::from(note)] > 0 {
                    self.sink.send(&[NOTE_OFF | ch, note, 0]);
                }
            }
        }
        self.held = [[0; 128]; 16];
        self.offs.clear();
        let mut mask = self.used;
        for &c in channels {
            mask |= 1 << (c & 0x0f);
        }
        for ch in (0..16u8).filter(|c| mask & (1 << c) != 0) {
            self.sink.send(&[CONTROL_CHANGE | ch, ALL_NOTES_OFF, 0]);
        }
        self.used = 0;
        mask
    }

    /// Stop playing: release everything, then All Sound Off on the same channels.
    fn finish(&mut self) {
        let channels = self
            .transport
            .take()
            .map(|(t, _)| t.plan.channels)
            .unwrap_or_default();
        let mask = self.release_all(&channels);
        for ch in (0..16u8).filter(|c| mask & (1 << c) != 0) {
            self.sink.send(&[CONTROL_CHANGE | ch, ALL_SOUND_OFF, 0]);
        }
        self.shared.playing.store(false, Ordering::Relaxed);
        self.shared
            .position
            .store(f64::NAN.to_bits(), Ordering::Relaxed);
    }

    fn publish_position(&self) {
        if let Some((t, anchor)) = &self.transport {
            let beat = Self::timeline_beat(t, *anchor, Instant::now()).max(t.anchor_beat);
            self.shared
                .position
                .store(t.song_beat(beat).to_bits(), Ordering::Relaxed);
        }
    }

    /// Re-anchor the playing transport at the current position after `change`.
    fn rebase(&mut self, change: impl FnOnce(&mut Transport)) {
        let Some((t, anchor)) = self.transport.as_mut() else {
            return;
        };
        let now = Instant::now();
        let beat = Self::timeline_beat(t, *anchor, now).max(t.anchor_beat);
        let position = t.song_beat(beat);
        *anchor = now.max(*anchor);
        t.rebase(position, change);
        if t.plan.total <= 0.0 {
            self.finish();
        }
    }

    /// Returns false on Quit.
    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Play {
                plan,
                from,
                looping,
                range,
            } => {
                if self.transport.is_some() {
                    self.finish();
                }
                self.shared.late.reset();
                if plan.total <= 0.0 {
                    self.shared.playing.store(false, Ordering::Relaxed);
                    return true;
                }
                let t = Transport::new(plan, looping, range, from);
                self.transport = Some((t, Instant::now()));
                self.shared.playing.store(true, Ordering::Relaxed);
            }
            Command::Update(plan) => {
                let Some((t, _)) = &self.transport else {
                    return true;
                };
                // Channels that no longer play (track muted, removed or moved): cut them now.
                let gone: Vec<u8> = t
                    .plan
                    .channels
                    .iter()
                    .copied()
                    .filter(|c| !plan.channels.contains(c))
                    .collect();
                for ch in gone {
                    self.channel_off(ch);
                }
                self.rebase(|t| t.plan = plan);
            }
            Command::SetLoop { looping, range } => self.rebase(|t| {
                t.looping = looping;
                t.range = range;
            }),
            Command::Stop => {
                if self.transport.is_some() {
                    self.finish();
                } else {
                    self.release_all(&[]);
                    self.shared.playing.store(false, Ordering::Relaxed);
                }
            }
            Command::Audition(notes) => {
                if self.transport.is_none() {
                    let off = Instant::now() + AUDITION;
                    for [status, note, velocity] in notes {
                        let ch = status & 0x0f;
                        self.note_on(ch, note, velocity, Duration::ZERO);
                        self.offs.push(Reverse((off, ch, note)));
                    }
                }
            }
            Command::Quit => {
                if self.transport.is_some() {
                    self.finish();
                } else {
                    self.release_all(&[]);
                }
                return false;
            }
        }
        true
    }

    /// Silence one channel now: its sounding notes and pending note-offs, then CC 123.
    fn channel_off(&mut self, ch: u8) {
        let ch = ch & 0x0f;
        for note in 0..128u8 {
            if self.held[usize::from(ch)][usize::from(note)] > 0 {
                self.sink.send(&[NOTE_OFF | ch, note, 0]);
            }
        }
        self.held[usize::from(ch)] = [0; 128];
        self.offs.retain(|Reverse((_, c, _))| *c != ch);
        self.sink.send(&[CONTROL_CHANGE | ch, ALL_NOTES_OFF, 0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use croky_core::{create_song, SongChord};

    fn song(tokens: &[(&str, f64)], tempo: f64) -> Song {
        Song {
            tempo,
            chords: tokens
                .iter()
                .map(|(t, b)| SongChord {
                    token: (*t).into(),
                    beats: *b,
                })
                .collect(),
            ..create_song()
        }
    }

    #[test]
    fn plans_the_band_like_the_web_scheduler() {
        let s = song(&[("I", 4.0), ("rest", 2.0), ("V", 2.0)], 120.0);
        let plan = plan_song(&s);
        assert_eq!(plan.total, 8.0);
        assert_eq!(plan.seconds_per_beat, 0.5);
        // Default band: chords (ch 1), bass (ch 2), arp (ch 3, muted); the melody on ch 4.
        assert_eq!(plan.channels, vec![0, 1, 2, 3]);
        assert!(plan.events.iter().all(|e| e.channel <= 1));
        assert!(plan.events.windows(2).all(|w| w[0].start <= w[1].start));
        // Nothing starts during the rest (beats 4-6).
        assert!(!plan.events.iter().any(|e| e.start >= 4.0 && e.start < 6.0));
        // Bass quarters: 4 + 2 notes.
        assert_eq!(plan.events.iter().filter(|e| e.channel == 1).count(), 6);
    }

    fn steps(t: &mut Transport, n: usize) -> Vec<(f64, Step)> {
        (0..n)
            .map(|_| {
                let s = t.peek();
                t.advance(s.1);
                s
            })
            .collect()
    }

    #[test]
    fn walks_a_loop_range_without_a_gap() {
        let plan = plan_song(&song(&[("I", 4.0), ("V", 4.0), ("vi", 4.0)], 120.0));
        let range = Some(LoopRange {
            start: 4.0,
            end: 8.0,
        });
        // Play from the start: pass 0 runs from 0 to the loop end, then the range repeats.
        let mut t = Transport::new(plan, true, range, 0.0);
        let all = steps(&mut t, 40);
        let wraps: Vec<f64> = all
            .iter()
            .filter(|(_, s)| *s == Step::Wrap)
            .map(|(b, _)| *b)
            .collect();
        assert_eq!(&wraps[..3], &[8.0, 12.0, 16.0]);
        // After the first wrap the notes of chord V (beats 4..8) play again at 8.., 12..
        let after: Vec<f64> = all
            .iter()
            .skip_while(|(_, s)| *s != Step::Wrap)
            .filter_map(|(b, s)| matches!(s, Step::Note(_)).then_some(*b))
            .collect();
        assert_eq!(after.first(), Some(&8.0));
        assert_eq!(t.song_beat(13.0), 5.0);
        // While looping a note is cut at the loop end.
        let last = t.plan.events.iter().rposition(|e| e.start < 8.0).unwrap();
        assert!(t.plan.events[last].start + t.duration(last) <= 8.0 + 1e-9);
    }

    #[test]
    fn ends_a_song_that_does_not_loop_and_rebases() {
        let plan = plan_song(&song(&[("I", 2.0), ("V", 2.0)], 120.0));
        let mut t = Transport::new(plan, false, None, 0.0);
        let all = steps(&mut t, 200);
        assert!(all.iter().any(|(b, s)| *s == Step::End && *b == 4.0));
        assert!(!all.iter().any(|(_, s)| *s == Step::Wrap));
        // Starting past the end starts over.
        let mut t = Transport::new(t.plan.clone(), false, None, 10.0);
        assert_eq!(t.anchor_beat, 0.0);
        // A loop range that ends before the position: jump to its start.
        t.rebase(3.0, |t| {
            t.looping = true;
            t.range = Some(LoopRange {
                start: 0.0,
                end: 2.0,
            });
        });
        assert_eq!(t.anchor_beat, 0.0);
        t.rebase(1.0, |t| t.looping = false);
        assert_eq!(t.anchor_beat, 1.0);
        assert!(t.peek().0 >= 1.0);
    }

    type Log = Arc<Mutex<Vec<(Instant, Vec<u8>)>>>;

    #[derive(Clone, Default)]
    struct Recorder(Log);

    impl Sink for Recorder {
        fn send(&mut self, message: &[u8]) {
            self.0
                .lock()
                .unwrap()
                .push((Instant::now(), message.to_vec()));
        }
    }

    #[test]
    fn the_scheduler_thread_plays_loops_and_releases() {
        let rec = Recorder::default();
        let player = Player::new(rec.clone(), "test".into(), 0);
        // 1000 BPM: a beat is 60 ms; loop beats 0-2 (120 ms) of a 4-beat song.
        let s = song(&[("I", 2.0), ("V", 2.0)], 1000.0);
        let range = Some(LoopRange {
            start: 0.0,
            end: 2.0,
        });
        player.play(&s, 0.0, true, range);
        thread::sleep(Duration::from_millis(330));
        assert!(player.is_playing());
        assert!(player.position().is_some_and(|p| p < 2.0));
        player.stop();
        thread::sleep(Duration::from_millis(30));
        assert!(!player.is_playing());
        let msgs = rec.0.lock().unwrap().clone();
        let ons: Vec<_> = msgs
            .iter()
            .filter(|(_, m)| m[0] & 0xf0 == NOTE_ON)
            .collect();
        let all_off = msgs
            .iter()
            .filter(|(_, m)| m[0] & 0xf0 == CONTROL_CHANGE && m[1] == ALL_NOTES_OFF)
            .count();
        assert!(ons.len() >= 8, "several passes of chord I: {}", ons.len());
        assert!(all_off >= 2, "All Notes Off at every wrap: {all_off}");
        // Only chord I (C E G) plays inside the loop.
        assert!(ons.iter().all(|(_, m)| [0, 4, 7].contains(&(m[1] % 12))));
        // Nothing is left held: the last message for every note is a note-off.
        let mut last = std::collections::HashMap::new();
        for (_, m) in &msgs {
            if matches!(m[0] & 0xf0, NOTE_ON | NOTE_OFF) {
                last.insert((m[0] & 0x0f, m[1]), m[0] & 0xf0);
            }
        }
        assert!(last.values().all(|s| *s == NOTE_OFF), "{last:?}");
        let end = &msgs.last().unwrap().1;
        assert_eq!((end[0] & 0xf0, end[1]), (CONTROL_CHANGE, ALL_SOUND_OFF));
        assert!(player.shared.late.summary().0 > 0);
    }

    #[test]
    fn auditions_only_while_stopped() {
        let rec = Recorder::default();
        let player = Player::new(rec.clone(), "test".into(), 0);
        let s = song(&[("I", 4.0)], 120.0);
        player.audition(&s, "V", 0);
        thread::sleep(AUDITION + Duration::from_millis(100));
        let msgs = rec.0.lock().unwrap().clone();
        let ons = msgs.iter().filter(|(_, m)| m[0] == NOTE_ON).count();
        let offs = msgs.iter().filter(|(_, m)| m[0] == NOTE_OFF).count();
        assert_eq!((ons, offs), (4, 4), "{msgs:?}");
        assert!(msgs[ons].0 - msgs[0].0 >= AUDITION);
    }

    #[test]
    fn late_stats_report_p99() {
        let s = LateStats::default();
        for _ in 0..99 {
            s.record(Duration::from_micros(5));
        }
        s.record(Duration::from_micros(900));
        assert_eq!(s.summary(), (100, 10, 900));
        s.record(Duration::from_micros(15));
        assert_eq!(s.summary().1, 20);
    }
}
