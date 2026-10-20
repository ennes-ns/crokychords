//! Modes, scales, pitch classes and key signatures (port of `packages/core/src/theory.ts`).

use serde::Deserialize;

/// Pitch class, C = 0 ... B = 11.
pub type PitchClass = u8;

/// The nine modes of the token format. Serialised with the TS names (`harmonicMinor`, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Major,
    Minor,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Locrian,
    HarmonicMinor,
    PhrygianDominant,
}

impl Mode {
    pub const ALL: [Mode; 9] = [
        Mode::Major,
        Mode::Minor,
        Mode::Dorian,
        Mode::Phrygian,
        Mode::Lydian,
        Mode::Mixolydian,
        Mode::Locrian,
        Mode::HarmonicMinor,
        Mode::PhrygianDominant,
    ];

    /// The TS / JSON name, e.g. `harmonicMinor`.
    pub fn name(self) -> &'static str {
        match self {
            Mode::Major => "major",
            Mode::Minor => "minor",
            Mode::Dorian => "dorian",
            Mode::Phrygian => "phrygian",
            Mode::Lydian => "lydian",
            Mode::Mixolydian => "mixolydian",
            Mode::Locrian => "locrian",
            Mode::HarmonicMinor => "harmonicMinor",
            Mode::PhrygianDominant => "phrygianDominant",
        }
    }

    pub fn from_name(name: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.name() == name)
    }

    /// Semitones from the tonic for scale degrees 1-7.
    pub fn scale(self) -> [i32; 7] {
        match self {
            Mode::Major => [0, 2, 4, 5, 7, 9, 11],
            Mode::Dorian => [0, 2, 3, 5, 7, 9, 10],
            Mode::Phrygian => [0, 1, 3, 5, 7, 8, 10],
            Mode::Lydian => [0, 2, 4, 6, 7, 9, 11],
            Mode::Mixolydian => [0, 2, 4, 5, 7, 9, 10],
            Mode::Minor => [0, 2, 3, 5, 7, 8, 10],
            Mode::Locrian => [0, 1, 3, 5, 6, 8, 10],
            Mode::HarmonicMinor => [0, 2, 3, 5, 7, 8, 11],
            Mode::PhrygianDominant => [0, 1, 4, 5, 7, 8, 10],
        }
    }

    /// Semitones from the tonic of the mode to the tonic of its parent major scale.
    fn parent_major_offset(self) -> i32 {
        match self {
            Mode::Major => 0,
            Mode::Dorian => 10,
            Mode::Phrygian => 8,
            Mode::Lydian => 7,
            Mode::Mixolydian => 5,
            Mode::Minor => 3,
            Mode::Locrian => 1,
            Mode::HarmonicMinor => 3,
            Mode::PhrygianDominant => 8,
        }
    }

    /// Which degree of its parent major scale the mode starts on (0-based).
    pub(crate) fn rotation(self) -> usize {
        match self {
            Mode::Major => 0,
            Mode::Dorian => 1,
            Mode::Phrygian => 2,
            Mode::Lydian => 3,
            Mode::Mixolydian => 4,
            Mode::Minor => 5,
            Mode::Locrian => 6,
            Mode::HarmonicMinor => 5,
            Mode::PhrygianDominant => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub tonic: PitchClass,
    pub mode: Mode,
}

/// Reduce any integer to its pitch class (mod 12, always non-negative).
pub fn to_pitch_class(n: i32) -> PitchClass {
    n.rem_euclid(12) as PitchClass
}

/// Semitones from the tonic of `degree` (1-7) in `mode`. Panics on another degree (TS throws a
/// `RangeError`).
pub fn degree_pitch(mode: Mode, degree: u8) -> i32 {
    mode.scale()[usize::from(degree - 1)]
}

/// Pitch class of a scale degree in a key, raised or lowered by `accidental` semitones.
pub fn pitch_class_of(key: Key, degree: u8, accidental: i32) -> PitchClass {
    to_pitch_class(i32::from(key.tonic) + degree_pitch(key.mode, degree) + accidental)
}

const SHARP_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const FLAT_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];

pub fn note_name(pc: PitchClass, prefer_flats: bool) -> &'static str {
    let names = if prefer_flats {
        &FLAT_NAMES
    } else {
        &SHARP_NAMES
    };
    names[usize::from(pc % 12)]
}

/// Key signature of major keys by tonic pitch class: sharps > 0, flats < 0.
const MAJOR_SIGNATURE: [i32; 12] = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5];

/// Sharps (> 0) or flats (< 0) of the closest conventional key signature.
pub fn key_signature(key: Key) -> i32 {
    let parent = to_pitch_class(i32::from(key.tonic) + key.mode.parent_major_offset());
    MAJOR_SIGNATURE[usize::from(parent)]
}

pub fn key_prefers_flats(key: Key) -> bool {
    key_signature(key) < 0
}

/// Parse 'C', 'C#', 'Db', 'F##', 'Bbb' into a pitch class.
pub fn parse_note_name(name: &str) -> Option<PitchClass> {
    let mut chars = name.chars();
    let base = match chars.next()? {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let shift = match chars.as_str() {
        "" => 0,
        "#" => 1,
        "##" => 2,
        "b" => -1,
        "bb" => -2,
        _ => return None,
    };
    Some(to_pitch_class(base + shift))
}

/// MIDI note number with C4 = 60.
pub fn midi_note(pc: PitchClass, octave: i32) -> i32 {
    (octave + 1) * 12 + i32::from(pc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_round_trip() {
        assert_eq!(parse_note_name("Bb"), Some(10));
        assert_eq!(parse_note_name("B#"), Some(0));
        assert_eq!(parse_note_name("H"), None);
        assert_eq!(note_name(10, true), "Bb");
        assert_eq!(midi_note(0, 4), 60);
    }

    #[test]
    fn signatures() {
        let f = Key {
            tonic: 5,
            mode: Mode::Major,
        };
        assert_eq!(key_signature(f), -1);
        let e_minor = Key {
            tonic: 4,
            mode: Mode::Minor,
        };
        assert_eq!(key_signature(e_minor), 1);
    }
}
