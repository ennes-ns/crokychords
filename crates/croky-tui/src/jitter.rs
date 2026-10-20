//! `--jitter-test`: play a dense song through the real scheduler thread into the program's own
//! virtual ALSA input (nothing else is connected, so no sound is made) and compare when each
//! note-on arrives with when it should: the k-th note-on should arrive `(beat_k - beat_0) * spb`
//! after the first one. Reports the error distribution; acceptance is p99 below 0.5 ms
//! (issue #66).

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use croky_core::{create_song, pattern_preset, Song, SongChord, TrackRole};
use midir::{MidiInput, MidiOutput};

use crate::latency::Stats;
use crate::player::{plan_song, Player, Step, Transport};

/// A song that keeps the scheduler busy: the default band with the arp on and playing 16ths
/// (with bass quarters and sustained chords about 6.5 note-ons per beat), at 300 BPM.
pub fn test_song() -> Song {
    let mut song = Song {
        title: "Jitter".into(),
        tempo: 300.0,
        chords: ["I", "V", "vi", "IV"]
            .iter()
            .map(|t| SongChord {
                token: (*t).into(),
                beats: 2.0,
            })
            .collect(),
        ..create_song()
    };
    for t in song.tracks.iter_mut().flatten() {
        t.muted = false;
        if t.role == TrackRole::Arp {
            t.pattern = pattern_preset("arp-up-16").expect("built-in preset");
        }
    }
    song
}

/// Expected song-relative times (seconds) and notes of the first `n` note-ons when `song`
/// loops from beat 0.
fn expected(song: &Song, n: usize) -> Vec<(f64, u8)> {
    let plan = plan_song(song);
    let spb = plan.seconds_per_beat;
    let mut t = Transport::new(plan, true, None, 0.0);
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let (beat, step) = t.peek();
        if let Step::Note(i) = step {
            out.push((beat * spb, (t.plan.events[i].note & 0x7f) as u8));
        }
        t.advance(step);
    }
    out
}

pub struct Report {
    pub errors: Stats,
    pub mismatched: usize,
    pub sched: String,
}

impl Report {
    pub fn text(&self) -> String {
        let e = &self.errors;
        format!(
            "path: scheduler -> ALSA sequencer loopback (croky-jitter)\n\
             note-ons: {}, wrong note: {}\n\
             timing error: median {:.3} ms  mean {:.3} ms  p99 {:.3} ms  max {:.3} ms\n\
             scheduler thread: {}",
            e.samples.len(),
            self.mismatched,
            e.percentile(50.0),
            e.mean(),
            e.percentile(99.0),
            e.percentile(100.0),
            self.sched
        )
    }
}

/// Play `test_song` for `seconds` through the loopback and measure. `Err` when the ALSA
/// sequencer is not available.
pub fn run(seconds: f64, priority: i32) -> Result<Report, String> {
    // The ALSA sequencer timestamps each event when it reaches our input port (µs), so a slow
    // wake-up of the receiving thread does not count as scheduler jitter.
    let (tx, rx) = mpsc::channel::<(u64, u8)>();
    let input = MidiInput::new("croky-jitter").map_err(|e| e.to_string())?;
    let output = MidiOutput::new("croky-jitter").map_err(|e| e.to_string())?;
    let _in_conn = {
        use midir::os::unix::VirtualInput;
        input
            .create_virtual(
                "in",
                move |stamp_us, msg: &[u8], _: &mut ()| {
                    if msg.len() == 3 && msg[0] & 0xf0 == 0x90 && msg[2] > 0 {
                        let _ = tx.send((stamp_us, msg[1]));
                    }
                },
                (),
            )
            .map_err(|e| e.to_string())?
    };
    thread::sleep(Duration::from_millis(50));
    let port = output
        .ports()
        .into_iter()
        .find(|p| {
            output
                .port_name(p)
                .unwrap_or_default()
                .contains("croky-jitter:in")
        })
        .ok_or("own virtual input port not found")?;
    let conn = output.connect(&port, "out").map_err(|e| e.to_string())?;
    let song = test_song();
    let player = Player::new(conn, "croky-jitter:in".into(), priority);
    player.play(&song, 0.0, true, None);
    thread::sleep(Duration::from_secs_f64(seconds));
    let sched = player.sched();
    drop(player); // stops and joins the scheduler thread
    thread::sleep(Duration::from_millis(20));

    let arrivals: Vec<(u64, u8)> = rx.try_iter().collect();
    let want = expected(&song, arrivals.len());
    let mut errors = Stats {
        samples: Vec::with_capacity(arrivals.len()),
        lost: 0,
    };
    let mut mismatched = 0;
    if let (Some((t0, _)), Some((e0, _))) = (arrivals.first(), want.first()) {
        for ((at, note), (secs, want_note)) in arrivals.iter().zip(&want) {
            if note != want_note {
                mismatched += 1;
            }
            let actual = at.saturating_sub(*t0) as f64 / 1e6;
            errors.samples.push(((actual - (secs - e0)) * 1000.0).abs());
        }
    }
    Ok(Report {
        errors,
        mismatched,
        sched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_song_is_dense() {
        let want = expected(&test_song(), 200);
        assert_eq!(want.len(), 200);
        assert!(want.windows(2).all(|w| w[0].0 <= w[1].0));
        // 200 note-ons within a few seconds.
        assert!(want[199].0 < 7.0, "{}", want[199].0);
    }

    /// Acceptance criterion of issue #66: p99 timing error under 0.5 ms through the ALSA
    /// sequencer loopback, with the default real-time priority (normal scheduling where the
    /// system refuses it). Skipped (passes) where there is no sequencer, e.g. in CI.
    #[test]
    fn loopback_jitter_p99_is_under_half_a_millisecond() {
        let report = match run(3.0, crate::config::DEFAULT_PRIORITY) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("skipped: no ALSA sequencer ({e})");
                return;
            }
        };
        eprintln!("{}", report.text());
        assert!(report.errors.samples.len() > 60);
        assert_eq!(report.mismatched, 0);
        let p99 = report.errors.percentile(99.0);
        assert!(p99 < 0.5, "p99 {p99:.3} ms");
    }
}
