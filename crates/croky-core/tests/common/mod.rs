//! Helpers shared by the parity tests: reading the goldens generated from `packages/core`.

#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use croky_core::json::to_js_json;
use croky_core::NoteEvent;
use serde_json::{json, Value};

pub fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

pub fn read(path: &str) -> String {
    fs::read_to_string(repo(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

pub fn read_bytes(path: &str) -> Vec<u8> {
    fs::read(repo(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The lines of `crates/croky-core/tests/golden/<name>` as JSON values.
pub fn golden(name: &str) -> Vec<Value> {
    read(&format!("crates/croky-core/tests/golden/{name}"))
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{name}: {e}: {l}")))
        .collect()
}

/// Compact `JSON.stringify` text, to compare values regardless of int/float representation.
pub fn js(value: &Value) -> String {
    to_js_json(value, false)
}

pub fn str_of<'a>(v: &'a Value, field: &str) -> &'a str {
    v[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} in {v}"))
}

pub fn f64_of(v: &Value, field: &str) -> f64 {
    v[field]
        .as_f64()
        .unwrap_or_else(|| panic!("{field} in {v}"))
}

pub fn usize_of(v: &Value, field: &str) -> usize {
    v[field]
        .as_u64()
        .unwrap_or_else(|| panic!("{field} in {v}")) as usize
}

/// The recorded `randoms` of a golden line as a random source (0 once they run out).
pub fn replay(v: &Value) -> impl FnMut() -> f64 {
    let values: Vec<f64> = serde_json::from_value(v["randoms"].clone()).unwrap();
    let mut it = values.into_iter();
    move || it.next().unwrap_or(0.0)
}

/// Events as the compact arrays of the goldens: [trackId?, channel, note, velocity, start,
/// duration].
pub fn events_json(events: &[NoteEvent], with_track_id: bool) -> Value {
    Value::Array(
        events
            .iter()
            .map(|e| {
                let mut row = vec![
                    json!(e.channel),
                    json!(e.note),
                    json!(e.velocity),
                    json!(e.start),
                    json!(e.duration),
                ];
                if with_track_id {
                    row.insert(0, json!(e.track_id));
                }
                Value::Array(row)
            })
            .collect(),
    )
}

/// The generator's `setPath`: set (or with `None` remove) the value at 'a.0.b'.
pub fn set_path(root: &mut Value, path: &str, value: Option<Value>) {
    if path.is_empty() {
        *root = value.unwrap_or(Value::Null);
        return;
    }
    let parts: Vec<&str> = path.split('.').collect();
    let (last, init) = parts.split_last().unwrap();
    let mut node = root;
    for part in init {
        node = match node {
            Value::Array(items) => &mut items[part.parse::<usize>().unwrap()],
            other => &mut other[*part],
        };
    }
    match (node, value) {
        (Value::Array(items), None) => {
            items.remove(last.parse::<usize>().unwrap());
        }
        (Value::Array(items), Some(v)) => items[last.parse::<usize>().unwrap()] = v,
        (Value::Object(map), None) => {
            map.shift_remove(*last);
        }
        (Value::Object(map), Some(v)) => {
            map.insert((*last).into(), v);
        }
        (other, _) => panic!("cannot set {path} in {other}"),
    }
}
