//! Where the open song is saved (`docs/specs/savestore-v1.md`, "Editor wiring"): a record in
//! the `DirSaveStore`, autosaved after the last change with `put(version + 1)` and saved as a
//! copy on a version conflict, or a file named with `--song` (written only with `w`). Also keeps
//! the per-device TUI state next to the saves: the id of the open record and the loop of every
//! record (`docs/specs/loop-v1.md`: UI state, not part of the song).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use croky_core::json::to_js_json;
use croky_core::{create_song, Song};
use serde_json::{json, Map, Value};

use crate::edit::LoopRange;
use crate::saves::{
    new_save_id, parse_file, write_atomic, DirSaveStore, FileContent, SaveRecord, SaveSummary,
    StoreError, MAX_SAVE_TITLE_LENGTH,
};

pub const CONFLICT_SUFFIX: &str = " (copy)";
pub const STATE_SCHEMA_VERSION: u64 = 1;

/// `conflictTitle`: the title of the copy that keeps the local version after a conflict.
pub fn conflict_title(title: &str) -> String {
    let keep = MAX_SAVE_TITLE_LENGTH - CONFLICT_SUFFIX.len();
    let mut out = String::new();
    let mut units = 0;
    for c in title.chars() {
        units += c.len_utf16();
        if units > keep {
            break;
        }
        out.push(c);
    }
    out + CONFLICT_SUFFIX
}

/// The loop of a song as the TUI keeps it (`StoredLoop` of the web app).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopState {
    pub enabled: bool,
    pub range: Option<LoopRange>,
}

impl Default for LoopState {
    fn default() -> Self {
        LoopState {
            enabled: true,
            range: None,
        }
    }
}

impl LoopState {
    fn to_value(self) -> Value {
        json!({
            "schema_version": STATE_SCHEMA_VERSION,
            "enabled": self.enabled,
            "startBeat": self.range.map(|r| r.start),
            "endBeat": self.range.map(|r| r.end),
        })
    }

    /// `parseLoop`: `None` for anything that is not a valid stored loop.
    fn from_value(v: &Value) -> Option<LoopState> {
        if v.get("schema_version")?.as_f64()? != STATE_SCHEMA_VERSION as f64 {
            return None;
        }
        let enabled = v.get("enabled")?.as_bool()?;
        let (start, end) = (v.get("startBeat")?, v.get("endBeat")?);
        if start.is_null() && end.is_null() {
            return Some(LoopState {
                enabled,
                range: None,
            });
        }
        let (start, end) = (start.as_f64()?, end.as_f64()?);
        (start >= 0.0 && end > start).then_some(LoopState {
            enabled,
            range: Some(LoopRange { start, end }),
        })
    }
}

/// Per-device state in `tui-state.json`: the open record and the loop per record.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeviceState {
    pub current: Option<String>,
    pub loops: BTreeMap<String, LoopState>,
}

impl DeviceState {
    /// Read the state; a missing or unreadable file is an empty state (it is only UI state).
    pub fn load(path: &PathBuf) -> DeviceState {
        let Ok(text) = fs::read_to_string(path) else {
            return DeviceState::default();
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            return DeviceState::default();
        };
        if v.get("schema_version").and_then(Value::as_f64) != Some(STATE_SCHEMA_VERSION as f64) {
            return DeviceState::default();
        }
        let current = v.get("current").and_then(Value::as_str).map(String::from);
        let loops = v
            .get("loops")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(id, l)| LoopState::from_value(l).map(|l| (id.clone(), l)))
                    .collect()
            })
            .unwrap_or_default();
        DeviceState { current, loops }
    }

    pub fn to_json(&self) -> String {
        let loops: Map<String, Value> = self
            .loops
            .iter()
            .map(|(id, l)| (id.clone(), l.to_value()))
            .collect();
        let v = json!({
            "schema_version": STATE_SCHEMA_VERSION,
            "current": self.current,
            "loops": loops,
        });
        to_js_json(&v, true) + "\n"
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// A record in the store; version 0 until its first save.
    Record { id: String, version: u64 },
    /// A file given with `--song`: a bare song, or a record (`record` holds its id and version).
    File {
        path: PathBuf,
        record: Option<(String, u64)>,
    },
}

/// What a save did.
#[derive(Clone, Debug, PartialEq)]
pub enum Saved {
    /// Written as `version` of the open record (or the file).
    Version(u64),
    /// Version conflict: the song went to a new record with this id and title; editing goes on
    /// there.
    Copy { id: String, title: String },
}

pub struct Session {
    pub store: DirSaveStore,
    pub state_path: PathBuf,
    pub state: DeviceState,
    pub target: Target,
    /// The song changed since the last save.
    pub dirty: bool,
    /// `updated_at` of the last save of the open record, if known.
    pub saved_at: Option<String>,
}

/// A song opened from the store or a file, with its stored loop.
pub struct Opened {
    pub song: Song,
    pub looping: LoopState,
}

impl Session {
    /// The store in `data_dir/saves`, the device state in `data_dir/tui-state.json`.
    pub fn new(data_dir: PathBuf) -> Session {
        let state_path = data_dir.join("tui-state.json");
        Session {
            store: DirSaveStore::new(data_dir.join("saves")),
            state: DeviceState::load(&state_path),
            state_path,
            target: Target::Record {
                id: new_save_id(),
                version: 0,
            },
            dirty: false,
            saved_at: None,
        }
    }

    /// Open what the session should start with: the record remembered for this device, else the
    /// newest record, else a new empty song (`create_song`).
    pub fn start(&mut self) -> Result<Opened, String> {
        let remembered = self.state.current.clone();
        let mut candidates: Vec<String> = remembered.into_iter().collect();
        if let Ok((list, _)) = self.store.list() {
            candidates.extend(list.into_iter().map(|s| s.id));
        }
        for id in candidates {
            if let Ok(opened) = self.open(&id) {
                return Ok(opened);
            }
        }
        Ok(self.new_song())
    }

    /// Edit a file given with `--song` (a bare song or a record).
    pub fn open_file(&mut self, path: PathBuf) -> Result<Opened, String> {
        let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let content = parse_file(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let (song, record) = match content {
            FileContent::Song(song) => (song, None),
            FileContent::Record(r) => {
                self.saved_at = Some(r.updated_at.clone());
                (r.song, Some((r.id, r.version)))
            }
        };
        let looping = record
            .as_ref()
            .and_then(|(id, _)| self.state.loops.get(id).copied())
            .unwrap_or_default();
        self.target = Target::File { path, record };
        self.dirty = false;
        Ok(Opened { song, looping })
    }

    pub fn open(&mut self, id: &str) -> Result<Opened, String> {
        let record = self
            .store
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no saved progression {id}"))?;
        self.target = Target::Record {
            id: record.id.clone(),
            version: record.version,
        };
        self.saved_at = Some(record.updated_at.clone());
        self.dirty = false;
        self.remember(Some(record.id.clone()));
        Ok(Opened {
            looping: self.state.loops.get(id).copied().unwrap_or_default(),
            song: record.song,
        })
    }

    /// A new empty song; it becomes a record on its first save.
    pub fn new_song(&mut self) -> Opened {
        self.target = Target::Record {
            id: new_save_id(),
            version: 0,
        };
        self.saved_at = None;
        self.dirty = false;
        self.remember(None);
        Opened {
            song: create_song(),
            looping: LoopState::default(),
        }
    }

    pub fn is_file(&self) -> bool {
        matches!(self.target, Target::File { .. })
    }

    /// Id of the open record (`None` for a bare song file).
    pub fn current_id(&self) -> Option<&str> {
        match &self.target {
            Target::Record { id, .. } => Some(id),
            Target::File { record, .. } => record.as_ref().map(|(id, _)| id.as_str()),
        }
    }

    /// Short description for the screen: `saved v3`, `unsaved`, `file song.json`.
    pub fn label(&self) -> String {
        let state = if self.dirty { " *" } else { "" };
        match &self.target {
            Target::Record { version: 0, .. } => format!("new{state}"),
            Target::Record { version, .. } => format!("v{version}{state}"),
            Target::File { path, .. } => format!(
                "file {}{state}",
                path.file_name().map_or_else(
                    || path.display().to_string(),
                    |n| n.to_string_lossy().into_owned()
                )
            ),
        }
    }

    /// Save `song` now: the next version of the open record (a copy on a version conflict), or
    /// the file in the format it was read in.
    pub fn save(&mut self, song: &Song, now: SystemTime) -> Result<Saved, String> {
        let saved = match self.target.clone() {
            Target::Record { id, version } => {
                let record = SaveRecord::new(song, &id, version + 1, now);
                match self.store.put(&record) {
                    Ok(()) => {
                        self.target = Target::Record {
                            id: id.clone(),
                            version: version + 1,
                        };
                        self.saved_at = Some(record.updated_at);
                        if self.state.current.as_deref() != Some(&id) {
                            self.remember(Some(id));
                        }
                        Saved::Version(version + 1)
                    }
                    Err(StoreError::Conflict { .. }) => {
                        let title = conflict_title(&song.title);
                        let copy = Song {
                            title: title.clone(),
                            ..song.clone()
                        };
                        let copy_id = new_save_id();
                        let record = SaveRecord::new(&copy, &copy_id, 1, now);
                        self.store.put(&record).map_err(|e| e.to_string())?;
                        if let Some(l) = self.state.loops.get(&id).copied() {
                            self.state.loops.insert(copy_id.clone(), l);
                        }
                        self.target = Target::Record {
                            id: copy_id.clone(),
                            version: 1,
                        };
                        self.saved_at = Some(record.updated_at);
                        self.remember(Some(copy_id.clone()));
                        Saved::Copy { id: copy_id, title }
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            Target::File { path, record } => {
                let (text, next) = match &record {
                    Some((id, version)) => {
                        let r = SaveRecord::new(song, id, version + 1, now);
                        self.saved_at = Some(r.updated_at.clone());
                        (r.to_json(), Some((id.clone(), version + 1)))
                    }
                    None => (song.to_json() + "\n", None),
                };
                write_atomic(&path, text).map_err(|e| e.to_string())?;
                let version = next.as_ref().map_or(0, |(_, v)| *v);
                self.target = Target::File { path, record: next };
                Saved::Version(version)
            }
        };
        self.dirty = false;
        Ok(saved)
    }

    pub fn list(&self) -> Result<(Vec<SaveSummary>, usize), String> {
        self.store.list().map_err(|e| e.to_string())
    }

    /// Delete a record (and its loop). Deleting the open record opens the newest remaining one
    /// (or a new song), as the web app does; that song is returned.
    pub fn delete(&mut self, id: &str) -> Result<Option<Opened>, String> {
        self.store.delete(id).map_err(|e| e.to_string())?;
        self.state.loops.remove(id);
        if self.current_id() == Some(id) && !self.is_file() {
            self.state.current = None;
            return self.start().map(Some);
        }
        self.write_state();
        Ok(None)
    }

    /// Remember the loop of the open record (per device).
    pub fn set_loop(&mut self, looping: LoopState) {
        let Some(id) = self.current_id().map(String::from) else {
            return;
        };
        if self.state.loops.get(&id) != Some(&looping) {
            self.state.loops.insert(id, looping);
            self.write_state();
        }
    }

    fn remember(&mut self, id: Option<String>) {
        self.state.current = id;
        self.write_state();
    }

    fn write_state(&self) {
        // UI state only: when it cannot be written the loop is just not restored next time.
        let _ = write_atomic(&self.state_path, self.state.to_json());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::saves::tests::temp_dir;
    use croky_core::SongChord;
    use std::time::{Duration, UNIX_EPOCH};

    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_497_600)
    }

    fn song(title: &str) -> Song {
        Song {
            title: title.into(),
            chords: vec![SongChord {
                token: "I".into(),
                beats: 4.0,
            }],
            ..create_song()
        }
    }

    #[test]
    fn saves_new_versions_and_reopens_the_last_record() {
        let dir = temp_dir("session");
        let mut s = Session::new(dir.clone());
        let opened = s.start().unwrap();
        assert!(opened.song.chords.is_empty(), "nothing saved yet: new song");
        assert_eq!(s.label(), "new");
        assert_eq!(s.save(&song("A"), now()), Ok(Saved::Version(1)));
        assert_eq!(s.save(&song("A2"), now()), Ok(Saved::Version(2)));
        let id = s.current_id().unwrap().to_string();
        let looped = LoopState {
            enabled: false,
            range: Some(LoopRange {
                start: 0.0,
                end: 4.0,
            }),
        };
        s.set_loop(looped);

        let mut again = Session::new(dir.clone());
        let opened = again.start().unwrap();
        assert_eq!(again.current_id(), Some(id.as_str()));
        assert_eq!(opened.song.title, "A2");
        assert_eq!(opened.looping, looped);
        assert_eq!(again.label(), "v2");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_conflict_saves_a_copy_and_goes_on_there() {
        let dir = temp_dir("conflict");
        let mut a = Session::new(dir.clone());
        a.start().unwrap();
        a.save(&song("Night"), now()).unwrap();
        let id = a.current_id().unwrap().to_string();
        let mut b = Session::new(dir.clone());
        b.open(&id).unwrap();
        b.save(&song("Night (b)"), now()).unwrap();
        // `a` still thinks the record is at version 1.
        let Saved::Copy { id: copy, title } = a.save(&song("Night"), now()).unwrap() else {
            panic!("expected a copy");
        };
        assert_eq!(title, "Night (copy)");
        assert_ne!(copy, id);
        assert_eq!(a.current_id(), Some(copy.as_str()));
        let (list, _) = a.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(a.store.get(&id).unwrap().unwrap().song.title, "Night (b)");
        assert_eq!(
            conflict_title(&"x".repeat(300)).len(),
            MAX_SAVE_TITLE_LENGTH
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edits_a_song_file_in_place() {
        let dir = temp_dir("file");
        let path = dir.join("demo.json");
        fs::write(&path, song("Demo").to_json()).unwrap();
        let mut s = Session::new(dir.join("data"));
        let opened = s.open_file(path.clone()).unwrap();
        assert_eq!(opened.song.title, "Demo");
        assert_eq!(s.label(), "file demo.json");
        s.save(&song("Demo 2"), now()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"title\": \"Demo 2\""));
        assert!(
            !text.contains("schema_version"),
            "a bare song stays a bare song"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleting_the_open_record_opens_the_newest_other_one() {
        let dir = temp_dir("delete");
        let mut s = Session::new(dir.clone());
        s.start().unwrap();
        s.save(&song("Kept"), now()).unwrap();
        let kept = s.current_id().unwrap().to_string();
        s.new_song();
        s.save(&song("Gone"), now() + Duration::from_secs(5))
            .unwrap();
        let gone = s.current_id().unwrap().to_string();
        let opened = s
            .delete(&gone)
            .unwrap()
            .expect("the open record was deleted");
        assert_eq!(opened.song.title, "Kept");
        assert_eq!(s.current_id(), Some(kept.as_str()));
        assert_eq!(s.store.get(&gone).unwrap(), None);
        assert!(s.delete(&gone).unwrap().is_none(), "deleting again is fine");
        fs::remove_dir_all(dir).unwrap();
    }
}
