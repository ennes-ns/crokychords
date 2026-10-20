//! The melody lane (port of `melody.ts`, `docs/specs/melody-v1.md`): one monophonic line of
//! notes written as scale degrees of the song's key, so it follows a change of key or mode.

use serde_json::{json, Map, Value};

use crate::json::num;
use crate::theory::{degree_pitch, midi_note, Key};

/// The finest melody grid in beats: a 1/16 note.
pub const MELODY_STEP: f64 = 0.25;
/// MIDI octave of degree 1 at octave 0 (C4 = 60 in C).
pub const MELODY_HOME_OCTAVE: i32 = 4;
pub const MELODY_OCTAVE_MIN: i32 = -3;
pub const MELODY_OCTAVE_MAX: i32 = 3;
/// Channel 4: the first one the default band (channels 1-3) leaves free.
pub const MELODY_DEFAULT_CHANNEL: i32 = 3;
pub const MELODY_VELOCITY: i32 = 100;
/// Fraction of each note's length that sounds, so repeated notes are re-articulated.
pub const MELODY_GATE: f64 = 0.95;
/// `track_id` of melody note events.
pub const MELODY_TRACK_ID: &str = "melody";
pub const MAX_MELODY_NOTES: usize = 4096;
/// -1 flat, 0 the degree as the mode has it, +1 sharp.
pub const MELODY_ACCIDENTALS: [i32; 3] = [-1, 0, 1];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MelodyNote {
    /// Start in beats from the song start; >= 0, a multiple of `MELODY_STEP`.
    pub beat: f64,
    /// Length in beats; > 0, a multiple of `MELODY_STEP`.
    pub length: f64,
    /// Scale degree 1..7 of the song's key.
    pub degree: u8,
    /// Octave relative to `MELODY_HOME_OCTAVE`, `MELODY_OCTAVE_MIN..=MELODY_OCTAVE_MAX`.
    pub octave: i32,
    /// One of `MELODY_ACCIDENTALS`.
    pub accidental: i32,
}

impl MelodyNote {
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("beat".into(), num(self.beat));
        obj.insert("length".into(), num(self.length));
        obj.insert("degree".into(), json!(self.degree));
        obj.insert("octave".into(), num(f64::from(self.octave)));
        obj.insert("accidental".into(), num(f64::from(self.accidental)));
        Value::Object(obj)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Melody {
    /// MIDI channel 0-15 (shown 1-16 in the UI).
    pub channel: i32,
    pub muted: bool,
    /// Sorted by beat and never overlapping.
    pub notes: Vec<MelodyNote>,
}

impl Melody {
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("channel".into(), num(f64::from(self.channel)));
        obj.insert("muted".into(), json!(self.muted));
        obj.insert(
            "notes".into(),
            Value::Array(self.notes.iter().map(MelodyNote::to_json).collect()),
        );
        Value::Object(obj)
    }
}

impl Default for Melody {
    fn default() -> Self {
        default_melody()
    }
}

pub fn default_melody() -> Melody {
    Melody {
        channel: MELODY_DEFAULT_CHANNEL,
        muted: false,
        notes: Vec::new(),
    }
}

/// MIDI note number of a melody note in `key`.
pub fn melody_note_pitch(note: &MelodyNote, key: Key) -> i32 {
    midi_note(key.tonic, MELODY_HOME_OCTAVE + note.octave)
        + degree_pitch(key.mode, note.degree)
        + note.accidental
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theory::Mode;

    #[test]
    fn pitch_follows_key_mode_and_octave() {
        let note = MelodyNote {
            beat: 0.0,
            length: 1.0,
            degree: 3,
            octave: -1,
            accidental: 1,
        };
        let d_minor = Key {
            tonic: 2,
            mode: Mode::Minor,
        };
        // D3 = 50, minor third + sharp = 4 semitones.
        assert_eq!(melody_note_pitch(&note, d_minor), 54);
    }
}
