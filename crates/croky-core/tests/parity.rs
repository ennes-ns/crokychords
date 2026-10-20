//! Cross-language parity with `packages/core`: the shared token fixture must round-trip, and
//! chord names, voicings and suggestions must match the golden output of the TS code.

use std::fs;
use std::path::PathBuf;

use croky_core::theory::parse_note_name;
use croky_core::{
    chord_name, format_token, parse_token, suggest_next, voice_chord, Key, Mode, NgramTable,
    SuggestOptions,
};
use serde_json::Value;

fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn read(path: &str) -> String {
    fs::read_to_string(repo(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn fixture_tokens_round_trip_byte_for_byte() {
    let fixture: Value =
        serde_json::from_str(&read("packages/core/test/fixtures/tokens-roman-v1.json")).unwrap();
    let modes = fixture.as_object().unwrap();
    assert_eq!(modes.len(), 9);
    let mut failures = Vec::new();
    let mut count = 0;
    for (mode, tokens) in modes {
        assert!(Mode::from_name(mode).is_some(), "unknown mode {mode}");
        for token in tokens.as_array().unwrap() {
            let token = token.as_str().unwrap();
            count += 1;
            match parse_token(token).map(|c| format_token(&c)) {
                Ok(Ok(back)) if back == token => {}
                other => failures.push(format!("{mode} {token}: {other:?}")),
            }
        }
    }
    assert!(count > 2000);
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn chord_names_and_voicings_match_typescript() {
    let golden = read("crates/croky-core/tests/golden/chords.jsonl");
    let mut checked = 0;
    for line in golden.lines() {
        let g: Value = serde_json::from_str(line).unwrap();
        let token = g["token"].as_str().unwrap();
        let key = Key {
            tonic: parse_note_name(g["tonic"].as_str().unwrap()).unwrap(),
            mode: Mode::from_name(g["mode"].as_str().unwrap()).unwrap(),
        };
        let chord = parse_token(token).unwrap();
        assert_eq!(
            chord_name(&chord, key),
            g["name"].as_str().unwrap(),
            "{line}"
        );
        let notes: Vec<i32> = serde_json::from_value(g["notes"].clone()).unwrap();
        assert_eq!(voice_chord(&chord, key, 2, 4), notes, "{line}");
        checked += 1;
    }
    assert_eq!(checked, 2074);
}

#[test]
fn suggestions_match_typescript_on_the_default_table() {
    let table = NgramTable::from_json(&read("apps/web/public/data/default.json")).unwrap();
    let golden = read("crates/croky-core/tests/golden/suggest.jsonl");
    let opts = SuggestOptions {
        limit: 8,
        ..SuggestOptions::default()
    };
    for line in golden.lines() {
        let g: Value = serde_json::from_str(line).unwrap();
        let mode = Mode::from_name(g["mode"].as_str().unwrap()).unwrap();
        let context: Vec<String> = serde_json::from_value(g["context"].clone()).unwrap();
        let got = suggest_next(&table, mode, &context, opts);
        let want = g["suggestions"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{line}");
        for (s, w) in got.iter().zip(want) {
            assert_eq!(s.token, w["token"].as_str().unwrap(), "{line}");
            assert_eq!(s.count, w["count"].as_f64().unwrap(), "{line}");
            assert!((s.probability - w["probability"].as_f64().unwrap()).abs() < 1e-12);
            let used: Vec<String> = serde_json::from_value(w["contextUsed"].clone()).unwrap();
            assert_eq!(s.context_used, used, "{line}");
        }
    }
}
