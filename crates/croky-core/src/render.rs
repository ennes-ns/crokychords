//! Song to note events (port of `render.ts`, `docs/specs/tracks-v1.md` §A3 and
//! `docs/specs/melody-v1.md` §A1): pattern layout per chord, track and song rendering, the
//! melody lane and how a melody note relates to the chord under it.

use crate::chords::{chord_pitch_classes, chord_root_pitch_class, voice_chord};
use crate::json::js_round;
use crate::melody::{melody_note_pitch, MelodyNote, MELODY_GATE, MELODY_TRACK_ID, MELODY_VELOCITY};
use crate::song::Song;
use crate::theory::{midi_note, to_pitch_class, Key};
use crate::token::{is_rest_token, parse_token, Chord};
use crate::tracks::{NoteSelector, Pattern, PatternStep, PatternTail, Track, TrackVoicing};

#[derive(Clone, Debug, PartialEq)]
pub struct NoteEvent {
    pub track_id: String,
    /// MIDI channel 0-15.
    pub channel: i32,
    /// 0-127.
    pub note: i32,
    /// 1-127.
    pub velocity: i32,
    /// Beats from song start.
    pub start: f64,
    /// Beats, > 0.
    pub duration: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderOptions {
    /// Render muted tracks too, default false.
    pub include_muted: bool,
}

/// One placed step of a pattern inside a chord.
#[derive(Clone, Debug, PartialEq)]
pub struct StepOccurrence<'a> {
    /// Beat offset from the chord start, 0 <= at < chord beats.
    pub at: f64,
    /// Length in beats before the gate, at + length <= chord beats.
    pub length: f64,
    pub step: &'a PatternStep,
    /// Index of `step` in `pattern.steps`.
    pub step_index: usize,
}

/// `layoutPattern`: where the steps of `pattern` fall inside a chord of `beats` beats. The
/// pattern restarts at the chord start and loops while it fits; steps starting at or after the
/// chord end are dropped and steps crossing it are cut to the boundary. With `tail: sustain`,
/// the step(s) starting last are extended to the chord end, and a step at least as long as the
/// pattern is played once and held to the chord end. Sorted by `at`, then step order.
pub fn layout_pattern(pattern: &Pattern, beats: f64) -> Vec<StepOccurrence<'_>> {
    let mut out: Vec<StepOccurrence<'_>> = Vec::new();
    // NaN counts as not positive, as `!(x > 0)` in TS.
    if pattern.length.is_nan() || pattern.length <= 0.0 || beats.is_nan() || beats <= 0.0 {
        return out;
    }
    let sustain = pattern.tail == Some(PatternTail::Sustain);
    let mut k = 0.0;
    while k * pattern.length < beats {
        for (step_index, step) in pattern.steps.iter().enumerate() {
            let at = k * pattern.length + step.at;
            if at >= beats {
                continue;
            }
            let held = sustain && step.length >= pattern.length;
            if held && k > 0.0 {
                continue; // tied to the previous repetition
            }
            let length = if held {
                beats - at
            } else {
                step.length.min(beats - at)
            };
            out.push(StepOccurrence {
                at,
                length,
                step,
                step_index,
            });
        }
        k += 1.0;
    }
    // Stable, like Array.prototype.sort.
    out.sort_by(|a, b| a.at.total_cmp(&b.at));
    if sustain {
        if let Some(last) = out.iter().map(|o| o.at).reduce(f64::max) {
            for o in out.iter_mut().filter(|o| o.at == last) {
                o.length = beats - o.at;
            }
        }
    }
    out
}

struct Voicing {
    /// Bass note first, then the upper tones (close), or just the root (root-only).
    notes: Vec<i64>,
    upper: Vec<i64>,
}

fn voice(chord: &Chord, key: Key, track: &Track) -> Voicing {
    if track.voicing == TrackVoicing::RootOnly {
        let root = i64::from(midi_note(chord_root_pitch_class(chord, key), track.octave));
        return Voicing {
            notes: vec![root],
            upper: vec![root],
        };
    }
    let notes: Vec<i64> = voice_chord(chord, key, track.octave, track.octave)
        .into_iter()
        .map(i64::from)
        .collect();
    let upper = notes[1..].to_vec();
    Voicing { notes, upper }
}

/// Untransposed MIDI notes a selector picks from the voicing.
fn resolve_selector(
    selector: NoteSelector,
    voicing: &Voicing,
    chord: &Chord,
    key: Key,
    octave: i32,
) -> Vec<i64> {
    let Some(&bass) = voicing.notes.first() else {
        return Vec::new();
    };
    let root = || i64::from(midi_note(chord_root_pitch_class(chord, key), octave));
    match selector {
        NoteSelector::Index(index) => {
            let n = voicing.upper.len() as u64;
            if n == 0 {
                return Vec::new();
            }
            let tone = voicing.upper[(index % n) as usize];
            let octaves = i64::try_from(index / n).unwrap_or(i64::MAX);
            vec![tone.saturating_add(octaves.saturating_mul(12))]
        }
        NoteSelector::Chord => voicing.upper.clone(),
        NoteSelector::Bass => vec![bass],
        NoteSelector::Root => vec![root()],
        NoteSelector::Fifth => {
            let fifth_pc = to_pitch_class((bass + 7) as i32);
            if chord_pitch_classes(chord, key).contains(&fifth_pc) {
                vec![bass + 7]
            } else {
                vec![root()]
            }
        }
        NoteSelector::Top => voicing.notes.last().map_or_else(Vec::new, |&t| vec![t]),
    }
}

/// Sort by start, then channel, then note (stable otherwise).
fn sort_events(events: &mut [NoteEvent]) {
    events.sort_by(|a, b| {
        a.start
            .total_cmp(&b.start)
            .then(a.channel.cmp(&b.channel))
            .then(a.note.cmp(&b.note))
    });
}

/// `renderTrack`: note events of one track over the whole song (rests produce nothing). Muted
/// tracks render nothing unless `include_muted`. Notes moved outside 0..127 by octave or
/// transpose are skipped. Sorted by start, then note.
pub fn render_track(song: &Song, track: &Track, opts: RenderOptions) -> Vec<NoteEvent> {
    if track.muted && !opts.include_muted {
        return Vec::new();
    }
    let key = song.key();
    let mut events = Vec::new();
    let mut start = 0.0;
    for song_chord in &song.chords {
        let chord_start = start;
        start += song_chord.beats;
        if is_rest_token(&song_chord.token) {
            continue;
        }
        // Only a hand-built song can hold a token that does not parse; it renders nothing.
        let Ok(chord) = parse_token(&song_chord.token) else {
            continue;
        };
        let voicing = voice(&chord, key, track);
        for o in layout_pattern(&track.pattern, song_chord.beats) {
            let scaled = js_round(f64::from(track.velocity) * o.step.accent.unwrap_or(1.0));
            let velocity = scaled.clamp(1.0, 127.0) as i32;
            for raw in resolve_selector(o.step.notes, &voicing, &chord, key, track.octave) {
                let note = raw.saturating_add(i64::from(track.transpose));
                if !(0..=127).contains(&note) {
                    continue;
                }
                events.push(NoteEvent {
                    track_id: track.id.clone(),
                    channel: track.channel,
                    note: note as i32,
                    velocity,
                    start: chord_start + o.at,
                    duration: o.length * track.gate,
                });
            }
        }
    }
    sort_events(&mut events);
    events
}

/// `renderSong`: note events of all tracks, sorted by start, then channel, then note.
pub fn render_song(song: &Song, tracks: &[Track], opts: RenderOptions) -> Vec<NoteEvent> {
    let mut events: Vec<NoteEvent> = tracks
        .iter()
        .flat_map(|t| render_track(song, t, opts))
        .collect();
    sort_events(&mut events);
    events
}

/// How a melody note relates to the chord sounding at its start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MelodyHarmony {
    /// Its pitch class is a chord tone.
    Chord,
    /// Not a chord tone, but in the scale (no accidental).
    Scale,
    /// Neither.
    Outside,
}

impl MelodyHarmony {
    pub fn name(self) -> &'static str {
        match self {
            MelodyHarmony::Chord => "chord",
            MelodyHarmony::Scale => "scale",
            MelodyHarmony::Outside => "outside",
        }
    }
}

/// `melodyNoteHarmony`. Rests and beats after the last chord have no chord tones.
pub fn melody_note_harmony(song: &Song, note: &MelodyNote) -> MelodyHarmony {
    let key = song.key();
    if let Some(at) = song.chord_at_beat(note.beat) {
        if !is_rest_token(&at.chord.token) {
            if let Ok(chord) = parse_token(&at.chord.token) {
                let pc = to_pitch_class(melody_note_pitch(note, key));
                if chord_pitch_classes(&chord, key).contains(&pc) {
                    return MelodyHarmony::Chord;
                }
            }
        }
    }
    if note.accidental == 0 {
        MelodyHarmony::Scale
    } else {
        MelodyHarmony::Outside
    }
}

/// `renderMelody`: note events of the melody (track id `MELODY_TRACK_ID`, the melody channel,
/// `MELODY_VELOCITY`, `length * MELODY_GATE`). A muted melody renders nothing unless
/// `include_muted`. Notes starting at or after the end of the chords are dropped and a note
/// crossing it is cut. Sorted by start.
pub fn render_melody(song: &Song, opts: RenderOptions) -> Vec<NoteEvent> {
    let Some(melody) = &song.melody else {
        return Vec::new();
    };
    if melody.muted && !opts.include_muted {
        return Vec::new();
    }
    let key = song.key();
    let end = song.total_beats();
    let mut events = Vec::new();
    for note in &melody.notes {
        if note.beat >= end {
            continue;
        }
        let pitch = melody_note_pitch(note, key);
        if !(0..=127).contains(&pitch) {
            continue;
        }
        events.push(NoteEvent {
            track_id: MELODY_TRACK_ID.into(),
            channel: melody.channel,
            note: pitch,
            velocity: MELODY_VELOCITY,
            start: note.beat,
            duration: ((note.beat + note.length).min(end) - note.beat) * MELODY_GATE,
        });
    }
    sort_events(&mut events);
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patterns::pattern_preset;

    #[test]
    fn sustain_holds_one_note_over_a_long_chord() {
        let p = pattern_preset("sustain").unwrap();
        let out = layout_pattern(&p, 6.0);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].at, out[0].length), (0.0, 6.0));
        let q = pattern_preset("quarters").unwrap();
        let out = layout_pattern(&q, 2.0);
        assert_eq!(out.iter().map(|o| o.at).collect::<Vec<_>>(), vec![0.0, 1.0]);
        assert!(layout_pattern(&q, 0.0).is_empty());
    }
}
