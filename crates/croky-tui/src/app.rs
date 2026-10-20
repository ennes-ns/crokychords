//! Screen state and key handling, free of I/O: keys change the song and the cursor and return
//! an `Action` for main.rs to carry out (play, stop, save, quit). Tested without a terminal.

use croky_core::{chord_name, parse_token, suggest_next, NgramTable, Song, SongChord, Suggestion};

use crate::player::IDLE;

pub const SUGGESTION_COUNT: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Left,
    Right,
    Enter,
    Delete,
    Char(char),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    TogglePlay,
    Save,
    Quit,
}

/// What the player reports to the screen; filled from `player::Shared` each frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayView {
    /// `None`: no MIDI output could be opened (the reason is in `App::error`).
    pub port: Option<String>,
    pub playing: bool,
    pub chord: usize,
    pub max_late_us: u64,
    pub sent: u64,
}

impl Default for PlayView {
    fn default() -> Self {
        PlayView {
            port: None,
            playing: false,
            chord: IDLE,
            max_late_us: 0,
            sent: 0,
        }
    }
}

pub struct App {
    pub song: Song,
    pub table: NgramTable,
    pub table_name: String,
    /// Index of the selected chord; the next chord is inserted after it.
    pub cursor: usize,
    pub looped: bool,
    /// Last thing that happened, shown in the footer (`→ inserted V`).
    pub status: String,
    pub error: Option<String>,
    pub suggestions: Vec<Suggestion>,
}

impl App {
    pub fn new(song: Song, table: NgramTable, table_name: String) -> App {
        let cursor = song.chords.len().saturating_sub(1);
        let mut app = App {
            song,
            table,
            table_name,
            cursor,
            looped: true,
            status: String::new(),
            error: None,
            suggestions: Vec::new(),
        };
        app.refresh();
        app
    }

    /// Tokens up to and including the cursor, rests removed: the suggestion context.
    pub fn context(&self) -> Vec<String> {
        let end = (self.cursor + 1).min(self.song.chords.len());
        self.song.chords[..end]
            .iter()
            .filter(|c| !croky_core::is_rest_token(&c.token))
            .map(|c| c.token.clone())
            .collect()
    }

    pub fn refresh(&mut self) {
        let opts = croky_core::SuggestOptions {
            limit: SUGGESTION_COUNT,
            ..Default::default()
        };
        self.suggestions = suggest_next(&self.table, self.song.key.mode, &self.context(), opts);
    }

    /// Lead-sheet name of a token in the song's key ('' for rest or an unknown token).
    pub fn name(&self, token: &str) -> String {
        parse_token(token)
            .map(|c| chord_name(&c, self.song.key()))
            .unwrap_or_default()
    }

    fn insert(&mut self, n: usize) {
        let Some(s) = self.suggestions.get(n) else {
            self.status = format!("→ no suggestion {}", n + 1);
            return;
        };
        let token = s.token.clone();
        let at = if self.song.chords.is_empty() {
            0
        } else {
            self.cursor + 1
        };
        let beats = f64::from(self.song.meter.beats);
        self.song.chords.insert(
            at,
            SongChord {
                token: token.clone(),
                beats,
            },
        );
        self.cursor = at;
        self.status = format!("→ inserted {token} ({:.1}%)", s.probability * 100.0);
        self.refresh();
    }

    pub fn handle(&mut self, key: Key) -> Action {
        let len = self.song.chords.len();
        match key {
            Key::Left | Key::Char('h') => self.cursor = self.cursor.saturating_sub(1),
            Key::Right | Key::Char('l') => {
                self.cursor = (self.cursor + 1).min(len.saturating_sub(1))
            }
            Key::Enter | Key::Char('\t') => self.insert(0),
            Key::Char(c @ '1'..='8') => self.insert(c as usize - '1' as usize),
            Key::Delete | Key::Char('x') => {
                if len > 0 {
                    let removed = self.song.chords.remove(self.cursor);
                    self.cursor = self.cursor.min(self.song.chords.len().saturating_sub(1));
                    self.status = format!("→ deleted {}", removed.token);
                }
            }
            Key::Char('r') => {
                self.looped = !self.looped;
                self.status = format!("→ loop {}", if self.looped { "on" } else { "off" });
            }
            Key::Char(' ') => return Action::TogglePlay,
            Key::Char('w') => return Action::Save,
            Key::Char('q') => return Action::Quit,
            Key::Char(_) => {}
        }
        self.refresh();
        Action::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdata::{song, table};

    #[test]
    fn inserts_the_top_suggestion_after_the_cursor() {
        let mut app = App::new(song(), table(), "test".into());
        assert_eq!(app.cursor, 3);
        let top = app.suggestions[0].token.clone();
        assert_eq!(app.handle(Key::Enter), Action::None);
        assert_eq!(app.song.chords.len(), 5);
        assert_eq!(app.song.chords[4].token, top);
        assert_eq!(app.cursor, 4);
        assert!(app.status.starts_with("→ inserted"));
    }

    #[test]
    fn moves_deletes_and_maps_actions() {
        let mut app = App::new(song(), table(), "test".into());
        app.handle(Key::Left);
        app.handle(Key::Left);
        assert_eq!(app.cursor, 1);
        assert_eq!(app.context(), vec!["I", "V"]);
        app.handle(Key::Char('2'));
        assert_eq!(app.cursor, 2);
        app.handle(Key::Delete);
        assert_eq!(app.song.chords.len(), 4);
        assert_eq!(app.handle(Key::Char(' ')), Action::TogglePlay);
        assert_eq!(app.handle(Key::Char('q')), Action::Quit);
    }
}
