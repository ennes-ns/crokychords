//! Cross-language parity with `packages/core`: the shared token fixture must round-trip, and
//! chord names, voicings, token errors, diatonic triads, suggestions (with filter and the seed
//! table) must match the golden output of the TS code.

use std::fs;
use std::path::PathBuf;

use croky_core::theory::parse_note_name;
use croky_core::{
    chord_name, diatonic_quality, diatonic_triad_token, format_token, is_diatonic_token,
    parse_token, popular_chords, seed_table, suggest_next, voice_chord, Key, Mode, NgramTable,
    PopularOptions, SuggestOptions,
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

fn golden_lines(name: &str) -> Vec<Value> {
    read(&format!("crates/croky-core/tests/golden/{name}"))
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn token_errors_match_typescript_including_positions() {
    let lines = golden_lines("token-errors.jsonl");
    assert!(lines.len() > 200);
    for g in lines {
        let token = g["token"].as_str().unwrap();
        let err = parse_token(token).expect_err(token);
        assert_eq!(err.to_string(), g["message"].as_str().unwrap(), "{token}");
    }
}

#[test]
fn diatonic_triads_and_membership_match_typescript() {
    let lines = golden_lines("diatonic.jsonl");
    let tokens: Vec<String> = serde_json::from_value(lines[0]["tokens"].clone()).unwrap();
    for g in &lines[1..] {
        let mode = Mode::from_name(g["mode"].as_str().unwrap()).unwrap();
        let qualities: Vec<String> = serde_json::from_value(g["qualities"].clone()).unwrap();
        let triads: Vec<String> = serde_json::from_value(g["triads"].clone()).unwrap();
        for degree in 1..=7u8 {
            let i = usize::from(degree - 1);
            let quality = format!("{:?}", diatonic_quality(degree, mode)).to_lowercase();
            assert_eq!(quality, qualities[i], "{mode:?} {degree}");
            assert_eq!(diatonic_triad_token(degree, mode), triads[i]);
        }
        let got: String = tokens
            .iter()
            .map(|t| if is_diatonic_token(t, mode) { '1' } else { '0' })
            .collect();
        assert_eq!(got, g["diatonic"].as_str().unwrap(), "{mode:?}");
    }
    assert_eq!(lines.len(), 1 + Mode::ALL.len());
}

#[test]
fn popular_chords_and_filtered_suggestions_match_typescript() {
    let default = NgramTable::from_json(&read("apps/web/public/data/default.json")).unwrap();
    for g in golden_lines("popular.jsonl") {
        let table = match g["table"].as_str().unwrap() {
            "seed" => seed_table(),
            _ => &default,
        };
        let mode = Mode::from_name(g["mode"].as_str().unwrap()).unwrap();
        let diatonic = |t: &str| is_diatonic_token(t, mode);
        let filter: Option<&dyn Fn(&str) -> bool> = if g["diatonic"] == Value::Bool(true) {
            Some(&diatonic)
        } else {
            None
        };
        let limit = g["limit"].as_u64().unwrap() as usize;
        let got = if g["kind"] == "popular" {
            popular_chords(table, mode, PopularOptions { limit, filter })
        } else {
            let context: Vec<String> = serde_json::from_value(g["context"].clone()).unwrap();
            let opts = SuggestOptions {
                limit,
                filter,
                ..SuggestOptions::default()
            };
            suggest_next(table, mode, &context, opts)
        };
        let want = g["suggestions"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{g}");
        for (s, w) in got.iter().zip(want) {
            assert_eq!(s.token, w["token"].as_str().unwrap(), "{g}");
            assert_eq!(s.count, w["count"].as_f64().unwrap(), "{g}");
            assert!((s.probability - w["probability"].as_f64().unwrap()).abs() < 1e-12);
            let used: Vec<String> = serde_json::from_value(w["contextUsed"].clone()).unwrap();
            assert_eq!(s.context_used, used, "{g}");
        }
    }
}

#[test]
fn the_seed_table_is_the_typescript_one() {
    assert_eq!(
        read("crates/croky-core/data/seed-ngrams.json"),
        read("packages/core/src/data/seed-ngrams.json"),
        "copy packages/core/src/data/seed-ngrams.json to crates/croky-core/data/"
    );
    let seed = seed_table();
    assert_eq!(seed.source.name, "seed");
    assert!(seed.mode(Mode::Major).is_some() && seed.mode(Mode::Minor).is_some());
}
