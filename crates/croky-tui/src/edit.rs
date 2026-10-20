//! Pure song edits and loop-range helpers, ported from the web app (`apps/web/src/edit.ts`,
//! `apps/web/src/loop.ts`) so the terminal edits exactly like the browser: replace-first picks,
//! the "+" slot after the last chord (`None`), resize on the quarter-beat grid, and loop points
//! in beats (`docs/specs/web-v1.md` §3, `docs/specs/loop-v1.md`).

use croky_core::{Song, SongChord};

/// Smallest chord length and resize step: a quarter beat (the song model's grid).
pub const MIN_BEATS: f64 = 0.25;
/// Default length of the first chord of a song, in beats (clipped to the end of the bar).
pub const DEFAULT_INSERT_BEATS: f64 = 4.0;
/// Tempo range the editor offers (the song model allows more).
pub const TEMPO_MIN: f64 = 20.0;
pub const TEMPO_MAX: f64 = 300.0;
/// Tonic choices (one spelling per pitch class), as the web key picker.
pub const TONICS: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];
const EPSILON: f64 = 1e-9;

/// Length of one bar in beats (quarter notes): 4/4 → 4, 3/4 → 3, 6/8 → 3.
pub fn bar_length(song: &Song) -> f64 {
    f64::from(song.meter.beats) * 4.0 / f64::from(song.meter.unit)
}

/// Start beat of chord `index`; the song length for the "+" slot or past the end.
pub fn chord_start(song: &Song, index: usize) -> f64 {
    song.chords.iter().take(index).map(|c| c.beats).sum()
}

/// Round to the quarter-beat grid (avoids float drift).
pub fn quantize(beats: f64) -> f64 {
    (beats / MIN_BEATS).round() * MIN_BEATS
}

/// Length for a chord inserted at `position`: `preferred`, or the rest of the bar if shorter.
pub fn insert_length(song: &Song, position: f64, preferred: f64) -> f64 {
    let bar = bar_length(song);
    let offset = quantize(position % bar);
    let remaining = if offset >= bar { bar } else { bar - offset };
    MIN_BEATS.max(quantize(preferred.min(remaining)))
}

/// Insert after the selected chord, or append on the "+" slot (`None`). The new chord takes the
/// length of the chord before it; the first chord of a song gets `insert_length`. Returns the
/// index of the new chord.
pub fn insert_after(song: &mut Song, selected: Option<usize>, token: &str) -> usize {
    let len = song.chords.len();
    let at = selected.map_or(len, |s| (s + 1).min(len));
    let beats = match at.checked_sub(1).and_then(|i| song.chords.get(i)) {
        Some(prev) => prev.beats,
        None => insert_length(song, chord_start(song, at), DEFAULT_INSERT_BEATS),
    };
    song.chords.insert(
        at,
        SongChord {
            token: token.into(),
            beats,
        },
    );
    at
}

/// Remove chord `index`; returns the new selection (the previous chord, or the "+" slot when
/// the song is empty).
pub fn remove_chord(song: &mut Song, index: usize) -> Option<usize> {
    if index >= song.chords.len() {
        return None;
    }
    song.chords.remove(index);
    if song.chords.is_empty() {
        None
    } else {
        Some(index.saturating_sub(1))
    }
}

/// Change chord `index`'s length by `delta` beats, never below `MIN_BEATS`. False when nothing
/// changed.
pub fn resize_chord(song: &mut Song, index: usize, delta: f64) -> bool {
    let Some(chord) = song.chords.get_mut(index) else {
        return false;
    };
    let next = MIN_BEATS.max(quantize(chord.beats + delta));
    if next == chord.beats {
        return false;
    }
    chord.beats = next;
    true
}

/// Move the selection by `delta` slots: the chords plus the "+" slot after the last one.
pub fn move_selection(selected: Option<usize>, delta: i64, count: usize) -> Option<usize> {
    let slot = selected.map_or(count, |s| s.min(count)) as i64;
    let next = (slot + delta).clamp(0, count as i64) as usize;
    (next < count).then_some(next)
}

/// Clamp a selection after the song changed (undo, redo, load).
pub fn clamp_selection(selected: Option<usize>, count: usize) -> Option<usize> {
    match selected {
        Some(s) if count > 0 => Some(s.min(count - 1)),
        _ => None,
    }
}

/// A loop range in beats: `start` inclusive, `end` exclusive, `0 <= start < end`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopRange {
    pub start: f64,
    pub end: f64,
}

/// The part of the song that loops: `range` clipped to the song, or the whole song when there
/// is no range or nothing of it is left inside the song.
pub fn loop_bounds(range: Option<LoopRange>, total: f64) -> LoopRange {
    if let Some(r) = range {
        let start = r.start.max(0.0);
        let end = r.end.min(total);
        if end - start > EPSILON {
            return LoopRange { start, end };
        }
    }
    LoopRange {
        start: 0.0,
        end: total,
    }
}

/// Where Play starts: the loop start when looping (a range or the whole song), else beat 0.
pub fn play_start(looping: bool, range: Option<LoopRange>, total: f64) -> f64 {
    if looping {
        loop_bounds(range, total).start
    } else {
        0.0
    }
}

/// The loop starts at `beat`; the end stays when it is after `beat`, else it becomes the song end.
pub fn with_loop_start(range: Option<LoopRange>, beat: f64, total: f64) -> LoopRange {
    let end = match range {
        Some(r) if r.end > beat + EPSILON => r.end,
        _ => total.max(beat + 1.0),
    };
    LoopRange { start: beat, end }
}

/// The loop ends at `beat`; the start stays when it is before `beat`, else it is 0.
pub fn with_loop_end(range: Option<LoopRange>, beat: f64) -> LoopRange {
    let start = match range {
        Some(r) if r.start < beat - EPSILON => r.start,
        _ => 0.0,
    };
    LoopRange { start, end: beat }
}

/// Short text for a range: `bars 2–3` on bar boundaries, else `bar.beat` positions.
pub fn loop_label(range: LoopRange, bar: f64) -> String {
    let aligned = |beat: f64| (beat / bar - (beat / bar).round()).abs() < EPSILON;
    if aligned(range.start) && aligned(range.end) {
        let first = (range.start / bar).round() as i64 + 1;
        let last = (range.end / bar).round() as i64;
        return if first == last {
            format!("bar {first}")
        } else {
            format!("bars {first}–{last}")
        };
    }
    format!(
        "{}–{}",
        position_label(range.start, bar),
        position_label(range.end, bar)
    )
}

/// `bar.beat` (1-based) of a beat position, e.g. `2.3`, or `2.2.5` off the beat grid.
pub fn position_label(beat: f64, bar: f64) -> String {
    let index = (beat / bar + EPSILON).floor();
    let in_bar = ((beat - index * bar + 1.0) * 100.0).round() / 100.0;
    format!(
        "{}.{}",
        index as i64 + 1,
        croky_core::json::js_number(in_bar)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use croky_core::create_song;

    fn song(beats: &[f64]) -> Song {
        Song {
            chords: beats
                .iter()
                .map(|&b| SongChord {
                    token: "I".into(),
                    beats: b,
                })
                .collect(),
            ..create_song()
        }
    }

    #[test]
    fn inserts_with_the_previous_length_or_the_rest_of_the_bar() {
        let mut s = song(&[]);
        assert_eq!(insert_after(&mut s, None, "I"), 0);
        assert_eq!(s.chords[0].beats, 4.0);
        let mut s = song(&[3.0]);
        assert_eq!(insert_after(&mut s, None, "V"), 1);
        assert_eq!(s.chords[1].beats, 3.0, "takes the previous chord's length");
        assert_eq!(insert_after(&mut s, Some(0), "IV"), 1);
        assert_eq!(s.tokens(), vec!["I", "IV", "V"]);
        assert_eq!(insert_length(&s, 3.0, 4.0), 1.0, "rest of the bar");
    }

    #[test]
    fn removes_resizes_and_moves() {
        let mut s = song(&[4.0, 2.0]);
        assert!(resize_chord(&mut s, 1, -0.25));
        assert_eq!(s.chords[1].beats, 1.75);
        assert!(!resize_chord(&mut s, 1, -5.0) || s.chords[1].beats == MIN_BEATS);
        assert_eq!(remove_chord(&mut s, 1), Some(0));
        assert_eq!(remove_chord(&mut s, 0), None);
        assert_eq!(
            move_selection(Some(1), 1, 2),
            None,
            "past the last chord: + slot"
        );
        assert_eq!(move_selection(None, -1, 2), Some(1));
        assert_eq!(move_selection(Some(0), -1, 2), Some(0));
        assert_eq!(clamp_selection(Some(5), 2), Some(1));
        assert_eq!(clamp_selection(Some(0), 0), None);
    }

    #[test]
    fn loop_ranges_behave_like_the_web_app() {
        let r = |start, end| LoopRange { start, end };
        assert_eq!(loop_bounds(Some(r(4.0, 20.0)), 16.0), r(4.0, 16.0));
        assert_eq!(loop_bounds(Some(r(16.0, 20.0)), 16.0), r(0.0, 16.0));
        assert_eq!(play_start(true, Some(r(4.0, 8.0)), 16.0), 4.0);
        assert_eq!(play_start(false, Some(r(4.0, 8.0)), 16.0), 0.0);
        assert_eq!(with_loop_start(None, 4.0, 16.0), r(4.0, 16.0));
        assert_eq!(with_loop_start(Some(r(0.0, 12.0)), 4.0, 16.0), r(4.0, 12.0));
        assert_eq!(with_loop_end(Some(r(4.0, 16.0)), 8.0), r(4.0, 8.0));
        assert_eq!(with_loop_end(Some(r(8.0, 16.0)), 4.0), r(0.0, 4.0));
        assert_eq!(loop_label(r(4.0, 12.0), 4.0), "bars 2–3");
        assert_eq!(loop_label(r(4.0, 8.0), 4.0), "bar 2");
        assert_eq!(loop_label(r(2.0, 8.5), 4.0), "1.3–3.1.5");
        assert_eq!(position_label(6.0, 4.0), "2.3");
    }
}
