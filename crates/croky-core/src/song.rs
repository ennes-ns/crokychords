//! The song record (port of `progression.ts`): schema 4 with tracks, the melody lane and song
//! presets, `validateSong` with the same error paths and messages (migrating schema 1 to 3),
//! `serializeSong` output byte for byte, and the small helpers (`chordAtBeat`, ...).

use serde_json::{json, Map, Value};

use crate::json::{is_integer, num, to_js_json};
use crate::melody::{
    default_melody, Melody, MelodyNote, MAX_MELODY_NOTES, MELODY_OCTAVE_MAX, MELODY_OCTAVE_MIN,
    MELODY_STEP,
};
use crate::patterns::default_tracks;
use crate::theory::{parse_note_name, Key, Mode};
use crate::token::{is_rest_token, parse_token};
use crate::tracks::{
    default_random, NoteSelector, Pattern, PatternStep, PatternTail, Track, TrackRole,
    TrackVoicing, USER_PATTERN_PREFIX,
};

#[derive(Clone, Debug, PartialEq)]
pub struct SongKey {
    /// Tonic as a note name, e.g. 'C', 'F#', 'Bb'.
    pub tonic: String,
    pub mode: Mode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meter {
    pub beats: u32,
    pub unit: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SongChord {
    /// A `roman-numeral-v1` token or 'rest'.
    pub token: String,
    /// > 0, a multiple of 0.25. One beat is one quarter note.
    pub beats: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Song {
    /// 4 since the pattern editor (3: melody v1, 2: tracks v1). `validate_song` always returns 4.
    pub schema: u32,
    pub title: String,
    pub key: SongKey,
    /// BPM (quarter notes per minute).
    pub tempo: f64,
    pub meter: Meter,
    pub chords: Vec<SongChord>,
    /// The band (schema 2). `None` only for hand-built schema-1 songs.
    pub tracks: Option<Vec<Track>>,
    /// The melody lane (schema 3). `None` only for hand-built schema-1/2 songs.
    pub melody: Option<Melody>,
    /// Song presets (schema 4): patterns saved in the pattern editor, ids starting with
    /// `USER_PATTERN_PREFIX`. `None` only for hand-built schema-1..3 songs.
    pub patterns: Option<Vec<Pattern>>,
}

/// `SongError` of `validateSong` / `deserializeSong`: `path` points at the offending value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SongError {
    pub path: String,
    pub reason: String,
}

impl SongError {
    fn new(path: impl Into<String>, reason: impl Into<String>) -> SongError {
        SongError {
            path: path.into(),
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for SongError {
    /// The TS `message`: `path: reason`, or just `reason` for the root.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.reason)
        } else {
            write!(f, "{}: {}", self.path, self.reason)
        }
    }
}

impl std::error::Error for SongError {}

pub const DEFAULT_SONG_TITLE: &str = "Untitled";
/// Highest tempo (BPM) a song may have; the editor offers 20–300.
pub const MAX_TEMPO: f64 = 1000.0;
/// Most beats per bar a song may have.
pub const MAX_METER_BEATS: u32 = 32;
/// Most song presets a song may hold.
pub const MAX_SONG_PATTERNS: usize = 64;
const METER_UNITS: [u32; 6] = [1, 2, 4, 8, 16, 32];

/// A new schema-4 song with the defaults of `createSong` (C major, 120 BPM, 4/4, no chords,
/// `default_tracks`, an empty melody, no song presets). Override fields with struct update
/// syntax.
pub fn create_song() -> Song {
    create_song_with(&mut default_random())
}

/// `create_song` with the random source for the track ids.
pub fn create_song_with(random: &mut dyn FnMut() -> f64) -> Song {
    Song {
        schema: 4,
        title: DEFAULT_SONG_TITLE.into(),
        key: SongKey {
            tonic: "C".into(),
            mode: Mode::Major,
        },
        tempo: 120.0,
        meter: Meter { beats: 4, unit: 4 },
        chords: Vec::new(),
        tracks: Some(default_tracks(random)),
        melody: Some(default_melody()),
        patterns: Some(Vec::new()),
    }
}

type Obj = Map<String, Value>;
type Res<T> = Result<T, SongError>;

fn join(path: &str, field: &str) -> String {
    if path.is_empty() {
        field.into()
    } else {
        format!("{path}.{field}")
    }
}

fn record<'a>(value: Option<&'a Value>, path: &str) -> Res<&'a Obj> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| SongError::new(path, "expected an object"))
}

fn string_field(obj: &Obj, field: &str, path: &str) -> Res<String> {
    obj.get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| SongError::new(join(path, field), "expected a string"))
}

fn number_field(obj: &Obj, field: &str, path: &str) -> Res<f64> {
    obj.get(field)
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .ok_or_else(|| SongError::new(join(path, field), "expected a finite number"))
}

fn int_field(obj: &Obj, field: &str, path: &str, min: i32, max: i32) -> Res<i32> {
    let value = number_field(obj, field, path)?;
    if !is_integer(value) || value < f64::from(min) || value > f64::from(max) {
        return Err(SongError::new(
            join(path, field),
            format!("must be an integer in {min}..{max}"),
        ));
    }
    Ok(value as i32)
}

fn bool_field(obj: &Obj, field: &str, path: &str) -> Res<bool> {
    obj.get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| SongError::new(join(path, field), "expected a boolean"))
}

fn one_of<T: Copy>(obj: &Obj, field: &str, path: &str, allowed: &[(&str, T)]) -> Res<T> {
    let value = obj.get(field).and_then(Value::as_str);
    allowed
        .iter()
        .find(|(name, _)| Some(*name) == value)
        .map(|(_, t)| *t)
        .ok_or_else(|| {
            let names: Vec<&str> = allowed.iter().map(|(n, _)| *n).collect();
            SongError::new(
                join(path, field),
                format!("expected one of {}", names.join(", ")),
            )
        })
}

fn array<'a>(value: Option<&'a Value>, path: &str) -> Res<&'a Vec<Value>> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| SongError::new(path, "expected an array"))
}

/// True when `n` is a whole number of eighth beats.
fn on_eighth_grid(n: f64) -> bool {
    is_integer(n * 8.0)
}

/// True when `n` is a whole number of melody steps (1/16 notes).
fn on_melody_grid(n: f64) -> bool {
    is_integer(n / MELODY_STEP)
}

fn validate_selector(value: Option<&Value>, path: &str) -> Res<NoteSelector> {
    if let Some(Value::String(s)) = value {
        return NoteSelector::from_name(s)
            .ok_or_else(|| SongError::new(path, format!("unknown note selector \"{s}\"")));
    }
    let obj = record(value, path)?;
    let index = number_field(obj, "index", path)?;
    if !is_integer(index) || index < 0.0 {
        return Err(SongError::new(
            format!("{path}.index"),
            "must be a non-negative integer",
        ));
    }
    Ok(NoteSelector::Index(index as u64))
}

fn validate_pattern(value: Option<&Value>, path: &str) -> Res<Pattern> {
    let obj = record(value, path)?;
    let id = string_field(obj, "id", path)?;
    let name = string_field(obj, "name", path)?;
    let length = number_field(obj, "length", path)?;
    if length <= 0.0 || !on_eighth_grid(length) {
        return Err(SongError::new(
            format!("{path}.length"),
            "must be > 0 and a multiple of 1/8",
        ));
    }
    let raw_steps = array(obj.get("steps"), &format!("{path}.steps"))?;
    let mut steps = Vec::with_capacity(raw_steps.len());
    for (i, item) in raw_steps.iter().enumerate() {
        let p = format!("{path}.steps[{i}]");
        let s = record(Some(item), &p)?;
        let at = number_field(s, "at", &p)?;
        if at < 0.0 || at >= length || !on_eighth_grid(at) {
            return Err(SongError::new(
                format!("{p}.at"),
                "must be in 0..length (exclusive) and a multiple of 1/8",
            ));
        }
        let step_length = number_field(s, "length", &p)?;
        if step_length <= 0.0 {
            return Err(SongError::new(format!("{p}.length"), "must be > 0"));
        }
        let notes = validate_selector(s.get("notes"), &format!("{p}.notes"))?;
        let accent = match s.get("accent") {
            None => None,
            Some(_) => {
                let accent = number_field(s, "accent", &p)?;
                if !(0.0..=1.0).contains(&accent) {
                    return Err(SongError::new(format!("{p}.accent"), "must be in 0..1"));
                }
                Some(accent)
            }
        };
        steps.push(PatternStep {
            at,
            length: step_length,
            notes,
            accent,
        });
    }
    let tail = match obj.get("tail") {
        None => None,
        Some(_) => Some(one_of(
            obj,
            "tail",
            path,
            &[("cut", PatternTail::Cut), ("sustain", PatternTail::Sustain)],
        )?),
    };
    Ok(Pattern {
        id,
        name,
        length,
        steps,
        tail,
    })
}

fn validate_track(value: &Value, path: &str) -> Res<Track> {
    let obj = record(Some(value), path)?;
    let id = string_field(obj, "id", path)?;
    if id.is_empty() {
        return Err(SongError::new(format!("{path}.id"), "must not be empty"));
    }
    let name = string_field(obj, "name", path)?;
    let roles = TrackRole::ALL.map(|r| (r.name(), r));
    let role = one_of(obj, "role", path, &roles)?;
    let channel = int_field(obj, "channel", path, 0, 15)?;
    let octave = int_field(obj, "octave", path, -1, 9)?;
    let voicing = one_of(
        obj,
        "voicing",
        path,
        &[
            ("close", TrackVoicing::Close),
            ("root-only", TrackVoicing::RootOnly),
        ],
    )?;
    let pattern = validate_pattern(obj.get("pattern"), &format!("{path}.pattern"))?;
    let velocity = int_field(obj, "velocity", path, 1, 127)?;
    let gate = number_field(obj, "gate", path)?;
    if !(gate > 0.0 && gate <= 1.0) {
        return Err(SongError::new(format!("{path}.gate"), "must be in (0, 1]"));
    }
    let muted = bool_field(obj, "muted", path)?;
    let transpose = int_field(obj, "transpose", path, -127, 127)?;
    Ok(Track {
        id,
        name,
        role,
        channel,
        octave,
        voicing,
        pattern,
        velocity,
        gate,
        muted,
        transpose,
    })
}

fn validate_tracks(value: Option<&Value>) -> Res<Vec<Track>> {
    let items = array(value, "tracks")?;
    let mut tracks: Vec<Track> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let track = validate_track(item, &format!("tracks[{i}]"))?;
        if tracks.iter().any(|t| t.id == track.id) {
            return Err(SongError::new(
                format!("tracks[{i}].id"),
                format!("duplicate id \"{}\"", track.id),
            ));
        }
        tracks.push(track);
    }
    Ok(tracks)
}

/// `String#trim` whitespace: Unicode `Zs`, the line terminators, TAB, VT, FF and BOM (unlike
/// `char::is_whitespace`, it includes U+FEFF and leaves out U+0085).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn validate_song_patterns(value: Option<&Value>) -> Res<Vec<Pattern>> {
    let items = array(value, "patterns")?;
    if items.len() > MAX_SONG_PATTERNS {
        return Err(SongError::new(
            "patterns",
            format!("at most {MAX_SONG_PATTERNS} song presets"),
        ));
    }
    let mut patterns: Vec<Pattern> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("patterns[{i}]");
        let pattern = validate_pattern(Some(item), &path)?;
        if !pattern.id.starts_with(USER_PATTERN_PREFIX) || pattern.id == USER_PATTERN_PREFIX {
            return Err(SongError::new(
                format!("{path}.id"),
                format!("must start with \"{USER_PATTERN_PREFIX}\""),
            ));
        }
        if patterns.iter().any(|p| p.id == pattern.id) {
            return Err(SongError::new(
                format!("{path}.id"),
                format!("duplicate id \"{}\"", pattern.id),
            ));
        }
        if pattern.name.chars().all(is_js_space) {
            return Err(SongError::new(format!("{path}.name"), "must not be empty"));
        }
        patterns.push(pattern);
    }
    Ok(patterns)
}

fn validate_melody_note(value: &Value, path: &str) -> Res<MelodyNote> {
    let obj = record(Some(value), path)?;
    let beat = number_field(obj, "beat", path)?;
    if beat < 0.0 || !on_melody_grid(beat) {
        return Err(SongError::new(
            format!("{path}.beat"),
            format!("must be >= 0 and a multiple of {MELODY_STEP}"),
        ));
    }
    let length = number_field(obj, "length", path)?;
    if length <= 0.0 || !on_melody_grid(length) {
        return Err(SongError::new(
            format!("{path}.length"),
            format!("must be > 0 and a multiple of {MELODY_STEP}"),
        ));
    }
    let degree = obj
        .get("degree")
        .and_then(Value::as_f64)
        .filter(|&d| is_integer(d) && (1.0..=7.0).contains(&d))
        .ok_or_else(|| SongError::new(format!("{path}.degree"), "must be an integer in 1..7"))?;
    let octave = int_field(obj, "octave", path, MELODY_OCTAVE_MIN, MELODY_OCTAVE_MAX)?;
    let accidental = obj
        .get("accidental")
        .and_then(Value::as_f64)
        .filter(|&a| a == -1.0 || a == 0.0 || a == 1.0)
        .ok_or_else(|| SongError::new(format!("{path}.accidental"), "expected one of -1, 0, 1"))?;
    Ok(MelodyNote {
        beat,
        length,
        degree: degree as u8,
        octave,
        accidental: accidental as i32,
    })
}

fn validate_melody(value: Option<&Value>) -> Res<Melody> {
    let obj = record(value, "melody")?;
    let channel = int_field(obj, "channel", "melody", 0, 15)?;
    let muted = bool_field(obj, "muted", "melody")?;
    let raw = array(obj.get("notes"), "melody.notes")?;
    if raw.len() > MAX_MELODY_NOTES {
        return Err(SongError::new(
            "melody.notes",
            format!("at most {MAX_MELODY_NOTES} notes"),
        ));
    }
    let mut end = 0.0;
    let mut notes = Vec::with_capacity(raw.len());
    for (i, item) in raw.iter().enumerate() {
        let path = format!("melody.notes[{i}]");
        let note = validate_melody_note(item, &path)?;
        if note.beat < end {
            return Err(SongError::new(
                format!("{path}.beat"),
                "overlaps the previous note",
            ));
        }
        end = note.beat + note.length;
        notes.push(note);
    }
    Ok(Melody {
        channel,
        muted,
        notes,
    })
}

/// `validateSong`: check that `value` is a valid song and return a normalised schema-4 copy
/// (unknown fields dropped). Schema 1 gets `default_tracks` (fresh ids), schema 1 and 2 get an
/// empty default melody, schema 1-3 get no song presets. Errors carry the TS path and message.
pub fn validate_song(value: &Value) -> Result<Song, SongError> {
    validate_song_with(value, &mut default_random())
}

/// `validate_song` with the random source for the ids of migrated schema-1 tracks.
pub fn validate_song_with(
    value: &Value,
    random: &mut dyn FnMut() -> f64,
) -> Result<Song, SongError> {
    let root = record(Some(value), "")?;
    let schema = match root.get("schema").and_then(Value::as_f64) {
        Some(s) if s == 1.0 || s == 2.0 || s == 3.0 || s == 4.0 => s as u32,
        _ => return Err(SongError::new("schema", "expected 1, 2, 3 or 4")),
    };
    let title = string_field(root, "title", "")?;

    let key_obj = record(root.get("key"), "key")?;
    let tonic = string_field(key_obj, "tonic", "key")?;
    if parse_note_name(&tonic).is_none() {
        return Err(SongError::new(
            "key.tonic",
            format!("invalid note name \"{tonic}\""),
        ));
    }
    let mode = key_obj
        .get("mode")
        .and_then(Value::as_str)
        .and_then(Mode::from_name)
        .ok_or_else(|| SongError::new("key.mode", "unknown mode"))?;

    let tempo = number_field(root, "tempo", "")?;
    if tempo <= 0.0 || tempo > MAX_TEMPO {
        return Err(SongError::new(
            "tempo",
            format!("must be > 0 and at most {MAX_TEMPO}"),
        ));
    }

    let meter_obj = record(root.get("meter"), "meter")?;
    let meter_beats = number_field(meter_obj, "beats", "meter")?;
    if !is_integer(meter_beats) || meter_beats < 1.0 || meter_beats > f64::from(MAX_METER_BEATS) {
        return Err(SongError::new(
            "meter.beats",
            format!("must be an integer from 1 to {MAX_METER_BEATS}"),
        ));
    }
    let unit = number_field(meter_obj, "unit", "meter")?;
    if !METER_UNITS.iter().any(|&u| f64::from(u) == unit) {
        return Err(SongError::new("meter.unit", "must be 1, 2, 4, ..., 32"));
    }

    let raw_chords = array(root.get("chords"), "chords")?;
    let mut chords = Vec::with_capacity(raw_chords.len());
    for (i, item) in raw_chords.iter().enumerate() {
        let path = format!("chords[{i}]");
        let obj = record(Some(item), &path)?;
        let token = string_field(obj, "token", &path)?;
        if !is_rest_token(&token) {
            parse_token(&token)
                .map_err(|e| SongError::new(format!("{path}.token"), e.to_string()))?;
        }
        let beats = number_field(obj, "beats", &path)?;
        if beats <= 0.0 || !is_integer(beats * 4.0) {
            return Err(SongError::new(
                format!("{path}.beats"),
                "must be > 0 and a multiple of 0.25",
            ));
        }
        chords.push(SongChord { token, beats });
    }

    let tracks = if schema == 1 {
        default_tracks(random)
    } else {
        validate_tracks(root.get("tracks"))?
    };
    let melody = if schema >= 3 {
        validate_melody(root.get("melody"))?
    } else {
        default_melody()
    };
    let patterns = if schema == 4 {
        validate_song_patterns(root.get("patterns"))?
    } else {
        Vec::new()
    };
    Ok(Song {
        schema: 4,
        title,
        key: SongKey { tonic, mode },
        tempo,
        meter: Meter {
            beats: meter_beats as u32,
            unit: unit as u32,
        },
        chords,
        tracks: Some(tracks),
        melody: Some(melody),
        patterns: Some(patterns),
    })
}

/// `deserializeSong`: parse JSON and validate it. A JSON syntax error has path '' (its
/// message comes from the Rust parser, not from `JSON.parse`).
pub fn deserialize_song(json: &str) -> Result<Song, SongError> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| SongError::new("", format!("invalid JSON: {e}")))?;
    validate_song(&value)
}

/// `serializeSong`: JSON (2-space indented) with the stable key order. Writes schema 4 with
/// the tracks, the melody (an empty default one when the song has none) and the song presets
/// (none when the song has none); a song without tracks (a hand-built schema-1 song) is
/// written as schema 1.
pub fn serialize_song(song: &Song) -> String {
    let mut obj = Map::new();
    let schema = if song.tracks.is_none() { 1 } else { 4 };
    obj.insert("schema".into(), json!(schema));
    obj.insert("title".into(), json!(song.title));
    obj.insert(
        "key".into(),
        json!({ "tonic": song.key.tonic, "mode": song.key.mode.name() }),
    );
    obj.insert("tempo".into(), num(song.tempo));
    obj.insert(
        "meter".into(),
        json!({ "beats": song.meter.beats, "unit": song.meter.unit }),
    );
    let chords = song
        .chords
        .iter()
        .map(|c| json!({ "token": c.token, "beats": num(c.beats) }))
        .collect();
    obj.insert("chords".into(), Value::Array(chords));
    if let Some(tracks) = &song.tracks {
        let tracks = tracks.iter().map(Track::to_json).collect();
        obj.insert("tracks".into(), Value::Array(tracks));
        let melody = song
            .melody
            .as_ref()
            .map_or_else(|| default_melody().to_json(), Melody::to_json);
        obj.insert("melody".into(), melody);
        let patterns = song
            .patterns
            .iter()
            .flatten()
            .map(Pattern::to_json)
            .collect();
        obj.insert("patterns".into(), Value::Array(patterns));
    }
    to_js_json(&Value::Object(obj), true)
}

impl Pattern {
    /// A pattern from JSON, validated as `validateSong` validates `tracks[i].pattern`
    /// (error paths start with `pattern`).
    pub fn from_value(value: &Value) -> Result<Pattern, SongError> {
        validate_pattern(Some(value), "pattern")
    }
}

impl Track {
    /// A track from JSON, validated as `validateSong` validates `tracks[i]` (error paths
    /// start with `track`).
    pub fn from_value(value: &Value) -> Result<Track, SongError> {
        validate_track(value, "track")
    }
}

/// The chord (or rest) sounding at a beat, with its index and start beat.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChordAt<'a> {
    pub index: usize,
    pub chord: &'a SongChord,
    pub start: f64,
}

impl Song {
    /// `deserializeSong`.
    pub fn from_json(json: &str) -> Result<Song, SongError> {
        deserialize_song(json)
    }

    /// `serializeSong`.
    pub fn to_json(&self) -> String {
        serialize_song(self)
    }

    /// `songKey`. A tonic that does not parse (only in a hand-built song) counts as C.
    pub fn key(&self) -> Key {
        Key {
            tonic: parse_note_name(&self.key.tonic).unwrap_or(0),
            mode: self.key.mode,
        }
    }

    /// `songTokens`: tokens in order, rests removed (the context for `suggest_next`).
    pub fn tokens(&self) -> Vec<String> {
        self.chords
            .iter()
            .filter(|c| !is_rest_token(&c.token))
            .map(|c| c.token.clone())
            .collect()
    }

    /// `totalBeats`.
    pub fn total_beats(&self) -> f64 {
        self.chords.iter().fold(0.0, |sum, c| sum + c.beats)
    }

    /// `chordAtBeat`: the chord (or rest) sounding at `beat` (0-based), `None` outside the song.
    pub fn chord_at_beat(&self, beat: f64) -> Option<ChordAt<'_>> {
        if beat.is_nan() || beat < 0.0 {
            return None;
        }
        let mut start = 0.0;
        for (index, chord) in self.chords.iter().enumerate() {
            if beat < start + chord.beats {
                return Some(ChordAt {
                    index,
                    chord,
                    start,
                });
            }
            start += chord.beats;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str = r#"{"schema":1,"title":"T","key":{"tonic":"Eb","mode":"minor"},
        "tempo":96,"meter":{"beats":4,"unit":4},
        "chords":[{"token":"i","beats":4},{"token":"rest","beats":2},{"token":"bVI","beats":2}]}"#;

    #[test]
    fn reads_a_schema_1_song_and_migrates_it() {
        let song = Song::from_json(SONG).unwrap();
        assert_eq!(song.schema, 4);
        assert_eq!(song.key().tonic, 3);
        assert_eq!(song.tokens(), vec!["i", "bVI"]);
        assert_eq!(song.total_beats(), 8.0);
        assert_eq!(song.tracks.as_ref().map(Vec::len), Some(3));
        assert_eq!(song.chord_at_beat(5.0).map(|c| c.index), Some(1));
        assert_eq!(song.chord_at_beat(8.0), None);
        let again = Song::from_json(&song.to_json()).unwrap();
        assert_eq!(again, song);
    }

    #[test]
    fn rejects_bad_chords_with_the_ts_path() {
        let err = Song::from_json(&SONG.replace("bVI", "bVIx")).unwrap_err();
        assert_eq!(err.path, "chords[2].token");
        let err = Song::from_json(&SONG.replace("\"beats\":2}]", "\"beats\":0.1}]")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "chords[2].beats: must be > 0 and a multiple of 0.25"
        );
    }

    #[test]
    fn a_song_without_tracks_is_written_as_schema_1() {
        let song = Song {
            tracks: None,
            melody: None,
            patterns: None,
            ..create_song()
        };
        assert!(song.to_json().starts_with("{\n  \"schema\": 1,"));
        assert!(!song.to_json().contains("melody"));
    }
}
