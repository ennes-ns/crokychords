//! The key map. Terminal key events become a small `Key` value (so tests need no terminal), and
//! `editor_command` maps a key to an editor command, following the web app's shortcuts where a
//! terminal can deliver them (`apps/web/src/keyboard.ts`). Where it cannot (Shift+digit on some
//! layouts, Alt+[ without the kitty keyboard protocol, Shift+Space) there is a plain-key alias.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Char(char),
    Enter,
    Esc,
    Backspace,
    Delete,
    Insert,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Tab,
    BackTab,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub code: Code,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

#[cfg(test)]
impl Key {
    pub const fn new(code: Code) -> Key {
        Key {
            code,
            shift: false,
            ctrl: false,
            alt: false,
        }
    }

    pub const fn char(c: char) -> Key {
        Key::new(Code::Char(c))
    }

    pub const fn shift(self) -> Key {
        Key {
            shift: true,
            ..self
        }
    }

    pub const fn ctrl(self) -> Key {
        Key { ctrl: true, ..self }
    }

    pub const fn alt(self) -> Key {
        Key { alt: true, ..self }
    }
}

/// A crossterm key event as a `Key`; `None` for keys the app does not use.
pub fn from_event(e: KeyEvent) -> Option<Key> {
    let code = match e.code {
        KeyCode::Char(c) => Code::Char(c),
        KeyCode::Enter => Code::Enter,
        KeyCode::Esc => Code::Esc,
        KeyCode::Backspace => Code::Backspace,
        KeyCode::Delete => Code::Delete,
        KeyCode::Insert => Code::Insert,
        KeyCode::Left => Code::Left,
        KeyCode::Right => Code::Right,
        KeyCode::Up => Code::Up,
        KeyCode::Down => Code::Down,
        KeyCode::Home => Code::Home,
        KeyCode::End => Code::End,
        KeyCode::Tab => Code::Tab,
        KeyCode::BackTab => Code::BackTab,
        _ => return None,
    };
    Some(Key {
        code,
        shift: e.modifiers.contains(KeyModifiers::SHIFT),
        ctrl: e.modifiers.contains(KeyModifiers::CONTROL),
        alt: e.modifiers.contains(KeyModifiers::ALT),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmd {
    /// Move the selection by n slots (chords plus the "+" slot).
    Move(i64),
    First,
    /// Select the "+" slot after the last chord.
    EndSlot,
    /// Move the highlight in the Next chord list.
    Highlight(i64),
    /// The highlighted suggestion: replace the selected chord (add on the "+" slot), or insert
    /// it after the selected chord.
    Pick {
        insert: bool,
    },
    /// The diatonic triad of a degree (1-7), as Pick.
    Degree {
        degree: u8,
        insert: bool,
    },
    /// Explicit add: a copy of the selected chord after it.
    InsertCopy,
    Remove,
    Resize(f64),
    LoopStart,
    LoopEnd,
    ClearLoop,
    ToggleLoop,
    /// Play from the loop start (beat 0 without loop), or stop.
    TogglePlay,
    PlayFromSelection,
    Tonic(i32),
    Mode(i32),
    Tempo(f64),
    NextTrack(i64),
    ToggleMute,
    ToggleDiatonic,
    Undo,
    Redo,
    Rename,
    /// Write the song as a .mid file.
    Export,
    Saves,
    Save,
    Help,
    Quit,
}

/// US-layout Shift+digit characters, for terminals that report the shifted character.
const SHIFTED_DIGITS: [char; 7] = ['!', '@', '#', '$', '%', '^', '&'];

/// The editor command for `key`, or `None`.
pub fn editor_command(key: Key) -> Option<Cmd> {
    use Cmd::*;
    if key.ctrl && !key.alt {
        return match key.code {
            Code::Char('z') if key.shift => Some(Redo),
            Code::Char('Z') => Some(Redo),
            Code::Char('z') => Some(Undo),
            Code::Char('y') => Some(Redo),
            Code::Char('s') => Some(Save),
            Code::Char('c') => Some(Quit),
            Code::Enter => Some(InsertCopy),
            _ => None,
        };
    }
    if key.alt && !key.ctrl {
        return match key.code {
            Code::Char('[') => Some(LoopStart),
            Code::Char(']') => Some(LoopEnd),
            Code::Enter => Some(Pick { insert: true }),
            _ => None,
        };
    }
    if key.ctrl || key.alt {
        return None;
    }
    Some(match key.code {
        Code::Left => Move(-1),
        Code::Right => Move(1),
        Code::Tab => Move(1),
        Code::BackTab => Move(-1),
        Code::Home => First,
        Code::End | Code::Esc => EndSlot,
        Code::Up => Highlight(-1),
        Code::Down => Highlight(1),
        Code::Enter => Pick { insert: key.shift },
        Code::Insert => InsertCopy,
        Code::Backspace | Code::Delete => Remove,
        Code::Char(c @ '1'..='7') => Degree {
            degree: c as u8 - b'0',
            insert: key.shift,
        },
        Code::Char(c) if SHIFTED_DIGITS.contains(&c) => Degree {
            degree: SHIFTED_DIGITS.iter().position(|d| *d == c).unwrap_or(0) as u8 + 1,
            insert: true,
        },
        Code::Char(' ') if key.shift => PlayFromSelection,
        Code::Char(' ') => TogglePlay,
        Code::Char('p') => PlayFromSelection,
        Code::Char('[') => Resize(-1.0),
        Code::Char(']') => Resize(1.0),
        Code::Char('{') => Resize(-0.25),
        Code::Char('}') => Resize(0.25),
        Code::Char('(') => LoopStart,
        Code::Char(')') => LoopEnd,
        Code::Char('c') => ClearLoop,
        Code::Char('l' | 'L') => ToggleLoop,
        Code::Char('i') => InsertCopy,
        Code::Char('x') => Remove,
        Code::Char('k') => Tonic(1),
        Code::Char('K') => Tonic(-1),
        Code::Char('n') => Mode(1),
        Code::Char('N') => Mode(-1),
        Code::Char('=') => Tempo(1.0),
        Code::Char('-') => Tempo(-1.0),
        Code::Char('+') => Tempo(10.0),
        Code::Char('_') => Tempo(-10.0),
        Code::Char('t') => NextTrack(1),
        Code::Char('T') => NextTrack(-1),
        Code::Char('m' | 'M') => ToggleMute,
        Code::Char('f') => ToggleDiatonic,
        Code::Char('u') => Undo,
        Code::Char('U') => Redo,
        Code::Char('r') => Rename,
        Code::Char('e') => Export,
        Code::Char('o') => Saves,
        Code::Char('w') => Save,
        Code::Char('?') => Help,
        Code::Char('q') => Quit,
        _ => return None,
    })
}

/// The key map as shown in the help screen: (keys, what they do).
pub const HELP: &[(&str, &str)] = &[
    ("←/→  Tab/S-Tab", "select chord / \"+\" slot"),
    ("Home  End/Esc", "first chord / \"+\" slot"),
    ("↑/↓", "highlight a Next chord suggestion"),
    ("Enter", "pick it: replace the chord (add on \"+\")"),
    ("S-Enter  A-Enter", "insert it after the chord"),
    ("1-7", "diatonic triad: replace (add on \"+\")"),
    ("S-1-7", "insert the triad after the chord"),
    ("i  Insert  C-Enter", "add a copy of the chord after it"),
    ("Backspace  Del  x", "remove the chord"),
    ("[ ]   { }", "length -/+ 1 beat, -/+ 1/4 beat"),
    ("( )  A-[ A-]", "loop start / end at the chord"),
    ("l   c", "loop on/off, clear loop range"),
    ("Space   p  S-Space", "play/stop, play from the chord"),
    ("k/K  n/N", "key up/down a semitone, next/prev mode"),
    ("- =  _ +", "tempo -/+ 1, -/+ 10 BPM"),
    ("t/T  m", "select track, mute/unmute it"),
    ("f", "Next chord: diatonic only"),
    ("u/U  C-z  C-y", "undo / redo"),
    ("r  o  w  C-s", "rename, saved progressions, save now"),
    ("e", "export a .mid file (GM program per track)"),
    ("?   q  C-c", "this help, quit"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_web_shortcuts() {
        let c = |k: Key| editor_command(k);
        assert_eq!(
            c(Key::char('1')),
            Some(Cmd::Degree {
                degree: 1,
                insert: false
            })
        );
        assert_eq!(
            c(Key::char('5').shift()),
            Some(Cmd::Degree {
                degree: 5,
                insert: true
            })
        );
        assert_eq!(
            c(Key::char('%')),
            Some(Cmd::Degree {
                degree: 5,
                insert: true
            })
        );
        assert_eq!(c(Key::char('8')), None);
        assert_eq!(c(Key::char('[')), Some(Cmd::Resize(-1.0)));
        assert_eq!(c(Key::char('}')), Some(Cmd::Resize(0.25)));
        assert_eq!(c(Key::char('[').alt()), Some(Cmd::LoopStart));
        assert_eq!(c(Key::char(')')), Some(Cmd::LoopEnd));
        assert_eq!(c(Key::char('L')), Some(Cmd::ToggleLoop));
        assert_eq!(c(Key::new(Code::Esc)), Some(Cmd::EndSlot));
        assert_eq!(c(Key::new(Code::Insert)), Some(Cmd::InsertCopy));
        assert_eq!(c(Key::new(Code::Enter).ctrl()), Some(Cmd::InsertCopy));
        assert_eq!(
            c(Key::new(Code::Enter).shift()),
            Some(Cmd::Pick { insert: true })
        );
        assert_eq!(c(Key::char('z').ctrl()), Some(Cmd::Undo));
        assert_eq!(c(Key::char('z').ctrl().shift()), Some(Cmd::Redo));
        assert_eq!(c(Key::char(' ')), Some(Cmd::TogglePlay));
        assert_eq!(c(Key::char(' ').shift()), Some(Cmd::PlayFromSelection));
        assert_eq!(c(Key::char('c').ctrl()), Some(Cmd::Quit));
        assert_eq!(c(Key::char('k').ctrl()), None);
    }
}
