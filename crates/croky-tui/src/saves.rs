//! SaveStore records on disk (`docs/specs/savestore-v1.md`): the same `schema_version: 1`
//! record the web app keeps in IndexedDB and the Worker keeps in R2, one pretty-printed JSON file
//! per record (`<dir>/<id>.json`). `parse_save_record` checks a value exactly as the web's
//! `parseSaveRecord` (same field paths and messages); `DirSaveStore` implements `list`, `get`,
//! `put` (optimistic concurrency: version must be the stored version + 1) and `delete`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use croky_core::json::to_js_json;
use croky_core::{validate_song, Song};
use serde_json::{json, Map, Value};

pub const SAVE_SCHEMA_VERSION: u64 = 1;
/// Longest record title, in UTF-16 code units as in the web app.
pub const MAX_SAVE_TITLE_LENGTH: usize = 200;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, PartialEq)]
pub struct SaveRecord {
    pub id: String,
    /// Monotonic per id: 1 for the first save, previous + 1 after that.
    pub version: u64,
    /// ISO 8601 UTC timestamp of the save.
    pub updated_at: String,
    /// `song.title`, cut to `MAX_SAVE_TITLE_LENGTH`.
    pub title: String,
    pub song: Song,
}

/// A record without its song: what `list` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct SaveSummary {
    pub id: String,
    pub version: u64,
    pub updated_at: String,
    pub title: String,
}

/// A value that is not a valid record; `path` names the field ('' for the whole value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveRecordError {
    pub path: String,
    pub reason: String,
}

impl std::fmt::Display for SaveRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.reason)
        } else {
            write!(f, "{}: {}", self.path, self.reason)
        }
    }
}

#[derive(Debug)]
pub enum StoreError {
    /// `put` with a version other than the stored version + 1; nothing was written.
    Conflict {
        id: String,
        expected: u64,
        actual: u64,
    },
    Invalid(String),
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Conflict {
                id,
                expected,
                actual,
            } => write!(
                f,
                "version conflict on \"{id}\": expected version {expected}, got {actual}"
            ),
            StoreError::Invalid(e) | StoreError::Io(e) => f.write_str(e),
        }
    }
}

fn err(path: &str, reason: impl Into<String>) -> SaveRecordError {
    SaveRecordError {
        path: path.into(),
        reason: reason.into(),
    }
}

/// 1–64 characters of `[A-Za-z0-9_-]`, safe as a file name.
pub fn is_valid_save_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A fresh random record id: a version-4 UUID, as `crypto.randomUUID` in the web app.
pub fn new_save_id() -> String {
    let mut bytes = [0u8; 16];
    let filled = fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .is_ok();
    if !filled {
        let mut random = croky_core::tracks::default_random();
        for b in &mut bytes {
            *b = (random() * 256.0) as u8;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `Date.prototype.toISOString` of a time: `2026-10-20T12:34:56.789Z`.
pub fn iso_timestamp(time: SystemTime) -> String {
    let ms = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    };
    let (days, ms_of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s, milli) = (
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000,
    );
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Milliseconds since the epoch of a record timestamp
/// (`YYYY-MM-DDTHH:MM:SS[.sss]Z`, fields in range), or `None`.
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        (!part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    if b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let (y, mo, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (h, mi, sec) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    let milli = match &s[19..s.len() - 1] {
        "" => 0,
        frac if frac.len() >= 2 && frac.len() <= 4 && frac.starts_with('.') => {
            let n = digits(20..s.len() - 1)?;
            n * 10_i64.pow(4 - frac.len() as u32)
        }
        _ => return None,
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo) || d < 1 || d > month_days[(mo - 1) as usize] {
        return None;
    }
    if h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    // Days from civil (inverse of civil_from_days).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + milli)
}

/// Cut a title to `MAX_SAVE_TITLE_LENGTH` UTF-16 code units (never inside a character).
pub fn cut_title(title: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in title.chars() {
        units += c.len_utf16();
        if units > MAX_SAVE_TITLE_LENGTH {
            break;
        }
        out.push(c);
    }
    out
}

/// Validate an untrusted value as a record (`parseSaveRecord`): same paths and messages.
pub fn parse_save_record(value: &Value) -> Result<SaveRecord, SaveRecordError> {
    let root = value
        .as_object()
        .ok_or_else(|| err("", "expected an object"))?;
    if root.get("schema_version").and_then(Value::as_f64) != Some(SAVE_SCHEMA_VERSION as f64) {
        return Err(err("schema_version", "expected 1"));
    }
    let id = root
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_valid_save_id(id))
        .ok_or_else(|| err("id", "expected 1-64 characters of [A-Za-z0-9_-]"))?;
    let version = root
        .get("version")
        .and_then(Value::as_f64)
        .filter(|v| v.fract() == 0.0 && *v >= 1.0 && *v <= MAX_SAFE_INTEGER)
        .ok_or_else(|| err("version", "expected an integer >= 1"))?;
    let updated_at = root
        .get("updated_at")
        .and_then(Value::as_str)
        .filter(|t| parse_timestamp(t).is_some())
        .ok_or_else(|| err("updated_at", "expected an ISO 8601 UTC timestamp"))?;
    let title = root
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| t.encode_utf16().count() <= MAX_SAVE_TITLE_LENGTH)
        .ok_or_else(|| {
            err(
                "title",
                format!("expected a string of at most {MAX_SAVE_TITLE_LENGTH}"),
            )
        })?;
    let song = validate_song(root.get("song").unwrap_or(&Value::Null))
        .map_err(|e| err("song", e.to_string()))?;
    Ok(SaveRecord {
        id: id.into(),
        version: version as u64,
        updated_at: updated_at.into(),
        title: title.into(),
        song,
    })
}

impl SaveRecord {
    /// `makeRecord`: a record for `song`, its song in the wire format (`serializeSong`).
    pub fn new(song: &Song, id: &str, version: u64, now: SystemTime) -> SaveRecord {
        SaveRecord {
            id: id.into(),
            version,
            updated_at: iso_timestamp(now),
            title: cut_title(&song.title),
            song: song.clone(),
        }
    }

    pub fn to_value(&self) -> Value {
        let song: Value =
            serde_json::from_str(&self.song.to_json()).expect("serialize_song writes valid JSON");
        let mut obj = Map::new();
        obj.insert("schema_version".into(), json!(SAVE_SCHEMA_VERSION));
        obj.insert("id".into(), json!(self.id));
        obj.insert("version".into(), json!(self.version));
        obj.insert("updated_at".into(), json!(self.updated_at));
        obj.insert("title".into(), json!(self.title));
        obj.insert("song".into(), song);
        Value::Object(obj)
    }

    /// The file contents: the record as 2-space indented JSON with a final newline.
    pub fn to_json(&self) -> String {
        to_js_json(&self.to_value(), true) + "\n"
    }

    pub fn summary(&self) -> SaveSummary {
        SaveSummary {
            id: self.id.clone(),
            version: self.version,
            updated_at: self.updated_at.clone(),
            title: self.title.clone(),
        }
    }
}

/// A record file or a bare song file: what `--song` and the store read.
pub fn parse_file(text: &str) -> Result<FileContent, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    if value.get("schema_version").is_some() {
        parse_save_record(&value)
            .map(FileContent::Record)
            .map_err(|e| e.to_string())
    } else {
        validate_song(&value)
            .map(FileContent::Song)
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum FileContent {
    Record(SaveRecord),
    Song(Song),
}

/// One file per record in a directory. Writes go to a temporary file that is renamed over the
/// record, so a reader never sees half a record. The version check and the rename are not one
/// transaction across processes: two programs saving the same record in the same instant can
/// both pass the check (the web's `localStorage` store has the same limit across tabs).
pub struct DirSaveStore {
    pub dir: PathBuf,
}

impl DirSaveStore {
    pub fn new(dir: impl Into<PathBuf>) -> DirSaveStore {
        DirSaveStore { dir: dir.into() }
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn read(path: &Path) -> Result<Option<SaveRecord>, StoreError> {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StoreError::Io(format!("{}: {e}", path.display()))),
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| StoreError::Invalid(format!("{}: invalid JSON: {e}", path.display())))?;
        parse_save_record(&value)
            .map(Some)
            .map_err(|e| StoreError::Invalid(format!("{}: {e}", path.display())))
    }

    /// Every readable record without its song, newest `updated_at` first, plus the number of
    /// `.json` files that are not valid records (skipped).
    pub fn list(&self) -> Result<(Vec<SaveSummary>, usize), StoreError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
            Err(e) => return Err(StoreError::Io(format!("{}: {e}", self.dir.display()))),
        };
        let mut out = Vec::new();
        let mut bad = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match Self::read(&path) {
                // A record must live in the file named after its id.
                Ok(Some(r)) if path.file_stem().and_then(|s| s.to_str()) == Some(&r.id) => {
                    out.push(r.summary())
                }
                _ => bad += 1,
            }
        }
        out.sort_by(|a, b| {
            let t = |s: &SaveSummary| parse_timestamp(&s.updated_at).unwrap_or(i64::MIN);
            t(b).cmp(&t(a)).then_with(|| a.id.cmp(&b.id))
        });
        Ok((out, bad))
    }

    /// The record, or `None` when there is no such record.
    pub fn get(&self, id: &str) -> Result<Option<SaveRecord>, StoreError> {
        if !is_valid_save_id(id) {
            return Ok(None);
        }
        Self::read(&self.path(id))
    }

    /// Store `record` when its version is the stored version + 1 (a missing record counts as
    /// version 0); otherwise `StoreError::Conflict` and nothing is written.
    pub fn put(&self, record: &SaveRecord) -> Result<(), StoreError> {
        if !is_valid_save_id(&record.id) {
            return Err(StoreError::Invalid(format!("invalid id {:?}", record.id)));
        }
        let current = match Self::read(&self.path(&record.id)) {
            Ok(r) => r.map_or(0, |r| r.version),
            // A corrupt file is replaced only by a first save, as if it were missing.
            Err(StoreError::Invalid(_)) => 0,
            Err(e) => return Err(e),
        };
        if record.version != current + 1 {
            return Err(StoreError::Conflict {
                id: record.id.clone(),
                expected: current + 1,
                actual: record.version,
            });
        }
        write_atomic(&self.path(&record.id), record.to_json())
    }

    /// Delete a record; deleting a missing id is not an error.
    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        if !is_valid_save_id(id) {
            return Ok(());
        }
        match fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e.to_string())),
        }
    }
}

/// Write `contents` to `path` through a temporary file in the same directory and a rename.
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> Result<(), StoreError> {
    let io = |e: std::io::Error| StoreError::Io(format!("{}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(io)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("save");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_ref())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use croky_core::{create_song, SongChord};
    use std::time::Duration;

    fn song() -> Song {
        Song {
            title: "Night drive".into(),
            chords: vec![SongChord {
                token: "vi".into(),
                beats: 4.0,
            }],
            ..create_song()
        }
    }

    const NOW: u64 = 1_792_497_600; // 2026-10-20T12:00:00Z

    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(NOW)
    }

    fn valid() -> Value {
        let mut v = SaveRecord::new(&song(), "abc-123_X", 2, now()).to_value();
        v["updated_at"] = json!("2026-10-20T12:00:00.000Z");
        v
    }

    fn path_of(value: &Value) -> Option<String> {
        parse_save_record(value).err().map(|e| e.path)
    }

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "croky-tui-test-{name}-{}-{}",
            std::process::id(),
            new_save_id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_timestamps_like_to_iso_string() {
        assert_eq!(iso_timestamp(now()), "2026-10-20T12:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(951_782_400_123); // leap day 2000
        assert_eq!(iso_timestamp(t), "2000-02-29T00:00:00.123Z");
        assert_eq!(
            parse_timestamp("2000-02-29T00:00:00.123Z"),
            Some(951_782_400_123)
        );
        assert_eq!(
            parse_timestamp("2026-10-20T12:00:00Z"),
            Some(NOW as i64 * 1000)
        );
        assert_eq!(
            parse_timestamp("2026-10-20T12:00:00.5Z"),
            Some(NOW as i64 * 1000 + 500)
        );
        for bad in [
            "2026-10-20",
            "2026-13-45T99:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-10-20T12:00:00.1234Z",
            "2026-10-20 12:00:00Z",
            "2026-10-20T12:00:00+01:00",
        ] {
            assert_eq!(parse_timestamp(bad), None, "{bad}");
        }
    }

    #[test]
    fn round_trips_a_record_through_json() {
        let record = SaveRecord::new(&song(), "r1", 1, now());
        let text = record.to_json();
        assert!(text.starts_with("{\n  \"schema_version\": 1,\n  \"id\": \"r1\",\n"));
        let again = parse_file(&text).unwrap();
        assert_eq!(again, FileContent::Record(record));
        assert!(matches!(
            parse_file(&song().to_json()),
            Ok(FileContent::Song(_))
        ));
    }

    #[test]
    fn cuts_long_titles_in_utf16_units() {
        let long = "x".repeat(MAX_SAVE_TITLE_LENGTH + 10);
        let record = SaveRecord::new(
            &Song {
                title: long.clone(),
                ..song()
            },
            "r1",
            1,
            now(),
        );
        assert_eq!(record.title.len(), MAX_SAVE_TITLE_LENGTH);
        assert_eq!(record.song.title, long);
        let emoji = format!("{}😀", "x".repeat(MAX_SAVE_TITLE_LENGTH - 1));
        assert_eq!(cut_title(&emoji).len(), MAX_SAVE_TITLE_LENGTH - 1);
    }

    #[test]
    fn rejects_bad_fields_with_the_web_paths() {
        assert_eq!(path_of(&valid()), None);
        assert_eq!(path_of(&Value::Null).as_deref(), Some(""));
        assert_eq!(path_of(&json!([])).as_deref(), Some(""));
        let cases: Vec<(&str, &str, Value)> = vec![
            ("schema_version", "schema_version", json!(2)),
            ("id", "id", json!("")),
            ("id", "id", json!("../etc")),
            ("id", "id", json!("x".repeat(65))),
            ("version", "version", json!(0)),
            ("version", "version", json!(1.5)),
            ("version", "version", json!("2")),
            ("updated_at", "updated_at", json!("2026-10-20")),
            ("updated_at", "updated_at", json!("2026-13-45T99:00:00Z")),
            ("title", "title", json!(3)),
            (
                "title",
                "title",
                json!("x".repeat(MAX_SAVE_TITLE_LENGTH + 1)),
            ),
            ("song", "song", json!({ "schema": 9 })),
        ];
        for (path, field, bad) in cases {
            let mut v = valid();
            v[field] = bad.clone();
            assert_eq!(path_of(&v).as_deref(), Some(path), "{field} = {bad}");
        }
        let mut v = valid();
        v["song"] = json!({ "schema": 9 });
        assert_eq!(
            parse_save_record(&v).unwrap_err().to_string(),
            "song: schema: expected 1, 2, 3 or 4"
        );
    }

    #[test]
    fn ids_are_uuids() {
        let id = new_save_id();
        assert!(is_valid_save_id(&id));
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, new_save_id());
        assert!(!is_valid_save_id("a/b"));
    }

    #[test]
    fn store_checks_versions_lists_newest_first_and_deletes() {
        let dir = temp_dir("store");
        let store = DirSaveStore::new(&dir);
        let r1 = SaveRecord::new(&song(), "one", 1, now());
        store.put(&r1).unwrap();
        // The same version again is a conflict, and nothing is written.
        let err = store.put(&r1).unwrap_err();
        assert!(matches!(
            err,
            StoreError::Conflict {
                expected: 2,
                actual: 1,
                ..
            }
        ));
        assert_eq!(
            err.to_string(),
            "version conflict on \"one\": expected version 2, got 1"
        );
        let later = now() + Duration::from_secs(60);
        let r2 = SaveRecord::new(
            &Song {
                title: "Two".into(),
                ..song()
            },
            "two",
            1,
            later,
        );
        store.put(&r2).unwrap();
        store
            .put(&SaveRecord {
                version: 2,
                ..r1.clone()
            })
            .unwrap();
        fs::write(dir.join("junk.json"), "{}").unwrap();
        let (list, bad) = store.list().unwrap();
        assert_eq!(
            list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["two", "one"]
        );
        assert_eq!(list[1].version, 2);
        assert_eq!(bad, 1);
        assert_eq!(store.get("one").unwrap().unwrap().version, 2);
        assert_eq!(store.get("missing").unwrap(), None);
        store.delete("one").unwrap();
        store.delete("one").unwrap();
        assert_eq!(store.get("one").unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
