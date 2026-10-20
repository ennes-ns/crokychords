//! The command contract in Rust (`docs/specs/assistant-v1.md` §A1–A3): JSON commands parsed
//! from `serde_json` values with the same rules and error paths as the zod schemas in
//! `packages/core/src/commands.ts`, and an engine that applies them to the editor state with
//! the web app's semantics (replace-first picks, the "+" slot, one undo step per song edit).
//! The fixture `packages/core/test/fixtures/commands-v1.json` is the shared contract; the tests
//! below run every scenario in it.

use croky_core::melody::{MAX_MELODY_NOTES, MELODY_OCTAVE_MAX, MELODY_OCTAVE_MIN, MELODY_STEP};
use croky_core::theory::parse_note_name;
use croky_core::tracks::default_random;
use croky_core::{
    create_song, create_track, is_rest_token, parse_token, pattern_preset, pattern_presets,
    serialize_song, validate_song, Melody, MelodyNote, Mode, Song, SongChord, Track,
    TrackOverrides, TrackRole, TrackVoicing,
};
use serde_json::{json, Map, Value};

use crate::app::UNDO_LIMIT;
use crate::edit::{clamp_selection, insert_after, insert_length, quantize, LoopRange, MIN_BEATS};

/// Version of the contract (`schema_version` of the fixture).
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_COMMANDS: usize = 256;
const MAX_COMMAND_CHORDS: usize = 1024;
const MAX_COMMAND_BEATS: f64 = 64.0;
const MAX_NOTE_BEAT: f64 = 4096.0;
const TEMPO_MIN: f64 = 20.0;
const TEMPO_MAX: f64 = 300.0;
const METER_UNITS: [u32; 6] = [1, 2, 4, 8, 16, 32];
const MAX_TITLE: usize = 200;
const MAX_NAME: usize = 64;

/// Every op with its kind, in the order of the spec and the fixture.
pub const OPS: [(&str, &str); 30] = [
    ("appendChord", "song"),
    ("insertChord", "song"),
    ("replaceChord", "song"),
    ("deleteChord", "song"),
    ("setChordBeats", "song"),
    ("setChords", "song"),
    ("pick", "song"),
    ("setKey", "song"),
    ("setTempo", "song"),
    ("setMeter", "song"),
    ("setTitle", "song"),
    ("addNote", "song"),
    ("deleteNote", "song"),
    ("setNotes", "song"),
    ("setMelody", "song"),
    ("addTrack", "song"),
    ("removeTrack", "song"),
    ("setTrack", "song"),
    ("setTrackPattern", "song"),
    ("newSong", "song"),
    ("undo", "history"),
    ("redo", "history"),
    ("select", "view"),
    ("setLoop", "view"),
    ("setInstrument", "sound"),
    ("play", "transport"),
    ("stop", "transport"),
    ("audition", "transport"),
    ("exportMidi", "file"),
    ("save", "file"),
];

/// The fields each op accepts (anything else is refused).
fn fields(op: &str) -> &'static [&'static str] {
    match op {
        "appendChord" => &["token", "beats"],
        "insertChord" => &["at", "token", "beats"],
        "replaceChord" => &["index", "token", "beats"],
        "deleteChord" | "deleteNote" => &["index"],
        "setChordBeats" => &["index", "beats"],
        "setChords" => &["chords"],
        "pick" => &["token", "insert"],
        "setKey" => &["tonic", "mode"],
        "setTempo" => &["bpm"],
        "setMeter" => &["beats", "unit"],
        "setTitle" => &["title"],
        "addNote" => &["beat", "length", "degree", "octave", "accidental"],
        "setNotes" => &["notes"],
        "setMelody" => &["channel", "muted"],
        "addTrack" => &["role"],
        "removeTrack" => &["track"],
        "setTrack" => &[
            "track",
            "name",
            "role",
            "channel",
            "octave",
            "voicing",
            "velocity",
            "gate",
            "muted",
            "transpose",
        ],
        "setTrackPattern" => &["track", "preset"],
        "select" => &["index"],
        "setLoop" => &["enabled", "range"],
        "setInstrument" => &["track", "instrument"],
        "play" => &["from"],
        "audition" => &["token"],
        _ => &[],
    }
}

/// A track by id or by index.
#[derive(Clone, Debug, PartialEq)]
pub enum TrackRef {
    Id(String),
    Index(usize),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackPatch {
    pub name: Option<String>,
    pub role: Option<TrackRole>,
    pub channel: Option<i32>,
    pub octave: Option<i32>,
    pub voicing: Option<TrackVoicing>,
    pub velocity: Option<i32>,
    pub gate: Option<f64>,
    pub muted: Option<bool>,
    pub transpose: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    AppendChord {
        token: String,
        beats: Option<f64>,
    },
    InsertChord {
        at: usize,
        token: String,
        beats: Option<f64>,
    },
    ReplaceChord {
        index: usize,
        token: String,
        beats: Option<f64>,
    },
    DeleteChord {
        index: usize,
    },
    SetChordBeats {
        index: usize,
        beats: f64,
    },
    SetChords {
        chords: Vec<SongChord>,
    },
    Pick {
        token: String,
        insert: bool,
    },
    SetKey {
        tonic: Option<String>,
        mode: Option<Mode>,
    },
    SetTempo {
        bpm: f64,
    },
    SetMeter {
        beats: u32,
        unit: u32,
    },
    SetTitle {
        title: String,
    },
    AddNote(MelodyNote),
    DeleteNote {
        index: usize,
    },
    SetNotes {
        notes: Vec<MelodyNote>,
    },
    SetMelody {
        channel: Option<i32>,
        muted: Option<bool>,
    },
    AddTrack {
        role: TrackRole,
    },
    RemoveTrack {
        track: TrackRef,
    },
    SetTrack {
        track: TrackRef,
        patch: TrackPatch,
    },
    SetTrackPattern {
        track: TrackRef,
        preset: String,
    },
    NewSong,
    Undo,
    Redo,
    Select {
        index: Option<usize>,
    },
    /// `range`: absent, `Some(None)` to clear, `Some(Some(r))` to set.
    SetLoop {
        enabled: Option<bool>,
        range: Option<Option<LoopRange>>,
    },
    SetInstrument,
    Play {
        from: Option<f64>,
    },
    Stop,
    Audition {
        token: String,
    },
    ExportMidi,
    Save,
}

impl Command {
    pub fn op(&self) -> &'static str {
        match self {
            Command::AppendChord { .. } => "appendChord",
            Command::InsertChord { .. } => "insertChord",
            Command::ReplaceChord { .. } => "replaceChord",
            Command::DeleteChord { .. } => "deleteChord",
            Command::SetChordBeats { .. } => "setChordBeats",
            Command::SetChords { .. } => "setChords",
            Command::Pick { .. } => "pick",
            Command::SetKey { .. } => "setKey",
            Command::SetTempo { .. } => "setTempo",
            Command::SetMeter { .. } => "setMeter",
            Command::SetTitle { .. } => "setTitle",
            Command::AddNote(_) => "addNote",
            Command::DeleteNote { .. } => "deleteNote",
            Command::SetNotes { .. } => "setNotes",
            Command::SetMelody { .. } => "setMelody",
            Command::AddTrack { .. } => "addTrack",
            Command::RemoveTrack { .. } => "removeTrack",
            Command::SetTrack { .. } => "setTrack",
            Command::SetTrackPattern { .. } => "setTrackPattern",
            Command::NewSong => "newSong",
            Command::Undo => "undo",
            Command::Redo => "redo",
            Command::Select { .. } => "select",
            Command::SetLoop { .. } => "setLoop",
            Command::SetInstrument => "setInstrument",
            Command::Play { .. } => "play",
            Command::Stop => "stop",
            Command::Audition { .. } => "audition",
            Command::ExportMidi => "exportMidi",
            Command::Save => "save",
        }
    }
}

/// `CommandError` of the contract.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandError {
    /// `invalid`, `not_found`, `unsupported` or `failed`.
    pub code: &'static str,
    pub index: usize,
    pub op: Option<String>,
    pub path: String,
    pub message: String,
}

impl CommandError {
    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "index": self.index,
            "op": self.op,
            "path": self.path,
            "message": self.message,
        })
    }
}

/// A problem inside one command, before it knows its position.
#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> Problem {
    Problem {
        code: "invalid",
        path: path.into(),
        message: message.into(),
    }
}

fn not_found(path: impl Into<String>, message: impl Into<String>) -> Problem {
    Problem {
        code: "not_found",
        path: path.into(),
        message: message.into(),
    }
}

fn join(base: &str, field: &str) -> String {
    if base.is_empty() {
        field.into()
    } else {
        format!("{base}.{field}")
    }
}

/// Reads the fields of one JSON object with the zod rules; `base` prefixes the paths.
struct Fields<'a> {
    obj: &'a Map<String, Value>,
    base: String,
}

impl<'a> Fields<'a> {
    fn new(value: &'a Value, base: &str, allowed: &[&str]) -> Result<Fields<'a>, Problem> {
        let Some(obj) = value.as_object() else {
            return Err(invalid(base, "expected an object"));
        };
        for key in obj.keys() {
            if key != "op" && !allowed.contains(&key.as_str()) {
                return Err(invalid(join(base, key), format!("unknown field \"{key}\"")));
            }
        }
        Ok(Fields {
            obj,
            base: base.into(),
        })
    }

    fn path(&self, name: &str) -> String {
        join(&self.base, name)
    }

    /// The value of `name`; `required` turns absence into an error.
    fn get(&self, name: &str, required: bool) -> Result<Option<&'a Value>, Problem> {
        match self.obj.get(name) {
            Some(v) => Ok(Some(v)),
            None if required => Err(invalid(self.path(name), "required")),
            None => Ok(None),
        }
    }

    fn number(&self, name: &str, required: bool) -> Result<Option<f64>, Problem> {
        match self.get(name, required)? {
            None => Ok(None),
            Some(v) => v
                .as_f64()
                .filter(|n| n.is_finite())
                .map(Some)
                .ok_or_else(|| invalid(self.path(name), "expected a number")),
        }
    }

    fn int(&self, name: &str, required: bool, min: f64, max: f64) -> Result<Option<i64>, Problem> {
        let Some(n) = self.number(name, required)? else {
            return Ok(None);
        };
        if n.fract() != 0.0 {
            return Err(invalid(self.path(name), "expected an integer"));
        }
        if n < min || n > max {
            return Err(invalid(
                self.path(name),
                format!("must be from {min} to {max}"),
            ));
        }
        Ok(Some(n as i64))
    }

    fn index(&self, name: &str) -> Result<usize, Problem> {
        Ok(self.int(name, true, 0.0, 9e15)?.unwrap_or(0) as usize)
    }

    fn quarter(
        &self,
        name: &str,
        required: bool,
        min_inclusive: bool,
        max: f64,
    ) -> Result<Option<f64>, Problem> {
        let Some(n) = self.number(name, required)? else {
            return Ok(None);
        };
        let low = if min_inclusive { n < 0.0 } else { n <= 0.0 };
        if low || n > max {
            return Err(invalid(
                self.path(name),
                format!("must be in range (max {max})"),
            ));
        }
        if (n * 4.0).fract() != 0.0 {
            return Err(invalid(self.path(name), "must be a multiple of 0.25"));
        }
        Ok(Some(n))
    }

    fn beats(&self, name: &str, required: bool) -> Result<Option<f64>, Problem> {
        self.quarter(name, required, false, MAX_COMMAND_BEATS)
    }

    fn boolean(&self, name: &str) -> Result<Option<bool>, Problem> {
        match self.get(name, false)? {
            None => Ok(None),
            Some(v) => v
                .as_bool()
                .map(Some)
                .ok_or_else(|| invalid(self.path(name), "expected a boolean")),
        }
    }

    fn string(
        &self,
        name: &str,
        required: bool,
        min: usize,
        max: usize,
    ) -> Result<Option<String>, Problem> {
        match self.get(name, required)? {
            None => Ok(None),
            Some(v) => {
                let s = v
                    .as_str()
                    .ok_or_else(|| invalid(self.path(name), "expected a string"))?;
                let len = s.encode_utf16().count();
                if len < min || len > max {
                    return Err(invalid(
                        self.path(name),
                        format!("must be {min} to {max} characters"),
                    ));
                }
                Ok(Some(s.into()))
            }
        }
    }

    fn token(&self, name: &str) -> Result<String, Problem> {
        let token = self.string(name, true, 0, 64)?.unwrap_or_default();
        if !is_rest_token(&token) && parse_token(&token).is_err() {
            return Err(invalid(
                self.path(name),
                "not a valid chord token (roman-numeral-v1) or \"rest\"",
            ));
        }
        Ok(token)
    }

    fn track(&self, name: &str) -> Result<TrackRef, Problem> {
        let v = self.get(name, true)?.unwrap_or(&Value::Null);
        if let Some(s) = v.as_str() {
            let len = s.encode_utf16().count();
            if (1..=64).contains(&len) {
                return Ok(TrackRef::Id(s.into()));
            }
        } else if let Some(n) = v.as_f64() {
            if n >= 0.0 && n.fract() == 0.0 {
                return Ok(TrackRef::Index(n as usize));
            }
        }
        Err(invalid(self.path(name), "a track id or a track index"))
    }

    fn one_of<T: Copy>(
        &self,
        name: &str,
        parse: impl Fn(&str) -> Option<T>,
    ) -> Result<Option<T>, Problem> {
        match self.get(name, false)? {
            None => Ok(None),
            Some(v) => v
                .as_str()
                .and_then(&parse)
                .map(Some)
                .ok_or_else(|| invalid(self.path(name), "not one of the allowed values")),
        }
    }
}

fn note(value: &Value, base: &str) -> Result<MelodyNote, Problem> {
    let f = Fields::new(value, base, fields("addNote"))?;
    let beat = f.quarter("beat", true, true, MAX_NOTE_BEAT)?.unwrap_or(0.0);
    let length = f.beats("length", true)?.unwrap_or(1.0);
    let degree = f.int("degree", true, 1.0, 7.0)?.unwrap_or(1) as u8;
    let octave = f
        .int(
            "octave",
            false,
            f64::from(MELODY_OCTAVE_MIN),
            f64::from(MELODY_OCTAVE_MAX),
        )?
        .unwrap_or(0) as i32;
    let accidental = f.int("accidental", false, -1.0, 1.0)?.unwrap_or(0) as i32;
    Ok(MelodyNote {
        beat,
        length,
        degree,
        octave,
        accidental,
    })
}

fn array<'a>(f: &Fields<'a>, name: &str, max: usize) -> Result<&'a Vec<Value>, Problem> {
    let v = f.get(name, true)?.unwrap_or(&Value::Null);
    let list = v
        .as_array()
        .ok_or_else(|| invalid(f.path(name), "expected an array"))?;
    if list.len() > max {
        return Err(invalid(f.path(name), format!("at most {max} items")));
    }
    Ok(list)
}

/// Parse one command (the zod schemas' rules).
pub fn parse_command(value: &Value) -> Result<Command, (Option<String>, Problem)> {
    let Some(obj) = value.as_object() else {
        return Err((
            None,
            invalid("", "a command is a JSON object with an \"op\""),
        ));
    };
    let Some(op) = obj.get("op").and_then(Value::as_str) else {
        return Err((None, invalid("op", "missing \"op\"")));
    };
    let name = Some(op.to_string());
    if !OPS.iter().any(|(o, _)| *o == op) {
        return Err((name, invalid("op", format!("unknown op \"{op}\""))));
    }
    parse_args(op, value).map_err(|p| (name, p))
}

fn parse_args(op: &str, value: &Value) -> Result<Command, Problem> {
    let f = Fields::new(value, "", fields(op))?;
    Ok(match op {
        "appendChord" => Command::AppendChord {
            token: f.token("token")?,
            beats: f.beats("beats", false)?,
        },
        "insertChord" => Command::InsertChord {
            at: f.index("at")?,
            token: f.token("token")?,
            beats: f.beats("beats", false)?,
        },
        "replaceChord" => Command::ReplaceChord {
            index: f.index("index")?,
            token: f.token("token")?,
            beats: f.beats("beats", false)?,
        },
        "deleteChord" => Command::DeleteChord {
            index: f.index("index")?,
        },
        "setChordBeats" => Command::SetChordBeats {
            index: f.index("index")?,
            beats: f.beats("beats", true)?.unwrap_or(MIN_BEATS),
        },
        "setChords" => {
            let mut chords = Vec::new();
            for (i, item) in array(&f, "chords", MAX_COMMAND_CHORDS)?.iter().enumerate() {
                let c = Fields::new(item, &format!("chords[{i}]"), &["token", "beats"])?;
                chords.push(SongChord {
                    token: c.token("token")?,
                    beats: c.beats("beats", true)?.unwrap_or(MIN_BEATS),
                });
            }
            Command::SetChords { chords }
        }
        "pick" => Command::Pick {
            token: f.token("token")?,
            insert: f.boolean("insert")?.unwrap_or(false),
        },
        "setKey" => {
            let tonic = f.string("tonic", false, 0, 3)?;
            if let Some(t) = &tonic {
                if parse_note_name(t).is_none() {
                    return Err(invalid("tonic", "not a note name (C, F#, Bb, ...)"));
                }
            }
            let mode = f.one_of("mode", Mode::from_name)?;
            if tonic.is_none() && mode.is_none() {
                return Err(invalid("", "give a tonic, a mode or both"));
            }
            Command::SetKey { tonic, mode }
        }
        "setTempo" => Command::SetTempo {
            bpm: f.int("bpm", true, TEMPO_MIN, TEMPO_MAX)?.unwrap_or(120) as f64,
        },
        "setMeter" => {
            let beats = f.int("beats", true, 1.0, 32.0)?.unwrap_or(4) as u32;
            let unit = f.number("unit", true)?.unwrap_or(4.0);
            if !METER_UNITS.iter().any(|u| f64::from(*u) == unit) {
                return Err(invalid("unit", "must be 1, 2, 4, 8, 16 or 32"));
            }
            Command::SetMeter {
                beats,
                unit: unit as u32,
            }
        }
        "setTitle" => Command::SetTitle {
            title: f.string("title", true, 0, MAX_TITLE)?.unwrap_or_default(),
        },
        "addNote" => Command::AddNote(note(value, "")?),
        "deleteNote" => Command::DeleteNote {
            index: f.index("index")?,
        },
        "setNotes" => {
            let mut notes = Vec::new();
            for (i, item) in array(&f, "notes", MAX_MELODY_NOTES)?.iter().enumerate() {
                notes.push(note(item, &format!("notes[{i}]"))?);
            }
            Command::SetNotes { notes }
        }
        "setMelody" => Command::SetMelody {
            channel: f.int("channel", false, 0.0, 15.0)?.map(|c| c as i32),
            muted: f.boolean("muted")?,
        },
        "addTrack" => Command::AddTrack {
            role: f
                .one_of("role", TrackRole::from_name)?
                .ok_or_else(|| invalid("role", "required"))?,
        },
        "removeTrack" => Command::RemoveTrack {
            track: f.track("track")?,
        },
        "setTrack" => {
            let gate = f.number("gate", false)?;
            if gate.is_some_and(|g| g <= 0.0 || g > 1.0) {
                return Err(invalid("gate", "must be > 0 and at most 1"));
            }
            Command::SetTrack {
                track: f.track("track")?,
                patch: TrackPatch {
                    name: f.string("name", false, 1, MAX_NAME)?,
                    role: f.one_of("role", TrackRole::from_name)?,
                    channel: f.int("channel", false, 0.0, 15.0)?.map(|c| c as i32),
                    octave: f.int("octave", false, -1.0, 9.0)?.map(|c| c as i32),
                    voicing: f.one_of("voicing", TrackVoicing::from_name)?,
                    velocity: f.int("velocity", false, 1.0, 127.0)?.map(|c| c as i32),
                    gate,
                    muted: f.boolean("muted")?,
                    transpose: f.int("transpose", false, -24.0, 24.0)?.map(|c| c as i32),
                },
            }
        }
        "setTrackPattern" => Command::SetTrackPattern {
            track: f.track("track")?,
            preset: f.string("preset", true, 1, 64)?.unwrap_or_default(),
        },
        "newSong" => Command::NewSong,
        "undo" => Command::Undo,
        "redo" => Command::Redo,
        "select" => {
            let v = f.get("index", true)?.unwrap_or(&Value::Null);
            Command::Select {
                index: if v.is_null() {
                    None
                } else {
                    Some(f.index("index")?)
                },
            }
        }
        "setLoop" => {
            let range = match f.get("range", false)? {
                None => None,
                Some(Value::Null) => Some(None),
                Some(v) => {
                    let r = Fields::new(v, "range", &["start", "end"])?;
                    let start = r.number("start", true)?.unwrap_or(0.0);
                    let end = r.number("end", true)?.unwrap_or(0.0);
                    if start < 0.0 {
                        return Err(invalid("range.start", "must be >= 0"));
                    }
                    if end <= 0.0 || end <= start {
                        return Err(invalid("range.end", "end must be after start"));
                    }
                    Some(Some(LoopRange { start, end }))
                }
            };
            Command::SetLoop {
                enabled: f.boolean("enabled")?,
                range,
            }
        }
        "setInstrument" => {
            f.string("instrument", true, 1, 64)?;
            if !f.get("track", true)?.is_some_and(Value::is_string) {
                f.track("track")?;
            }
            Command::SetInstrument
        }
        "play" => {
            let from = f.number("from", false)?;
            if from.is_some_and(|b| b < 0.0) {
                return Err(invalid("from", "must be >= 0"));
            }
            Command::Play { from }
        }
        "stop" => Command::Stop,
        "audition" => Command::Audition {
            token: f.token("token")?,
        },
        "exportMidi" => Command::ExportMidi,
        _ => Command::Save,
    })
}

/// Parse one command or a list of at most `MAX_COMMANDS`; the first error wins.
pub fn parse_commands(value: &Value) -> Result<Vec<Command>, CommandError> {
    let items: Vec<&Value> = match value {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    if items.len() > MAX_COMMANDS {
        return Err(CommandError {
            code: "invalid",
            index: MAX_COMMANDS,
            op: None,
            path: String::new(),
            message: format!("at most {MAX_COMMANDS} commands per call"),
        });
    }
    items
        .into_iter()
        .enumerate()
        .map(|(index, v)| {
            parse_command(v).map_err(|(op, p)| CommandError {
                code: p.code,
                index,
                op,
                path: p.path,
                message: p.message,
            })
        })
        .collect()
}

/// What the engine reads and writes: the song, the view state and the undo history.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineState {
    pub song: Song,
    pub selected: Option<usize>,
    pub looping: bool,
    pub loop_range: Option<LoopRange>,
    pub undo: Vec<Song>,
    pub redo: Vec<Song>,
}

/// Side effects the caller carries out (none in a dry run).
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Play(Option<f64>),
    Stop,
    Audition(String),
    ExportMidi,
    Save,
}

/// One applied command: its result object and its effects.
pub struct Outcome {
    pub result: Map<String, Value>,
    pub effects: Vec<Effect>,
}

fn track_index(song: &Song, track: &TrackRef) -> Result<usize, Problem> {
    let tracks = song.tracks.as_deref().unwrap_or_default();
    match track {
        TrackRef::Index(i) if *i < tracks.len() => Ok(*i),
        TrackRef::Index(i) => Err(not_found(
            "track",
            format!("there is no track {i} (the song has {})", tracks.len()),
        )),
        TrackRef::Id(id) => tracks
            .iter()
            .position(|t| &t.id == id)
            .ok_or_else(|| not_found("track", format!("no track with id \"{id}\""))),
    }
}

fn need_chord(song: &Song, index: usize, path: &str) -> Result<(), Problem> {
    if index < song.chords.len() {
        Ok(())
    } else {
        Err(not_found(
            path,
            format!(
                "there is no chord {index} (the song has {})",
                song.chords.len()
            ),
        ))
    }
}

/// The least used MIDI channel of the tracks, lowest first (`nextFreeChannel`).
pub fn next_free_channel(tracks: &[Track]) -> i32 {
    let mut counts = [0usize; 16];
    for t in tracks {
        if let Some(c) = counts.get_mut(t.channel as usize) {
            *c += 1;
        }
    }
    (1..16).fold(
        0,
        |best, ch| {
            if counts[ch] < counts[best] {
                ch
            } else {
                best
            }
        },
    ) as i32
}

/// `base`, or `base 2`, `base 3`, ... whichever is free (`uniqueTrackName`).
pub fn unique_track_name(tracks: &[Track], base: &str) -> String {
    if !tracks.iter().any(|t| t.name == base) {
        return base.into();
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !tracks.iter().any(|t| &t.name == name))
        .unwrap_or_default()
}

/// `placeNote` of the web lane: notes starting inside the new one go, one running into it is cut.
pub fn place_note(melody: &mut Melody, note: MelodyNote) -> usize {
    let snap = |b: f64| ((b / MELODY_STEP).round() * MELODY_STEP).max(0.0);
    let placed = MelodyNote {
        beat: snap(note.beat),
        length: snap(note.length).max(MELODY_STEP),
        octave: note.octave.clamp(MELODY_OCTAVE_MIN, MELODY_OCTAVE_MAX),
        ..note
    };
    let end = placed.beat + placed.length;
    let mut notes = Vec::new();
    for n in &melody.notes {
        if n.beat >= placed.beat && n.beat < end {
            continue;
        }
        if n.beat < placed.beat && n.beat + n.length > placed.beat {
            notes.push(MelodyNote {
                length: placed.beat - n.beat,
                ..*n
            });
        } else {
            notes.push(*n);
        }
    }
    let index = notes
        .iter()
        .position(|n| n.beat > placed.beat)
        .unwrap_or(notes.len());
    notes.insert(index, placed);
    melody.notes = notes;
    index
}

fn insert_at(song: &mut Song, at: usize, token: &str, beats: Option<f64>) {
    let start: f64 = song.chords.iter().take(at).map(|c| c.beats).sum();
    let beats = beats.unwrap_or_else(|| insert_length(song, start, 4.0));
    song.chords.insert(
        at,
        SongChord {
            token: token.into(),
            beats,
        },
    );
}

/// A song edit: the new song and maybe a new selection, a result and effects.
struct Edit {
    selected: Option<Option<usize>>,
    result: Map<String, Value>,
    effects: Vec<Effect>,
}

impl Edit {
    fn plain() -> Edit {
        Edit {
            selected: None,
            result: Map::new(),
            effects: Vec::new(),
        }
    }

    fn with(key: &str, value: Value) -> Edit {
        let mut e = Edit::plain();
        e.result.insert(key.into(), value);
        e
    }
}

fn edit_song(state: &EngineState, cmd: &Command, song: &mut Song) -> Result<Option<Edit>, Problem> {
    let selected = state.selected;
    let mut edit = Edit::plain();
    match cmd {
        Command::AppendChord { token, beats } => {
            let len = song.chords.len();
            match beats {
                None => {
                    insert_after(song, None, token);
                }
                Some(b) => insert_at(song, len, token, Some(*b)),
            }
            edit = Edit::with("index", json!(len));
        }
        Command::InsertChord { at, token, beats } => {
            if *at > song.chords.len() {
                return Err(not_found(
                    "at",
                    format!("at must be 0..{}", song.chords.len()),
                ));
            }
            let beats = beats.or_else(|| {
                at.checked_sub(1)
                    .and_then(|i| song.chords.get(i))
                    .map(|c| c.beats)
            });
            insert_at(song, *at, token, beats);
            edit = Edit::with("index", json!(at));
            edit.selected = Some(selected.map(|s| if s >= *at { s + 1 } else { s }));
        }
        Command::ReplaceChord {
            index,
            token,
            beats,
        } => {
            need_chord(song, *index, "index")?;
            let chord = &mut song.chords[*index];
            chord.token = token.clone();
            if let Some(b) = beats {
                chord.beats = *b;
            }
        }
        Command::DeleteChord { index } => {
            need_chord(song, *index, "index")?;
            song.chords.remove(*index);
            let next = match selected {
                Some(s) if s == *index => {
                    if song.chords.is_empty() {
                        None
                    } else {
                        Some(index.saturating_sub(1))
                    }
                }
                Some(s) if s > *index => Some(s - 1),
                other => other,
            };
            edit.selected = Some(next);
        }
        Command::SetChordBeats { index, beats } => {
            need_chord(song, *index, "index")?;
            song.chords[*index].beats = MIN_BEATS.max(quantize(*beats));
        }
        Command::SetChords { chords } => song.chords = chords.clone(),
        Command::Pick { token, insert } => match selected.filter(|&i| i < song.chords.len()) {
            None => {
                insert_after(song, None, token);
                edit.selected = Some(None);
            }
            Some(at) if *insert => {
                let new = insert_after(song, Some(at), token);
                edit.selected = Some(Some(new));
            }
            Some(at) => {
                song.chords[at].token = token.clone();
                edit.selected = Some(Some(at));
            }
        },
        Command::SetKey { tonic, mode } => {
            if let Some(t) = tonic {
                song.key.tonic = t.clone();
            }
            if let Some(m) = mode {
                song.key.mode = *m;
            }
        }
        Command::SetTempo { bpm } => song.tempo = *bpm,
        Command::SetMeter { beats, unit } => {
            song.meter.beats = *beats;
            song.meter.unit = *unit;
        }
        Command::SetTitle { title } => song.title = title.clone(),
        Command::AddNote(note) => {
            let melody = song.melody.get_or_insert_with(Melody::default);
            let index = place_note(melody, *note);
            edit = Edit::with("index", json!(index));
        }
        Command::DeleteNote { index } => {
            let melody = song.melody.get_or_insert_with(Melody::default);
            if *index >= melody.notes.len() {
                return Err(not_found(
                    "index",
                    format!(
                        "there is no note {index} (the melody has {})",
                        melody.notes.len()
                    ),
                ));
            }
            melody.notes.remove(*index);
        }
        Command::SetNotes { notes } => {
            let mut sorted = notes.clone();
            sorted.sort_by(|a, b| a.beat.total_cmp(&b.beat));
            let mut end = 0.0;
            for n in &sorted {
                if n.beat < end {
                    return Err(invalid(
                        "notes",
                        format!("notes overlap at beat {}", n.beat),
                    ));
                }
                end = n.beat + n.length;
            }
            song.melody.get_or_insert_with(Melody::default).notes = sorted;
        }
        Command::SetMelody { channel, muted } => {
            let melody = song.melody.get_or_insert_with(Melody::default);
            if let Some(c) = channel {
                melody.channel = *c;
            }
            if let Some(m) = muted {
                melody.muted = *m;
            }
        }
        Command::AddTrack { role } => {
            let tracks = song.tracks.get_or_insert_with(Vec::new);
            let overrides = TrackOverrides {
                channel: Some(next_free_channel(tracks)),
                name: Some(unique_track_name(
                    tracks,
                    croky_core::role_defaults(*role).name,
                )),
                ..TrackOverrides::default()
            };
            let track = create_track(*role, overrides, &mut default_random());
            edit = Edit::with("track", json!(track.id));
            tracks.push(track);
        }
        Command::RemoveTrack { track } => {
            let i = track_index(song, track)?;
            if let Some(tracks) = song.tracks.as_mut() {
                tracks.remove(i);
            }
        }
        Command::SetTrack { track, patch } => {
            let i = track_index(song, track)?;
            if let Some(t) = song.tracks.as_mut().and_then(|t| t.get_mut(i)) {
                if let Some(v) = &patch.name {
                    t.name = v.clone();
                }
                if let Some(v) = patch.role {
                    t.role = v;
                }
                if let Some(v) = patch.channel {
                    t.channel = v;
                }
                if let Some(v) = patch.octave {
                    t.octave = v;
                }
                if let Some(v) = patch.voicing {
                    t.voicing = v;
                }
                if let Some(v) = patch.velocity {
                    t.velocity = v;
                }
                if let Some(v) = patch.gate {
                    t.gate = v;
                }
                if let Some(v) = patch.muted {
                    t.muted = v;
                }
                if let Some(v) = patch.transpose {
                    t.transpose = v;
                }
            }
        }
        Command::SetTrackPattern { track, preset } => {
            let i = track_index(song, track)?;
            let own = song
                .patterns
                .iter()
                .flatten()
                .find(|p| &p.id == preset)
                .cloned();
            let pattern = match own {
                Some(p) => p,
                None if pattern_presets().iter().any(|p| &p.id == preset) => pattern_preset(preset)
                    .map_err(|_| not_found("preset", format!("no pattern preset \"{preset}\"")))?,
                None => {
                    return Err(not_found(
                        "preset",
                        format!("no pattern preset \"{preset}\""),
                    ))
                }
            };
            if let Some(t) = song.tracks.as_mut().and_then(|t| t.get_mut(i)) {
                t.pattern = pattern;
            }
        }
        Command::NewSong => {
            let old = song.clone();
            let mut fresh = create_song();
            fresh.key = old.key;
            fresh.tempo = old.tempo;
            fresh.meter = old.meter;
            if old.tracks.is_some() {
                fresh.tracks = old.tracks;
            }
            let melody = old.melody.unwrap_or_default();
            fresh.melody = Some(Melody {
                notes: Vec::new(),
                ..melody
            });
            fresh.patterns = Some(old.patterns.unwrap_or_default());
            *song = fresh;
            edit.selected = Some(None);
            edit.effects.push(Effect::Stop);
        }
        _ => return Ok(None),
    }
    Ok(Some(edit))
}

/// Apply one parsed command to `state` (with no side effects; they are returned).
pub fn step(state: &mut EngineState, cmd: &Command) -> Result<Outcome, Problem> {
    let mut result = Map::new();
    result.insert("op".into(), json!(cmd.op()));
    let mut song = state.song.clone();
    if let Some(edit) = edit_song(state, cmd, &mut song)? {
        let changed = serialize_song(&song) != serialize_song(&state.song);
        if changed {
            let value: Value = serde_json::from_str(&serialize_song(&song))
                .map_err(|e| invalid("", e.to_string()))?;
            validate_song(&value)
                .map_err(|e| invalid("", format!("the song would be invalid: {e}")))?;
            let before = std::mem::replace(&mut state.song, song);
            state.undo.push(before);
            if state.undo.len() > UNDO_LIMIT {
                state.undo.remove(0);
            }
            state.redo.clear();
        }
        let selected = edit.selected.unwrap_or(state.selected);
        state.selected = clamp_selection(selected, state.song.chords.len());
        result.insert("changed".into(), json!(changed));
        result.extend(edit.result);
        return Ok(Outcome {
            result,
            effects: edit.effects,
        });
    }
    let effects = match cmd {
        Command::Undo | Command::Redo => {
            let undo = matches!(cmd, Command::Undo);
            let (from, to) = if undo {
                (&mut state.undo, &mut state.redo)
            } else {
                (&mut state.redo, &mut state.undo)
            };
            let changed = match from.pop() {
                Some(song) => {
                    to.push(std::mem::replace(&mut state.song, song));
                    state.selected = clamp_selection(state.selected, state.song.chords.len());
                    true
                }
                None => false,
            };
            result.insert("changed".into(), json!(changed));
            Vec::new()
        }
        Command::Select { index } => {
            if let Some(i) = index {
                need_chord(&state.song, *i, "index")?;
            }
            state.selected = *index;
            Vec::new()
        }
        Command::SetLoop { enabled, range } => {
            if let Some(r) = range {
                state.loop_range = *r;
                if r.is_some() {
                    state.looping = true;
                }
            }
            if let Some(e) = enabled {
                state.looping = *e;
            }
            Vec::new()
        }
        Command::SetInstrument => {
            return Err(Problem {
                code: "unsupported",
                path: "op".into(),
                message: "the terminal app has no instrument choice (it sends MIDI only)".into(),
            })
        }
        Command::Play { from } => {
            if state.song.chords.is_empty() {
                return Err(Problem {
                    code: "failed",
                    path: String::new(),
                    message: "nothing to play yet".into(),
                });
            }
            vec![Effect::Play(*from)]
        }
        Command::Stop => vec![Effect::Stop],
        Command::Audition { token } => vec![Effect::Audition(token.clone())],
        Command::ExportMidi => vec![Effect::ExportMidi],
        Command::Save => vec![Effect::Save],
        _ => Vec::new(),
    };
    Ok(Outcome { result, effects })
}

/// Validate and dry-run `input` on a copy of `state`: the commands, or the first error.
pub fn prepare(
    state: &EngineState,
    input: &Value,
    batch: bool,
) -> Result<Vec<Command>, CommandError> {
    let commands = parse_commands(input)?;
    let mut sim = state.clone();
    for (index, cmd) in commands.iter().enumerate() {
        let located = |p: Problem| CommandError {
            code: p.code,
            index,
            op: Some(cmd.op().into()),
            path: p.path,
            message: p.message,
        };
        if batch && matches!(cmd, Command::Undo | Command::Redo) {
            return Err(located(invalid(
                "op",
                format!(
                    "\"{}\" cannot be part of a batch with one undo step",
                    cmd.op()
                ),
            )));
        }
        step(&mut sim, cmd).map_err(located)?;
    }
    Ok(commands)
}

/// Standard base64 (for `exportMidi`'s bytes).
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../packages/core/test/fixtures/commands-v1.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// `createSong()` with the fixture's short-form fields.
    fn song_from(spec: &Value) -> Song {
        let mut song = create_song();
        if let Some(k) = spec.get("key") {
            song.key.tonic = k["tonic"].as_str().unwrap().into();
            song.key.mode = Mode::from_name(k["mode"].as_str().unwrap()).unwrap();
        }
        if let Some(t) = spec.get("tempo").and_then(Value::as_f64) {
            song.tempo = t;
        }
        if let Some(m) = spec.get("meter").and_then(Value::as_array) {
            song.meter.beats = m[0].as_u64().unwrap() as u32;
            song.meter.unit = m[1].as_u64().unwrap() as u32;
        }
        for c in spec
            .get("chords")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            song.chords.push(SongChord {
                token: c[0].as_str().unwrap().into(),
                beats: c[1].as_f64().unwrap(),
            });
        }
        let notes = spec
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        song.melody.as_mut().unwrap().notes = notes
            .iter()
            .map(|n| MelodyNote {
                beat: n[0].as_f64().unwrap(),
                length: n[1].as_f64().unwrap(),
                degree: n[2].as_u64().unwrap() as u8,
                octave: n[3].as_i64().unwrap() as i32,
                accidental: n[4].as_i64().unwrap() as i32,
            })
            .collect();
        song
    }

    /// Run a batch as the command mode does (dry run, then for real), without effects.
    fn apply(state: &mut EngineState, input: &Value, batch: bool) -> Value {
        let commands = match prepare(state, input, batch) {
            Ok(c) => c,
            Err(e) => {
                return json!({ "ok": false, "applied": 0, "results": [], "error": e.to_json() })
            }
        };
        let base = state.undo.len();
        let before = state.song.clone();
        let mut results = Vec::new();
        for cmd in &commands {
            results.push(Value::Object(step(state, cmd).unwrap().result));
        }
        if batch && state.song != before {
            state.undo.truncate(base);
            state.undo.push(before);
        }
        json!({ "ok": true, "applied": results.len(), "results": results })
    }

    /// `expect` ⊆ `actual` for objects (recursively); arrays and scalars must be equal.
    fn subset(expect: &Value, actual: &Value) -> bool {
        match (expect, actual) {
            (Value::Object(e), Value::Object(a)) => e
                .iter()
                .all(|(k, v)| a.get(k).is_some_and(|x| subset(v, x))),
            (Value::Number(e), Value::Number(a)) => e.as_f64() == a.as_f64(),
            _ => expect == actual,
        }
    }

    #[test]
    fn op_lists_match_the_contract() {
        let f = fixture();
        assert_eq!(f["schema_version"], json!(SCHEMA_VERSION));
        let ops: Vec<&str> = OPS.iter().map(|(o, _)| *o).collect();
        let want: Vec<&str> = f["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(ops, want);
        let assistant: Vec<&str> = OPS
            .iter()
            .filter(|(o, k)| *k == "song" && *o != "pick" && *o != "newSong")
            .map(|(o, _)| *o)
            .collect();
        let want: Vec<&str> = f["assistant_ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(assistant, want);
    }

    #[test]
    fn fixture_scenarios() {
        let f = fixture();
        for scenario in f["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let mut state = EngineState {
                song: song_from(&scenario["song"]),
                selected: None,
                looping: false,
                loop_range: None,
                undo: Vec::new(),
                redo: Vec::new(),
            };
            for (n, s) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let at = format!("{name}, step {n}");
                let batch = s.get("undo").and_then(Value::as_str) == Some("batch");
                let result = apply(&mut state, &s["commands"], batch);
                let want = &s["expect"];
                for key in ["ok", "applied"] {
                    if let Some(v) = want.get(key) {
                        assert!(subset(v, &result[key]), "{at}: {key} {result}");
                    }
                }
                if let Some(e) = want.get("error") {
                    assert!(subset(e, &result["error"]), "{at}: error {result}");
                }
                if let Some(r) = want.get("results") {
                    let got = result["results"].as_array().unwrap();
                    let r = r.as_array().unwrap();
                    assert_eq!(got.len(), r.len(), "{at}: results {result}");
                    for (w, g) in r.iter().zip(got) {
                        assert!(subset(w, g), "{at}: result {g} vs {w}");
                    }
                }
                let song = &state.song;
                if let Some(c) = want.get("chords") {
                    let got: Vec<Value> = song
                        .chords
                        .iter()
                        .map(|c| json!([c.token, c.beats]))
                        .collect();
                    assert_eq!(
                        c.as_array().unwrap().len(),
                        got.len(),
                        "{at}: chords {got:?}"
                    );
                    for (w, g) in c.as_array().unwrap().iter().zip(&got) {
                        assert_eq!(w[0], g[0], "{at}");
                        assert_eq!(w[1].as_f64(), g[1].as_f64(), "{at}");
                    }
                }
                if let Some(v) = want.get("selected") {
                    assert_eq!(*v, json!(state.selected), "{at}: selected");
                }
                if let Some(k) = want.get("key") {
                    assert_eq!(
                        *k,
                        json!({ "tonic": song.key.tonic, "mode": song.key.mode.name() }),
                        "{at}"
                    );
                }
                if let Some(t) = want.get("tempo") {
                    assert_eq!(t.as_f64(), Some(song.tempo), "{at}: tempo");
                }
                if let Some(m) = want.get("meter") {
                    assert_eq!(
                        *m,
                        json!([song.meter.beats, song.meter.unit]),
                        "{at}: meter"
                    );
                }
                if let Some(t) = want.get("title") {
                    assert_eq!(t.as_str(), Some(song.title.as_str()), "{at}: title");
                }
                let melody = song.melody.clone().unwrap_or_default();
                if let Some(notes) = want.get("notes") {
                    let got: Vec<[f64; 5]> = melody
                        .notes
                        .iter()
                        .map(|n| {
                            [
                                n.beat,
                                n.length,
                                f64::from(n.degree),
                                f64::from(n.octave),
                                f64::from(n.accidental),
                            ]
                        })
                        .collect();
                    let want: Vec<[f64; 5]> = notes
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| {
                            let a = n.as_array().unwrap();
                            std::array::from_fn(|i| a[i].as_f64().unwrap())
                        })
                        .collect();
                    assert_eq!(want, got, "{at}: notes");
                }
                if let Some(m) = want.get("melody") {
                    assert_eq!(
                        *m,
                        json!({ "channel": melody.channel, "muted": melody.muted }),
                        "{at}"
                    );
                }
                if let Some(tracks) = want.get("tracks") {
                    let got: Vec<Value> = song
                        .tracks
                        .iter()
                        .flatten()
                        .map(|t| {
                            let mut v = t.to_json();
                            v["pattern"] = json!(t.pattern.id);
                            v
                        })
                        .collect();
                    let tracks = tracks.as_array().unwrap();
                    assert_eq!(tracks.len(), got.len(), "{at}: tracks");
                    for (w, g) in tracks.iter().zip(&got) {
                        assert!(subset(w, g), "{at}: track {g} vs {w}");
                    }
                }
                if let Some(l) = want.get("loop") {
                    let range = state
                        .loop_range
                        .map(|r| json!({ "start": r.start, "end": r.end }));
                    assert!(
                        subset(l, &json!({ "enabled": state.looping, "range": range })),
                        "{at}: loop"
                    );
                }
            }
        }
    }

    #[test]
    fn parses_like_the_zod_schemas() {
        let ok = [
            json!({ "op": "appendChord", "token": "V7/vi" }),
            json!({ "op": "setKey", "tonic": "F#", "mode": "phrygianDominant" }),
            json!({ "op": "addNote", "beat": 4095, "length": 0.25, "degree": 7, "octave": -3, "accidental": 1 }),
            json!({ "op": "setTrack", "track": "trk-abc", "gate": 1, "transpose": -24 }),
            json!({ "op": "setLoop", "range": null }),
            json!({ "op": "select", "index": null }),
            json!({ "op": "setInstrument", "track": "melody", "instrument": "lead" }),
            json!({ "op": "play", "from": 2.5 }),
            json!({ "op": "setTempo", "bpm": 90.0 }),
        ];
        for v in ok {
            assert!(parse_command(&v).is_ok(), "{v}");
        }
        let bad = [
            (json!(null), ""),
            (json!({}), "op"),
            (json!({ "op": "transpose" }), "op"),
            (json!({ "op": "appendChord" }), "token"),
            (
                json!({ "op": "appendChord", "token": "I", "beats": 0 }),
                "beats",
            ),
            (
                json!({ "op": "appendChord", "token": "I", "beats": 1.1 }),
                "beats",
            ),
            (
                json!({ "op": "appendChord", "token": "I", "extra": true }),
                "extra",
            ),
            (
                json!({ "op": "replaceChord", "index": -1, "token": "I" }),
                "index",
            ),
            (json!({ "op": "setKey", "tonic": "H" }), "tonic"),
            (json!({ "op": "setKey", "mode": "ionian" }), "mode"),
            (json!({ "op": "setTempo", "bpm": 90.5 }), "bpm"),
            (json!({ "op": "setMeter", "beats": 4, "unit": 3 }), "unit"),
            (
                json!({ "op": "setNotes", "notes": [{ "beat": 0, "length": 1, "degree": 0 }] }),
                "notes[0].degree",
            ),
            (
                json!({ "op": "setChords", "chords": [{ "token": "I", "beats": 4 }, { "token": "I" }] }),
                "chords[1].beats",
            ),
            (json!({ "op": "setTrack", "track": 0, "gate": 0 }), "gate"),
            (json!({ "op": "setTrack", "track": -1 }), "track"),
            (
                json!({ "op": "setLoop", "range": { "start": 4, "end": 4 } }),
                "range.end",
            ),
            (json!({ "op": "select" }), "index"),
            (json!({ "op": "play", "from": -1 }), "from"),
        ];
        for (v, path) in bad {
            let (_, p) = parse_command(&v).unwrap_err();
            assert_eq!(
                (p.code, p.path.as_str()),
                ("invalid", path),
                "{v}: {}",
                p.message
            );
        }
        let many = Value::Array(vec![json!({ "op": "undo" }); MAX_COMMANDS + 1]);
        assert_eq!(parse_commands(&many).unwrap_err().code, "invalid");
    }

    #[test]
    fn instruments_are_not_supported_here() {
        let mut state = EngineState {
            song: create_song(),
            selected: None,
            looping: false,
            loop_range: None,
            undo: Vec::new(),
            redo: Vec::new(),
        };
        let input = json!({ "op": "setInstrument", "track": 0, "instrument": "piano" });
        assert_eq!(
            prepare(&state, &input, false).unwrap_err().code,
            "unsupported"
        );
        let play = step(&mut state, &Command::Play { from: None })
            .err()
            .unwrap();
        assert_eq!(play.code, "failed");
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"MT"), "TVQ=");
        assert_eq!(
            base64(&[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]),
            "TVRoZAAAAAY="
        );
    }
}
