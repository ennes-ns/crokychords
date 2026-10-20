//! The band: tracks with a rhythm pattern, octave and MIDI channel each (port of `tracks.ts`,
//! `docs/specs/tracks-v1.md` §A1).

use serde_json::{json, Map, Value};

use crate::json::num;

/// Which notes of the voiced chord a pattern step plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteSelector {
    /// All voiced chord tones (upper voicing, no separate bass note).
    Chord,
    /// The bass note only (the root for root position).
    Bass,
    /// The root only, in the track's octave (ignores the inversion).
    Root,
    /// The fifth above the bass note (fallback: the root).
    Fifth,
    /// The highest voiced tone.
    Top,
    /// The n-th upper tone from the bottom; wraps up an octave (arpeggios).
    Index(u64),
}

/// The named selectors in the TS order (`NOTE_SELECTOR_NAMES`).
pub const NOTE_SELECTOR_NAMES: [&str; 5] = ["chord", "bass", "root", "fifth", "top"];

impl NoteSelector {
    pub fn from_name(name: &str) -> Option<NoteSelector> {
        Some(match name {
            "chord" => NoteSelector::Chord,
            "bass" => NoteSelector::Bass,
            "root" => NoteSelector::Root,
            "fifth" => NoteSelector::Fifth,
            "top" => NoteSelector::Top,
            _ => return None,
        })
    }

    pub fn to_json(self) -> Value {
        match self {
            NoteSelector::Chord => json!("chord"),
            NoteSelector::Bass => json!("bass"),
            NoteSelector::Root => json!("root"),
            NoteSelector::Fifth => json!("fifth"),
            NoteSelector::Top => json!("top"),
            // Indices above 2^53 are not exact in JS either.
            NoteSelector::Index(i) => json!({ "index": num(i as f64) }),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PatternStep {
    /// Beat offset inside the pattern, 0 <= at < length; multiples of 1/8 beat.
    pub at: f64,
    /// Note length in beats (> 0). May exceed the pattern length when `sustain` is used.
    pub length: f64,
    pub notes: NoteSelector,
    /// 0..1 scaling of the track velocity; `None` means 1.
    pub accent: Option<f64>,
}

impl PatternStep {
    pub fn new(at: f64, length: f64, notes: NoteSelector) -> PatternStep {
        PatternStep {
            at,
            length,
            notes,
            accent: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("at".into(), num(self.at));
        obj.insert("length".into(), num(self.length));
        obj.insert("notes".into(), self.notes.to_json());
        if let Some(a) = self.accent {
            obj.insert("accent".into(), num(a));
        }
        Value::Object(obj)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatternTail {
    /// A step crossing the chord end is shortened to the boundary (the default).
    Cut,
    /// The last step of each chord is extended to the boundary; held steps are not re-triggered.
    Sustain,
}

impl PatternTail {
    pub fn name(self) -> &'static str {
        match self {
            PatternTail::Cut => "cut",
            PatternTail::Sustain => "sustain",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pattern {
    /// Preset id or 'custom'.
    pub id: String,
    pub name: String,
    /// Pattern length in beats; loops within each chord and restarts at every chord.
    pub length: f64,
    pub steps: Vec<PatternStep>,
    /// `None` behaves as `Cut` and is not written.
    pub tail: Option<PatternTail>,
}

impl Pattern {
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("id".into(), json!(self.id));
        obj.insert("name".into(), json!(self.name));
        obj.insert("length".into(), num(self.length));
        obj.insert(
            "steps".into(),
            Value::Array(self.steps.iter().map(PatternStep::to_json).collect()),
        );
        if let Some(t) = self.tail {
            obj.insert("tail".into(), json!(t.name()));
        }
        Value::Object(obj)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TrackRole {
    Chords,
    Bass,
    Arp,
    Pad,
    Custom,
}

impl TrackRole {
    pub const ALL: [TrackRole; 5] = [
        TrackRole::Chords,
        TrackRole::Bass,
        TrackRole::Arp,
        TrackRole::Pad,
        TrackRole::Custom,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TrackRole::Chords => "chords",
            TrackRole::Bass => "bass",
            TrackRole::Arp => "arp",
            TrackRole::Pad => "pad",
            TrackRole::Custom => "custom",
        }
    }

    pub fn from_name(name: &str) -> Option<TrackRole> {
        TrackRole::ALL.into_iter().find(|r| r.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackVoicing {
    /// `voice_chord` in the track's octave.
    Close,
    /// Just the root in the track's octave.
    RootOnly,
}

impl TrackVoicing {
    pub fn name(self) -> &'static str {
        match self {
            TrackVoicing::Close => "close",
            TrackVoicing::RootOnly => "root-only",
        }
    }

    pub fn from_name(name: &str) -> Option<TrackVoicing> {
        match name {
            "close" => Some(TrackVoicing::Close),
            "root-only" => Some(TrackVoicing::RootOnly),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    /// Stable id, 'trk-' + 8 random base36 characters (see `new_track_id`).
    pub id: String,
    pub name: String,
    /// Only affects defaults and the browser timbre.
    pub role: TrackRole,
    /// MIDI channel 0-15 (shown 1-16 in the UI).
    pub channel: i32,
    /// Octave of the lowest voiced tone (C4 = 4), -1..9.
    pub octave: i32,
    pub voicing: TrackVoicing,
    pub pattern: Pattern,
    /// 1-127.
    pub velocity: i32,
    /// 0 < gate <= 1: fraction of each step's length actually sounding.
    pub gate: f64,
    pub muted: bool,
    /// Transpose in semitones (e.g. -12 for a sub bass).
    pub transpose: i32,
}

impl Track {
    /// The track as `serializeSong` writes it (canonical key order, as `cloneTrack`).
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("id".into(), json!(self.id));
        obj.insert("name".into(), json!(self.name));
        obj.insert("role".into(), json!(self.role.name()));
        obj.insert("channel".into(), num(f64::from(self.channel)));
        obj.insert("octave".into(), num(f64::from(self.octave)));
        obj.insert("voicing".into(), json!(self.voicing.name()));
        obj.insert("pattern".into(), self.pattern.to_json());
        obj.insert("velocity".into(), num(f64::from(self.velocity)));
        obj.insert("gate".into(), num(self.gate));
        obj.insert("muted".into(), json!(self.muted));
        obj.insert("transpose".into(), num(f64::from(self.transpose)));
        Value::Object(obj)
    }
}

const ID_CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH: usize = 8;

/// A new track id: 'trk-' followed by 8 base36 characters drawn with `random` (values in
/// [0, 1), as `Math.random`). Pass `default_random()` for non-deterministic ids.
pub fn new_track_id(random: &mut dyn FnMut() -> f64) -> String {
    let mut id = String::from("trk-");
    for _ in 0..ID_LENGTH {
        let r = random() * ID_CHARS.len() as f64;
        let index = if r.is_nan() {
            0
        } else {
            // `as` saturates, matching Math.min/Math.max around Math.floor.
            (r.floor().max(0.0) as usize).min(ID_CHARS.len() - 1)
        };
        id.push(char::from(ID_CHARS[index]));
    }
    id
}

/// A pseudo-random source in [0, 1) seeded from the process's hash keys and the clock (core
/// takes no dependency for randomness, like the TS code using `Math.random`).
pub fn default_random() -> impl FnMut() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    if let Ok(t) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        hasher.write_u128(t.as_nanos());
    }
    let mut state = hasher.finish() | 1;
    move || {
        // xorshift64*
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let x = state.wrapping_mul(0x2545_f491_4f6c_dd1d);
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_the_ts_shape() {
        let mut random = default_random();
        let id = new_track_id(&mut random);
        assert_eq!(id.len(), 12);
        assert!(id.starts_with("trk-"));
        assert!(id[4..].bytes().all(|b| ID_CHARS.contains(&b)));
        assert_ne!(id, new_track_id(&mut random));
        let mut edge = [0.0, 0.999_999_999, 1.0, -1.0, f64::NAN]
            .into_iter()
            .cycle();
        assert_eq!(new_track_id(&mut || edge.next().unwrap()), "trk-0zz000zz");
    }
}
