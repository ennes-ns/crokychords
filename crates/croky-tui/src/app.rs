//! Screen state and editing, free of I/O. Keys change the song, the selection and the loop the
//! way the web app does (`docs/specs/web-v1.md` §3–4: replace-first picks, the "+" slot, explicit
//! insert; `docs/specs/loop-v1.md`), and return an `Effect` for main.rs to carry out (playback,
//! saving, the saves list). Every song edit is one undo step and bumps `revision`, which main.rs
//! watches to autosave and to let playback follow the edit.

use croky_core::json::js_number;
use croky_core::{
    chord_name, diatonic_triad_token, is_diatonic_token, is_rest_token, parse_token, suggest_next,
    Mode, NgramTable, Song, SuggestOptions, Suggestion,
};

use crate::edit::{
    bar_length, chord_start, clamp_selection, insert_after, loop_label, move_selection,
    remove_chord, resize_chord, with_loop_end, with_loop_start, LoopRange, TEMPO_MAX, TEMPO_MIN,
    TONICS,
};
use crate::keys::{editor_command, Cmd, Code, Key};
use crate::saves::SaveSummary;
use crate::session::LoopState;

/// Most suggestions computed for the Next chord panel (it shows as many as fit).
pub const SUGGESTION_LIMIT: usize = 12;
/// Undo steps kept, as the web app.
pub const UNDO_LIMIT: usize = 50;
/// Longest title typed in the rename prompt.
const MAX_TITLE_CHARS: usize = 200;

/// What main.rs has to do after a key.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    None,
    /// Stop when playing, else play from the loop start (beat 0 without loop).
    TogglePlay,
    /// Play from a song beat (the selected chord).
    PlayFrom(f64),
    /// Looping or the loop range changed.
    LoopChanged,
    /// A chord was picked: sound it when stopped.
    Audition(String),
    Save,
    /// Write the song as a .mid file.
    Export,
    /// Show the saved progressions (main.rs fills the list).
    OpenSaves,
    Open(String),
    NewSong,
    Delete(String),
    Quit,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Screen {
    Editor,
    Help,
    /// Typing a new title.
    Rename(String),
    Saves(SavesView),
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavesView {
    pub list: Vec<SaveSummary>,
    /// `.json` files in the saves folder that are not valid records.
    pub unreadable: usize,
    pub index: usize,
    /// Waiting for `y` to delete the highlighted record.
    pub confirm_delete: bool,
    /// Id of the open record, marked in the list.
    pub current: Option<String>,
}

/// What the player reports; filled from `player::Player` each frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlayView {
    /// `None`: no MIDI output (the reason is in `App::error`).
    pub port: Option<String>,
    pub playing: bool,
    /// Playhead in song beats.
    pub position: Option<f64>,
    pub sent: u64,
    pub late_p99_us: u64,
    pub late_max_us: u64,
    pub sched: String,
}

pub struct App {
    pub song: Song,
    pub table: NgramTable,
    pub table_name: String,
    /// The selected chord, or `None` for the "+" slot after the last chord.
    pub selected: Option<usize>,
    /// Highlighted row of the Next chord panel.
    pub highlight: usize,
    pub diatonic_only: bool,
    pub suggestions: Vec<Suggestion>,
    pub looping: bool,
    pub loop_range: Option<LoopRange>,
    /// Selected row of the band panel: a track index, or `tracks.len()` for the melody.
    pub track: usize,
    /// Bumped on every song change (edit, undo, load).
    pub revision: u64,
    /// Last thing that happened, shown in the footer.
    pub status: String,
    pub error: Option<String>,
    pub screen: Screen,
    /// Where the song is saved, for the header (`v3`, `new *`, `file demo.json`).
    pub save_label: String,
    pub(crate) undo: Vec<Song>,
    pub(crate) redo: Vec<Song>,
}

impl App {
    pub fn new(song: Song, table: NgramTable, table_name: String) -> App {
        let mut app = App {
            song,
            table,
            table_name,
            selected: None,
            highlight: 0,
            diatonic_only: false,
            suggestions: Vec::new(),
            looping: true,
            loop_range: None,
            track: 0,
            revision: 0,
            status: String::new(),
            error: None,
            screen: Screen::Editor,
            save_label: String::new(),
            undo: Vec::new(),
            redo: Vec::new(),
        };
        app.refresh();
        app
    }

    /// Open another song: the "+" slot is selected, undo history is cleared and its loop applies.
    pub fn load(&mut self, song: Song, looping: LoopState) {
        self.song = song;
        self.selected = None;
        self.highlight = 0;
        self.looping = looping.enabled;
        self.loop_range = looping.range;
        self.track = 0;
        self.undo.clear();
        self.redo.clear();
        self.revision += 1;
        self.refresh();
    }

    pub fn loop_state(&self) -> LoopState {
        LoopState {
            enabled: self.looping,
            range: self.loop_range,
        }
    }

    /// Tokens before the selected slot, rests removed: the suggestion context (web §4).
    pub fn context(&self) -> Vec<String> {
        let end = self
            .selected
            .unwrap_or(self.song.chords.len())
            .min(self.song.chords.len());
        self.song.chords[..end]
            .iter()
            .filter(|c| !is_rest_token(&c.token))
            .map(|c| c.token.clone())
            .collect()
    }

    pub fn refresh(&mut self) {
        let mode = self.song.key.mode;
        let keep = |t: &str| is_diatonic_token(t, mode);
        let filter: Option<&dyn Fn(&str) -> bool> = if self.diatonic_only {
            Some(&keep)
        } else {
            None
        };
        let opts = SuggestOptions {
            limit: SUGGESTION_LIMIT,
            filter,
            ..Default::default()
        };
        self.suggestions = suggest_next(&self.table, mode, &self.context(), opts);
        self.highlight = self.highlight.min(self.suggestions.len().saturating_sub(1));
    }

    /// Lead-sheet name of a token in the song's key ('' for a rest or an unknown token).
    pub fn name(&self, token: &str) -> String {
        parse_token(token)
            .map(|c| chord_name(&c, self.song.key()))
            .unwrap_or_default()
    }

    /// MIDI channel (0-15) for auditions: the selected track if it plays, else the first one
    /// that does.
    pub fn audition_channel(&self) -> u8 {
        let tracks = self.song.tracks.as_deref().unwrap_or_default();
        let track = tracks
            .get(self.track)
            .filter(|t| !t.muted)
            .or_else(|| tracks.iter().find(|t| !t.muted));
        track.map_or(0, |t| (t.channel & 0x0f) as u8)
    }

    /// Run `change` on the song as one undo step; nothing is recorded when the song stays equal.
    fn edit(&mut self, change: impl FnOnce(&mut Song, &mut Option<usize>)) -> bool {
        let before = self.song.clone();
        let mut selected = self.selected;
        change(&mut self.song, &mut selected);
        self.selected = clamp_selection(selected, self.song.chords.len());
        if self.song == before {
            return false;
        }
        self.undo.push(before);
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.revision += 1;
        true
    }

    fn history(&mut self, undo: bool) {
        let (from, to) = if undo {
            (&mut self.undo, &mut self.redo)
        } else {
            (&mut self.redo, &mut self.undo)
        };
        let word = if undo { "undo" } else { "redo" };
        let Some(song) = from.pop() else {
            self.status = format!("→ nothing to {word}");
            return;
        };
        to.push(std::mem::replace(&mut self.song, song));
        self.selected = clamp_selection(self.selected, self.song.chords.len());
        self.revision += 1;
        self.status = format!("→ {word}");
    }

    fn describe(&self, token: &str) -> String {
        let name = self.name(token);
        if name.is_empty() {
            token.into()
        } else {
            format!("{token} ({name})")
        }
    }

    /// Pick a chord: replace the selected one, add on the "+" slot (which stays selected), or
    /// insert after the selection (`insert`, which selects the new chord).
    fn place(&mut self, token: &str, insert: bool) -> Effect {
        let what = self.describe(token);
        match self.selected.filter(|&i| i < self.song.chords.len()) {
            None => {
                self.edit(|song, sel| {
                    insert_after(song, None, token);
                    *sel = None;
                });
                self.status = format!("→ added {what}");
            }
            Some(i) if insert => {
                self.edit(|song, sel| *sel = Some(insert_after(song, Some(i), token)));
                self.status = format!("→ inserted {what} after chord {}", i + 1);
            }
            Some(i) => {
                let old = self.song.chords[i].token.clone();
                self.edit(|song, _| song.chords[i].token = token.into());
                self.status = format!("→ chord {}: {old} → {what}", i + 1);
            }
        }
        Effect::Audition(token.into())
    }

    fn loop_at_selection(&mut self, start: bool) -> Effect {
        let Some(i) = self.selected.filter(|&i| i < self.song.chords.len()) else {
            self.status = "→ select a chord to set the loop there".into();
            return Effect::None;
        };
        let at = chord_start(&self.song, i);
        let total = self.song.total_beats();
        self.loop_range = Some(if start {
            with_loop_start(self.loop_range, at, total)
        } else {
            with_loop_end(self.loop_range, at + self.song.chords[i].beats)
        });
        // Setting a range turns looping on.
        self.looping = true;
        self.status = format!("→ loop {}", self.loop_text());
        Effect::LoopChanged
    }

    /// `bars 2–3` or `whole song`, plus `(off)` when not looping.
    pub fn loop_text(&self) -> String {
        let range = match self.loop_range {
            Some(r) => loop_label(r, bar_length(&self.song)),
            None => "whole song".into(),
        };
        if self.looping {
            range
        } else {
            format!("{range} (off)")
        }
    }

    pub fn handle(&mut self, key: Key) -> Effect {
        let effect = match &mut self.screen {
            Screen::Editor => match editor_command(key) {
                Some(cmd) => self.command(cmd),
                None => Effect::None,
            },
            Screen::Help => {
                self.screen = Screen::Editor;
                Effect::None
            }
            Screen::Rename(text) => {
                match key.code {
                    Code::Enter => {
                        let title = text.trim().to_string();
                        self.screen = Screen::Editor;
                        if title.is_empty() {
                            self.status = "→ title unchanged".into();
                        } else if self.edit(|song, _| song.title = title.clone()) {
                            self.status = format!("→ renamed to {title}");
                        }
                    }
                    Code::Esc => self.screen = Screen::Editor,
                    Code::Backspace => {
                        text.pop();
                    }
                    Code::Char('u') if key.ctrl => text.clear(),
                    Code::Char(c)
                        if !key.ctrl && !key.alt && text.chars().count() < MAX_TITLE_CHARS =>
                    {
                        text.push(c);
                    }
                    _ => {}
                }
                Effect::None
            }
            Screen::Saves(view) => {
                if view.confirm_delete {
                    view.confirm_delete = false;
                    return match (key.code, view.list.get(view.index)) {
                        (Code::Char('y'), Some(s)) => Effect::Delete(s.id.clone()),
                        _ => Effect::None,
                    };
                }
                match key.code {
                    Code::Up => view.index = view.index.saturating_sub(1),
                    Code::Down => {
                        view.index = (view.index + 1).min(view.list.len().saturating_sub(1))
                    }
                    Code::Enter => {
                        if let Some(s) = view.list.get(view.index) {
                            return Effect::Open(s.id.clone());
                        }
                    }
                    Code::Char('n') => return Effect::NewSong,
                    Code::Char('d') | Code::Delete if !view.list.is_empty() => {
                        view.confirm_delete = true;
                    }
                    Code::Esc | Code::Char('o' | 'q') => self.screen = Screen::Editor,
                    _ => {}
                }
                Effect::None
            }
        };
        self.refresh();
        effect
    }

    fn command(&mut self, cmd: Cmd) -> Effect {
        let count = self.song.chords.len();
        match cmd {
            Cmd::Move(d) => {
                self.selected = move_selection(self.selected, d, count);
                self.highlight = 0;
            }
            Cmd::First => {
                self.selected = (count > 0).then_some(0);
                self.highlight = 0;
            }
            Cmd::EndSlot => {
                self.selected = None;
                self.highlight = 0;
            }
            Cmd::Highlight(d) => {
                let last = self.suggestions.len().saturating_sub(1) as i64;
                self.highlight = (self.highlight as i64 + d).clamp(0, last) as usize;
            }
            Cmd::Pick { insert } => {
                let Some(s) = self.suggestions.get(self.highlight) else {
                    self.status = "→ no suggestion to pick".into();
                    return Effect::None;
                };
                let token = s.token.clone();
                return self.place(&token, insert);
            }
            Cmd::Degree { degree, insert } => {
                let token = diatonic_triad_token(degree, self.song.key.mode);
                return self.place(&token, insert);
            }
            Cmd::InsertCopy => {
                let at = self.selected.filter(|&i| i < count);
                let source = match at {
                    Some(i) => self.song.chords.get(i),
                    None => self.song.chords.last(),
                };
                let token = source.map_or_else(
                    || diatonic_triad_token(1, self.song.key.mode),
                    |c| c.token.clone(),
                );
                self.edit(|song, sel| *sel = Some(insert_after(song, at, &token)));
                self.status = format!("→ added a copy of {}", self.describe(&token));
            }
            Cmd::Remove => {
                let on_plus = self.selected.is_none();
                let Some(i) = self
                    .selected
                    .or(count.checked_sub(1))
                    .filter(|&i| i < count)
                else {
                    return Effect::None;
                };
                let token = self.song.chords[i].token.clone();
                self.edit(|song, sel| {
                    let next = remove_chord(song, i);
                    *sel = if on_plus { None } else { next };
                });
                self.status = format!("→ removed chord {} ({token})", i + 1);
            }
            Cmd::Resize(delta) => {
                if let Some(i) = self.selected {
                    if self.edit(|song, _| {
                        resize_chord(song, i, delta);
                    }) {
                        let beats = js_number(self.song.chords[i].beats);
                        self.status = format!("→ chord {} is {beats} beats", i + 1);
                    }
                }
            }
            Cmd::LoopStart => return self.loop_at_selection(true),
            Cmd::LoopEnd => return self.loop_at_selection(false),
            Cmd::ClearLoop => {
                self.loop_range = None;
                self.status = "→ loop range cleared".into();
                return Effect::LoopChanged;
            }
            Cmd::ToggleLoop => {
                self.looping = !self.looping;
                self.status = format!("→ loop {}", if self.looping { "on" } else { "off" });
                return Effect::LoopChanged;
            }
            Cmd::TogglePlay => return Effect::TogglePlay,
            Cmd::PlayFromSelection => {
                let from = self
                    .selected
                    .filter(|&i| i < count)
                    .map_or(0.0, |i| chord_start(&self.song, i));
                return Effect::PlayFrom(from);
            }
            Cmd::Tonic(d) => {
                let pc = i32::from(self.song.key().tonic);
                let tonic = TONICS[(pc + d).rem_euclid(12) as usize];
                self.edit(|song, _| song.key.tonic = tonic.into());
                self.status = format!("→ key {tonic} {}", mode_label(self.song.key.mode));
            }
            Cmd::Mode(d) => {
                let i = Mode::ALL
                    .iter()
                    .position(|m| *m == self.song.key.mode)
                    .unwrap_or(0) as i32;
                let mode = Mode::ALL[(i + d).rem_euclid(Mode::ALL.len() as i32) as usize];
                self.edit(|song, _| song.key.mode = mode);
                self.status = format!("→ key {} {}", self.song.key.tonic, mode_label(mode));
            }
            Cmd::Tempo(d) => {
                let tempo = (self.song.tempo.round() + d).clamp(TEMPO_MIN, TEMPO_MAX);
                self.edit(|song, _| song.tempo = tempo);
                self.status = format!("→ {} BPM", js_number(tempo));
            }
            Cmd::NextTrack(d) => {
                let rows = self.song.tracks.as_ref().map_or(0, Vec::len) as i64 + 1;
                self.track = (self.track as i64 + d).rem_euclid(rows) as usize;
            }
            Cmd::ToggleMute => {
                let track = self.track;
                let mut what = String::new();
                self.edit(|song, _| {
                    if let Some(t) = song.tracks.as_mut().and_then(|t| t.get_mut(track)) {
                        t.muted = !t.muted;
                        what = format!("{} {}", t.name, if t.muted { "muted" } else { "on" });
                    } else if let Some(m) = song.melody.as_mut() {
                        m.muted = !m.muted;
                        what = format!("Melody {}", if m.muted { "muted" } else { "on" });
                    }
                });
                self.status = format!("→ {what}");
            }
            Cmd::ToggleDiatonic => {
                self.diatonic_only = !self.diatonic_only;
                self.highlight = 0;
                self.status = if self.diatonic_only {
                    "→ Next chord: diatonic only".into()
                } else {
                    "→ Next chord: all chords".into()
                };
            }
            Cmd::Undo => self.history(true),
            Cmd::Redo => self.history(false),
            Cmd::Rename => self.screen = Screen::Rename(self.song.title.clone()),
            Cmd::Saves => return Effect::OpenSaves,
            Cmd::Save => return Effect::Save,
            Cmd::Export => return Effect::Export,
            Cmd::Help => self.screen = Screen::Help,
            Cmd::Quit => return Effect::Quit,
        }
        Effect::None
    }
}

/// The mode as the key picker of the web app names it, in lower case.
pub fn mode_label(mode: Mode) -> &'static str {
    match mode {
        Mode::Major => "major",
        Mode::Minor => "minor",
        Mode::Dorian => "dorian",
        Mode::Phrygian => "phrygian",
        Mode::Lydian => "lydian",
        Mode::Mixolydian => "mixolydian",
        Mode::Locrian => "locrian",
        Mode::HarmonicMinor => "harmonic minor",
        Mode::PhrygianDominant => "phrygian dominant",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdata::{song, table};

    fn app() -> App {
        App::new(song(), table(), "test".into())
    }

    fn press(app: &mut App, keys: &[Key]) {
        for k in keys {
            app.handle(*k);
        }
    }

    #[test]
    fn starts_on_the_plus_slot_and_digits_build_a_song() {
        let empty = Song {
            chords: vec![],
            ..song()
        };
        let mut a = App::new(empty, table(), "t".into());
        assert_eq!(a.selected, None);
        press(
            &mut a,
            &[
                Key::char('1'),
                Key::char('5'),
                Key::char('6'),
                Key::char('4'),
            ],
        );
        assert_eq!(a.song.tokens(), vec!["I", "V", "vi", "IV"]);
        assert_eq!(a.selected, None, "the + slot stays selected");
        assert!(a.song.chords.iter().all(|c| c.beats == 4.0));
    }

    #[test]
    fn a_pick_replaces_the_selected_chord_and_shift_inserts() {
        let mut a = app();
        press(&mut a, &[Key::new(Code::Home), Key::new(Code::Right)]);
        assert_eq!(a.selected, Some(1));
        assert_eq!(
            a.context(),
            vec!["I"],
            "context: the chords before the slot"
        );
        assert_eq!(a.handle(Key::char('2')), Effect::Audition("ii".into()));
        assert_eq!(a.song.tokens(), vec!["I", "ii", "vi", "IV"]);
        assert_eq!(a.selected, Some(1));
        a.handle(Key::char('5').shift());
        assert_eq!(a.song.tokens(), vec!["I", "ii", "V", "vi", "IV"]);
        assert_eq!(a.selected, Some(2), "the inserted chord is selected");
        // Enter picks the highlighted suggestion; ↓ moves the highlight.
        a.handle(Key::new(Code::Down));
        let second = a.suggestions[1].token.clone();
        a.handle(Key::new(Code::Enter));
        assert_eq!(a.song.chords[2].token, second);
        assert_eq!(a.song.chords.len(), 5);
    }

    #[test]
    fn insert_remove_resize_and_undo() {
        let mut a = app();
        a.handle(Key::new(Code::Home));
        a.handle(Key::char('i'));
        assert_eq!(a.song.tokens(), vec!["I", "I", "V", "vi", "IV"]);
        assert_eq!(a.selected, Some(1));
        a.handle(Key::char('['));
        a.handle(Key::char('{'));
        assert_eq!(a.song.chords[1].beats, 2.75);
        a.handle(Key::new(Code::Backspace));
        assert_eq!(a.song.chords.len(), 4);
        assert_eq!(a.selected, Some(0));
        // On the + slot Backspace removes the last chord.
        a.handle(Key::new(Code::Esc));
        a.handle(Key::new(Code::Backspace));
        assert_eq!(a.song.tokens(), vec!["I", "V", "vi"]);
        assert_eq!(a.selected, None);
        let rev = a.revision;
        a.handle(Key::char('u'));
        a.handle(Key::char('u'));
        assert_eq!(a.song.chords.len(), 5);
        assert!(a.revision > rev);
        a.handle(Key::char('U'));
        assert_eq!(a.song.chords.len(), 4);
    }

    #[test]
    fn edits_key_tempo_tracks_and_title() {
        let mut a = app();
        press(&mut a, &[Key::char('k'), Key::char('k'), Key::char('N')]);
        assert_eq!(a.song.key.tonic, "D");
        assert_eq!(a.song.key.mode, Mode::PhrygianDominant);
        press(&mut a, &[Key::char('+'), Key::char('-')]);
        assert_eq!(a.song.tempo, 129.0);
        for _ in 0..30 {
            a.handle(Key::char('+'));
        }
        assert_eq!(a.song.tempo, TEMPO_MAX);
        press(&mut a, &[Key::char('t'), Key::char('m')]);
        assert!(a.song.tracks.as_ref().unwrap()[1].muted);
        assert_eq!(a.status, "→ Bass muted");
        press(&mut a, &[Key::char('T'), Key::char('T'), Key::char('m')]);
        assert!(
            a.song.melody.as_ref().unwrap().muted,
            "the last row is the melody"
        );
        a.handle(Key::char('r'));
        assert_eq!(a.screen, Screen::Rename("Axis".into()));
        a.handle(Key::char('u').ctrl());
        assert_eq!(a.screen, Screen::Rename(String::new()), "Ctrl+U clears");
        a.handle(Key::new(Code::Esc));
        a.handle(Key::char('r'));
        press(
            &mut a,
            &[
                Key::new(Code::Backspace),
                Key::char('!'),
                Key::new(Code::Enter),
            ],
        );
        assert_eq!(a.song.title, "Axi!");
        assert_eq!(a.screen, Screen::Editor);
    }

    #[test]
    fn sets_loop_points_at_the_selection() {
        let mut a = app();
        a.handle(Key::new(Code::Home));
        a.handle(Key::new(Code::Right));
        assert_eq!(a.handle(Key::char('(')), Effect::LoopChanged);
        assert_eq!(
            a.loop_range,
            Some(LoopRange {
                start: 4.0,
                end: 16.0
            })
        );
        a.handle(Key::new(Code::Right));
        a.handle(Key::char(')'));
        assert_eq!(a.loop_text(), "bars 2–3");
        a.handle(Key::char('l'));
        assert_eq!(a.loop_text(), "bars 2–3 (off)");
        a.handle(Key::char('c'));
        assert_eq!(a.loop_range, None);
        assert_eq!(a.handle(Key::char('p')), Effect::PlayFrom(8.0));
    }

    #[test]
    fn diatonic_filter_and_saves_list_keys() {
        let mut a = app();
        a.handle(Key::char('f'));
        let mode = a.song.key.mode;
        assert!(!a.suggestions.is_empty());
        assert!(a
            .suggestions
            .iter()
            .all(|s| is_diatonic_token(&s.token, mode)));
        let summary = |id: &str| SaveSummary {
            id: id.into(),
            version: 1,
            updated_at: "2026-10-20T12:00:00.000Z".into(),
            title: id.into(),
        };
        a.screen = Screen::Saves(SavesView {
            list: vec![summary("a"), summary("b")],
            unreadable: 0,
            index: 0,
            confirm_delete: false,
            current: None,
        });
        a.handle(Key::new(Code::Down));
        assert_eq!(a.handle(Key::new(Code::Enter)), Effect::Open("b".into()));
        a.handle(Key::char('d'));
        assert_eq!(a.handle(Key::char('y')), Effect::Delete("b".into()));
        a.handle(Key::char('d'));
        assert_eq!(
            a.handle(Key::char('n')),
            Effect::None,
            "n cancels the delete"
        );
        assert_eq!(a.handle(Key::char('n')), Effect::NewSong);
        a.handle(Key::new(Code::Esc));
        assert_eq!(a.screen, Screen::Editor);
    }
}
