//! The song record (`serializeSong` JSON, schema 1 or 2) as far as the prototype needs it:
//! key, tempo, meter and chords. Tracks are kept as raw JSON and written back untouched.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::theory::{parse_note_name, Key, Mode};
use crate::token::{is_rest_token, parse_token};

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SongKey {
    pub tonic: String,
    pub mode: Mode,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Meter {
    pub beats: u32,
    pub unit: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SongChord {
    pub token: String,
    pub beats: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Song {
    pub schema: u32,
    pub title: String,
    pub key: SongKey,
    pub tempo: f64,
    pub meter: Meter,
    pub chords: Vec<SongChord>,
    /// Schema 2 tracks, not interpreted by the port yet.
    #[serde(default)]
    pub tracks: Option<Value>,
}

/// Whole numbers as JSON integers (`96`, not `96.0`), as `JSON.stringify` writes them.
fn number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

#[derive(Debug)]
pub struct SongError(pub String);

impl std::fmt::Display for SongError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SongError {}

impl Song {
    /// Parse JSON and check what the prototype relies on (a subset of `validateSong`).
    pub fn from_json(json: &str) -> Result<Song, SongError> {
        let song: Song = serde_json::from_str(json).map_err(|e| SongError(format!("song: {e}")))?;
        if !(song.schema == 1 || song.schema == 2) {
            return Err(SongError("schema: expected 1 or 2".into()));
        }
        if parse_note_name(&song.key.tonic).is_none() {
            return Err(SongError(format!(
                "key.tonic: invalid note name \"{}\"",
                song.key.tonic
            )));
        }
        if !(song.tempo > 0.0 && song.tempo <= 1000.0) {
            return Err(SongError("tempo: must be in (0, 1000]".into()));
        }
        for (i, c) in song.chords.iter().enumerate() {
            if c.beats.is_nan() || c.beats <= 0.0 || (c.beats * 8.0).fract() != 0.0 {
                return Err(SongError(format!(
                    "chords.{i}.beats: must be > 0 on the 1/8 grid"
                )));
            }
            if !is_rest_token(&c.token) {
                parse_token(&c.token).map_err(|e| SongError(format!("chords.{i}.token: {e}")))?;
            }
        }
        Ok(song)
    }

    /// JSON in the `serializeSong` key order (2-space indented).
    pub fn to_json(&self) -> String {
        let mut value = json!({
            "schema": if self.tracks.is_some() { 2 } else { 1 },
            "title": self.title,
            "key": { "tonic": self.key.tonic, "mode": self.key.mode.name() },
            "tempo": number(self.tempo),
            "meter": { "beats": self.meter.beats, "unit": self.meter.unit },
            "chords": self.chords.iter().map(|c| json!({ "token": c.token, "beats": number(c.beats) })).collect::<Vec<_>>(),
        });
        if let (Some(tracks), Some(obj)) = (&self.tracks, value.as_object_mut()) {
            obj.insert("tracks".into(), tracks.clone());
        }
        serde_json::to_string_pretty(&value).unwrap_or_default()
    }

    pub fn key(&self) -> Key {
        Key {
            tonic: parse_note_name(&self.key.tonic).unwrap_or(0),
            mode: self.key.mode,
        }
    }

    /// Tokens in order, rests removed (the context for `suggest_next`).
    pub fn tokens(&self) -> Vec<String> {
        self.chords
            .iter()
            .filter(|c| !is_rest_token(&c.token))
            .map(|c| c.token.clone())
            .collect()
    }

    pub fn total_beats(&self) -> f64 {
        self.chords.iter().fold(0.0, |sum, c| sum + c.beats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str = r#"{"schema":1,"title":"T","key":{"tonic":"Eb","mode":"minor"},
        "tempo":96,"meter":{"beats":4,"unit":4},
        "chords":[{"token":"i","beats":4},{"token":"rest","beats":2},{"token":"bVI","beats":2}]}"#;

    #[test]
    fn reads_a_schema_1_song() {
        let song = Song::from_json(SONG).unwrap();
        assert_eq!(song.key().tonic, 3);
        assert_eq!(song.tokens(), vec!["i", "bVI"]);
        assert_eq!(song.total_beats(), 8.0);
        let again = Song::from_json(&song.to_json()).unwrap();
        assert_eq!(again, song);
    }

    #[test]
    fn writes_what_serialize_song_writes() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../croky-tui/songs/demo.json");
        let json = std::fs::read_to_string(path).unwrap();
        assert_eq!(Song::from_json(&json).unwrap().to_json() + "\n", json);
    }

    #[test]
    fn rejects_bad_chords() {
        let bad = SONG.replace("bVI", "bVIx");
        assert!(Song::from_json(&bad).is_err());
    }
}
