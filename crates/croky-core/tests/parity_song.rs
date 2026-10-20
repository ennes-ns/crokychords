//! Parity of the song record with `progression.ts`: `validateSong` (every error path and
//! message in the golden), the normalised `serializeSong` text byte for byte, and the helpers.

mod common;

use common::{golden, js, set_path, str_of};
use croky_core::song::validate_song_with;
use croky_core::{serialize_song, Song};
use serde_json::{json, Value};

/// A random source that is deterministic for the test but never consulted for the output
/// (schema-1 ids are masked on both sides).
fn random() -> impl FnMut() -> f64 {
    let mut x = 0.0_f64;
    move || {
        x = (x + 0.618_033_988_749_895) % 1.0;
        x
    }
}

fn chord_at(song: &Song) -> Value {
    let beats = [-1.0, 0.0, 3.75, 4.0, 5.5, 6.0, 7.75, 8.0, f64::MAX];
    Value::Array(
        beats
            .iter()
            .map(|&beat| {
                let at = song.chord_at_beat(beat).map(|a| json!([a.index, a.start]));
                json!([beat, at])
            })
            .collect(),
    )
}

#[test]
fn validate_and_serialize_match_typescript() {
    let lines = golden("songs.jsonl");
    let base = lines[0]["base"].clone();
    let (mut valid, mut invalid) = (0, 0);
    for line in &lines[1..] {
        let label = str_of(line, "label");
        let input = match line.get("mutation") {
            Some(m) => {
                let mut input = base.clone();
                let path = m[0].as_str().unwrap();
                set_path(&mut input, path, m.get(1).cloned());
                input
            }
            None => line["input"].clone(),
        };
        let result = validate_song_with(&input, &mut random());
        if let Some(path) = line.get("path") {
            let err = result.expect_err(label);
            assert_eq!(err.path, path.as_str().unwrap(), "{label}");
            assert_eq!(err.to_string(), str_of(line, "message"), "{label}");
            invalid += 1;
            continue;
        }
        let mut song = result.unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(song.schema, 3, "{label}");
        if line["masked"] == json!(true) {
            for (n, t) in song.tracks.iter_mut().flatten().enumerate() {
                assert!(t.id.len() == 12 && t.id.starts_with("trk-"), "{label}");
                t.id = format!("trk-masked{n}");
            }
        }
        assert_eq!(serialize_song(&song), str_of(line, "output"), "{label}");
        assert_eq!(
            js(&json!(song.total_beats())),
            js(&line["totalBeats"]),
            "{label}"
        );
        assert_eq!(json!(song.tokens()), line["tokens"], "{label}");
        assert_eq!(js(&chord_at(&song)), js(&line["chordAt"]), "{label}");
        // What serialize_song writes reads back to the same song.
        let again = Song::from_json(&serialize_song(&song)).unwrap();
        assert_eq!(serialize_song(&again), serialize_song(&song), "{label}");
        valid += 1;
    }
    assert!(
        valid >= 50 && invalid >= 150,
        "{valid} valid, {invalid} invalid"
    );
}

#[test]
fn melody_note_limit() {
    let lines = golden("songs.jsonl");
    let mut input = lines[0]["base"].clone();
    let notes: Vec<Value> = (0..4097)
        .map(|n| json!({"beat": n, "length": 1, "degree": 1, "octave": 0, "accidental": 0}))
        .collect();
    input["melody"]["notes"] = Value::Array(notes[..4096].to_vec());
    assert!(validate_song_with(&input, &mut random()).is_ok());
    input["melody"]["notes"] = Value::Array(notes);
    let err = validate_song_with(&input, &mut random()).unwrap_err();
    assert_eq!(err.to_string(), "melody.notes: at most 4096 notes");
}

#[test]
fn json_syntax_errors_have_the_root_path() {
    let err = Song::from_json("{\"schema\": 3,").unwrap_err();
    assert_eq!(err.path, "");
    assert!(err.reason.starts_with("invalid JSON: "));
}
