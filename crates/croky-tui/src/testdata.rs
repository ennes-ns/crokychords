//! Shared test inputs: the committed default table and a small C major song.

use croky_core::{NgramTable, Song};

pub fn table() -> NgramTable {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/web/public/data/default.json"
    );
    NgramTable::from_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn song() -> Song {
    Song::from_json(
        r#"{"schema":1,"title":"Axis","key":{"tonic":"C","mode":"major"},"tempo":120,
        "meter":{"beats":4,"unit":4},"chords":[{"token":"I","beats":4},{"token":"V","beats":4},
        {"token":"vi","beats":4},{"token":"IV","beats":4}]}"#,
    )
    .unwrap()
}
