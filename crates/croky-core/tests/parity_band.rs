//! Parity of the band with `tracks.ts`, `patterns.ts`, `render.ts` and `midi.ts`: presets,
//! role defaults, track ids, pattern layout, rendered note events and `.mid` files byte for byte.

mod common;

use common::{events_json, f64_of, golden, js, read_bytes, replay, str_of, usize_of};
use croky_core::patterns::{create_track, role_defaults, TrackOverrides, DEFAULT_GATE};
use croky_core::{
    default_tracks, layout_pattern, melody_note_harmony, new_pattern_id, new_track_id,
    pattern_description, pattern_preset, pattern_presets, pattern_roles, render_melody,
    render_song, render_track, song_to_midi, validate_song, MidiOptions, Pattern, RenderOptions,
    Song, Track, TrackRole, TrackVoicing,
};
use serde_json::{json, Value};

fn role(name: &str) -> TrackRole {
    TrackRole::from_name(name).unwrap_or_else(|| panic!("role {name}"))
}

fn roles_json(roles: &[TrackRole]) -> Value {
    json!(roles.iter().map(|r| r.name()).collect::<Vec<_>>())
}

/// `Partial<Omit<Track, 'role'>>` from JSON.
fn overrides(v: &Value) -> TrackOverrides {
    let int = |f: &str| v.get(f).and_then(Value::as_i64).map(|x| x as i32);
    TrackOverrides {
        id: v.get("id").and_then(Value::as_str).map(str::to_string),
        name: v.get("name").and_then(Value::as_str).map(str::to_string),
        channel: int("channel"),
        octave: int("octave"),
        voicing: v
            .get("voicing")
            .and_then(Value::as_str)
            .and_then(TrackVoicing::from_name),
        pattern: v.get("pattern").map(|p| Pattern::from_value(p).unwrap()),
        velocity: int("velocity"),
        gate: v.get("gate").and_then(Value::as_f64),
        muted: v.get("muted").and_then(Value::as_bool),
        transpose: int("transpose"),
    }
}

#[test]
fn tracks_and_presets_match_typescript() {
    let mut presets = 0;
    for line in golden("tracks.jsonl") {
        match str_of(&line, "kind") {
            "preset" => {
                let want = &line["pattern"];
                let got = pattern_presets()[presets];
                assert_eq!(js(&got.to_json()), js(want));
                assert_eq!(&pattern_preset(&got.id).unwrap(), got);
                assert_eq!(roles_json(pattern_roles(&got.id)), line["roles"]);
                assert_eq!(pattern_description(&got.id), str_of(&line, "description"));
                presets += 1;
            }
            "presetRoles" => {
                assert_eq!(
                    roles_json(pattern_roles(str_of(&line, "id"))),
                    line["roles"]
                );
            }
            "roleDefaults" => {
                let d = role_defaults(role(str_of(&line, "role")));
                let got = json!({"name": d.name, "octave": d.octave, "pattern": d.pattern, "velocity": d.velocity});
                assert_eq!(js(&got), js(&line["defaults"]));
            }
            "defaultGate" => assert_eq!(DEFAULT_GATE, f64_of(&line, "value")),
            "presetError" => {
                let err = pattern_preset(str_of(&line, "id")).unwrap_err();
                assert_eq!(err.to_string(), str_of(&line, "message"));
            }
            "newTrackId" => {
                assert_eq!(new_track_id(&mut replay(&line)), str_of(&line, "id"));
            }
            "newPatternId" => {
                assert_eq!(new_pattern_id(&mut replay(&line)), str_of(&line, "id"));
            }
            "createTrack" => {
                let track = create_track(
                    role(str_of(&line, "role")),
                    overrides(&line["overrides"]),
                    &mut replay(&line),
                );
                assert_eq!(js(&track.to_json()), js(&line["track"]), "{line}");
            }
            "defaultTracks" => {
                let tracks: Vec<Value> = default_tracks(&mut replay(&line))
                    .iter()
                    .map(Track::to_json)
                    .collect();
                assert_eq!(js(&json!(tracks)), js(&line["tracks"]));
            }
            other => panic!("unknown kind {other}"),
        }
    }
    assert_eq!(presets, pattern_presets().len());
}

#[test]
fn rendering_matches_typescript() {
    let lines = golden("render.jsonl");
    let mut patterns: Vec<Pattern> = Vec::new();
    let mut songs: Vec<Song> = Vec::new();
    let mut settings: Vec<Value> = Vec::new();
    let mut counts = [0usize; 5];
    for line in &lines {
        match str_of(line, "kind") {
            "pattern" => {
                let p = Pattern::from_value(&line["pattern"]).unwrap();
                assert_eq!(js(&p.to_json()), js(&line["pattern"]));
                patterns.push(p);
            }
            "layout" => {
                let pattern = &patterns[usize_of(line, "pattern")];
                let got: Vec<Value> = layout_pattern(pattern, f64_of(line, "beats"))
                    .iter()
                    .map(|o| json!([o.at, o.length, o.step_index]))
                    .collect();
                assert_eq!(js(&json!(got)), js(&line["occurrences"]), "{line}");
                counts[0] += 1;
            }
            "song" => songs.push(validate_song(&line["song"]).unwrap()),
            "settings" => settings = line["settings"].as_array().unwrap().clone(),
            "track" => {
                let pattern = &patterns[usize_of(line, "pattern")];
                let mut setting = settings[usize_of(line, "setting")].clone();
                setting["id"] = line["id"].clone();
                setting["pattern"] = pattern.to_json();
                let track_role = pattern_roles(&pattern.id)
                    .first()
                    .copied()
                    .unwrap_or(TrackRole::Custom);
                let track = create_track(track_role, overrides(&setting), &mut || 0.0);
                let opts = RenderOptions {
                    include_muted: line["includeMuted"] == json!(true),
                };
                let events = render_track(&songs[usize_of(line, "song")], &track, opts);
                assert!(events.iter().all(|e| e.track_id == track.id));
                assert_eq!(
                    js(&events_json(&events, false)),
                    js(&line["events"]),
                    "track {} pattern {} setting {}",
                    line["id"],
                    pattern.name,
                    line["setting"]
                );
                counts[1] += 1;
            }
            "band" => {
                let tracks: Vec<Track> = line["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| Track::from_value(t).unwrap())
                    .collect();
                let opts = RenderOptions {
                    include_muted: line["includeMuted"] == json!(true),
                };
                let events = render_song(&songs[usize_of(line, "song")], &tracks, opts);
                assert_eq!(js(&events_json(&events, true)), js(&line["events"]));
                counts[2] += 1;
            }
            "melody" => {
                let song = validate_song(&line["song"]).unwrap();
                let melody = song.melody.as_ref().unwrap();
                let harmony: Vec<&str> = melody
                    .notes
                    .iter()
                    .map(|n| melody_note_harmony(&song, n).name())
                    .collect();
                assert_eq!(json!(harmony), line["harmony"]);
                let plain = render_melody(&song, RenderOptions::default());
                assert_eq!(js(&events_json(&plain, true)), js(&line["events"]));
                let all = render_melody(
                    &song,
                    RenderOptions {
                        include_muted: true,
                    },
                );
                assert_eq!(js(&events_json(&all, true)), js(&line["eventsWithMuted"]));
                counts[3] += 1;
            }
            other => panic!("unknown kind {other}"),
        }
    }
    assert!(counts[0] >= 200 && counts[1] >= 200 && counts[2] == 6 && counts[3] == 3);
    // Muted tracks render nothing without include_muted.
    let song = &songs[0];
    let mut track = create_track(TrackRole::Bass, TrackOverrides::default(), &mut || 0.5);
    assert!(!render_track(song, &track, RenderOptions::default()).is_empty());
    track.muted = true;
    assert!(render_track(song, &track, RenderOptions::default()).is_empty());
}

fn midi_options(v: &Value) -> MidiOptions {
    MidiOptions {
        ppq: v.get("ppq").and_then(Value::as_f64),
        channel: v.get("channel").and_then(Value::as_f64),
        velocity: v.get("velocity").and_then(Value::as_f64),
        bass_octave: v
            .get("bassOctave")
            .and_then(Value::as_i64)
            .map(|x| x as i32),
        octave: v.get("octave").and_then(Value::as_i64).map(|x| x as i32),
        gate: v.get("gate").and_then(Value::as_f64),
        track_name: v
            .get("trackName")
            .and_then(Value::as_str)
            .map(str::to_string),
        include_muted: v.get("includeMuted") == Some(&json!(true)),
    }
}

#[test]
fn midi_files_are_byte_identical() {
    let mut files = 0;
    for line in golden("midi.jsonl") {
        let name = str_of(&line, "name");
        let input = &line["song"];
        let mut song = validate_song(input).unwrap_or_else(|e| panic!("{name}: {e}"));
        if input.get("tracks").is_none() {
            // A schema-1 object: format 0.
            song.tracks = None;
            song.melody = None;
        }
        match line.get("patch").and_then(Value::as_str) {
            Some("track0Channel16") => song.tracks.as_mut().unwrap()[0].channel = 16,
            Some("track0Velocity0") => song.tracks.as_mut().unwrap()[0].velocity = 0,
            Some(other) => panic!("unknown patch {other}"),
            None => {}
        }
        let result = song_to_midi(&song, &midi_options(&line["opts"]));
        if let Some(error) = line.get("error") {
            assert_eq!(
                result.unwrap_err().to_string(),
                error.as_str().unwrap(),
                "{name}"
            );
            continue;
        }
        let want = read_bytes(&format!(
            "crates/croky-core/tests/golden/{}",
            str_of(&line, "file")
        ));
        let got = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            got == want,
            "{name}: {} bytes, want {}",
            got.len(),
            want.len()
        );
        files += 1;
    }
    assert!(files >= 15, "{files} files");
}
