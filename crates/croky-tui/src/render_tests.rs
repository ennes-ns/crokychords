//! Render tests: draw whole screens into a `TestBackend` and compare the text with golden
//! snapshots in `tests/snapshots/`. `UPDATE_SNAPSHOTS=1 cargo test -p croky-tui` rewrites them;
//! review the diff like any other change.

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;

use crate::app::{App, PlayView, SavesView, Screen};
use crate::keys::{Code, Key};
use crate::saves::SaveSummary;
use crate::testdata::{song, table};
use crate::view;

fn buffer_text(buf: &Buffer) -> String {
    let mut out = String::new();
    for y in 0..buf.area.height {
        let mut line = String::new();
        for x in 0..buf.area.width {
            line.push_str(buf[(x, y)].symbol());
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn draw_sized(app: &App, play: &PlayView, w: u16, h: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal.draw(|f| view::render(f, app, play)).unwrap();
    buffer_text(terminal.backend().buffer())
}

fn draw(app: &App, play: &PlayView) -> String {
    draw_sized(app, play, 100, 30)
}

fn check(name: &str, actual: &str) {
    let path = format!("{}/tests/snapshots/{name}.txt", env!("CARGO_MANIFEST_DIR"));
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing {path}; run with UPDATE_SNAPSHOTS=1"));
    assert_eq!(
        actual, expected,
        "snapshot {name} differs; UPDATE_SNAPSHOTS=1 to accept"
    );
}

fn idle() -> PlayView {
    PlayView {
        port: Some("croky-tui:out (virtual)".into()),
        sched: "SCHED_FIFO 40".into(),
        ..PlayView::default()
    }
}

fn app() -> App {
    let mut app = App::new(song(), table(), "default.json".into());
    app.save_label = "v3".into();
    app
}

fn press(app: &mut App, keys: &[Key]) {
    for k in keys {
        app.handle(*k);
    }
}

#[test]
fn editor_with_a_selected_chord_and_a_loop_range() {
    let mut app = app();
    // Select chord 2, loop bars 2-3, highlight the second suggestion.
    press(
        &mut app,
        &[
            Key::new(Code::Home),
            Key::new(Code::Right),
            Key::char('('),
            Key::new(Code::Right),
            Key::char(')'),
            Key::new(Code::Left),
            Key::new(Code::Down),
        ],
    );
    let text = draw(&app, &idle());
    assert!(text.contains("Axis · C major · 120 BPM · 4/4 · 4 chords · 16 beats  v3"));
    assert!(text.contains("›V"), "chord 2 selected");
    assert!(text.contains(" 2 ━━━"), "loop range over bars 2-3");
    assert!(text.contains("Next chord · replaces chord 2 (V)"));
    assert!(text.contains("after: I"));
    assert!(text.contains("Enter replaces · S-Enter inserts after"));
    assert!(text.contains("bars 2–3"));
    assert!(text.contains(" + "), "the + slot after the last chord");
    check("editor", &text);
}

#[test]
fn playing_the_band_with_a_muted_track() {
    let mut app = app();
    press(
        &mut app,
        &[
            Key::char('t'),
            Key::char('m'),
            Key::char('k'),
            Key::char('+'),
        ],
    );
    let play = PlayView {
        playing: true,
        position: Some(5.5),
        sent: 412,
        late_p99_us: 20,
        late_max_us: 90,
        ..idle()
    };
    let text = draw(&app, &play);
    check("playing", &text);
    assert!(text.contains("Db major · 130 BPM"));
    assert!(text.contains("♪V"), "the playing chord");
    assert!(text.contains("● playing 2.2"));
    assert!(text.contains("p99 0.02 max 0.09 ms /412"));
    assert!(text.contains("▸ Bass    bass-quarters ch2  muted"));
    assert!(text.contains("SCHED_FIFO 40"));
}

#[test]
fn empty_song_on_the_plus_slot_without_a_port() {
    let mut s = song();
    s.chords.clear();
    let mut app = App::new(s, table(), "default.json".into());
    app.save_label = "new".into();
    app.error = Some("MIDI: no MIDI output matching 'rtpmidid' (see --list-ports)".into());
    let text = draw(&app, &PlayView::default());
    check("empty-no-port", &text);
    assert!(text.contains("›+"));
    assert!(text.contains(" add"));
    assert!(text.contains("Next chord · adds at the end"));
    assert!(text.contains("after: any position"));
    assert!(text.contains("out   none"));
}

#[test]
fn saved_progressions_list() {
    let mut app = app();
    let summary = |id: &str, title: &str, version, at: &str| SaveSummary {
        id: id.into(),
        version,
        updated_at: at.into(),
        title: title.into(),
    };
    app.screen = Screen::Saves(SavesView {
        list: vec![
            summary("a", "Axis", 3, "2026-10-20T12:34:56.789Z"),
            summary("b", "Night drive", 12, "2026-10-19T08:00:00.000Z"),
            summary("c", "Sketch", 1, "2026-10-01T23:59:00.000Z"),
        ],
        unreadable: 1,
        index: 1,
        confirm_delete: false,
        current: Some("a".into()),
    });
    let text = draw(&app, &idle());
    check("saves", &text);
    assert!(text.contains("Saved progressions (3)"));
    assert!(text.contains("▸ Night drive"));
    assert!(text.contains("2026-10-20 12:34 UTC  ● open"));
    assert!(text.contains("1 unreadable file(s) skipped"));
    app.handle(Key::char('d'));
    let text = draw(&app, &idle());
    assert!(text.contains("Delete \"Night drive\"? y deletes"));
}

#[test]
fn help_and_rename_overlays() {
    let mut app = app();
    app.handle(Key::char('?'));
    let text = draw(&app, &idle());
    assert!(text.contains("Keys · any key closes"));
    assert!(text.contains("insert the triad after the chord"));
    check("help", &text);
    app.handle(Key::char('x'));
    assert_eq!(app.screen, Screen::Editor, "any key closes the help");
    press(&mut app, &[Key::char('r'), Key::char('!')]);
    let text = draw(&app, &idle());
    assert!(text.contains("Axis!▏"));
    check("rename", &text);
}

#[test]
fn fits_an_80_by_24_terminal() {
    let mut app = app();
    for _ in 0..6 {
        app.handle(Key::new(Code::Enter));
    }
    let text = draw_sized(&app, &idle(), 80, 24);
    assert!(text.contains("10 chords"));
    assert!(text.contains("Band"));
    check("narrow", &text);
}

/// `songs/demo.json` is a schema-4 song exactly as `serializeSong` writes it
/// (`UPDATE_SNAPSHOTS=1` rewrites it from its current content).
#[test]
fn demo_song_is_canonical_schema_4() {
    let path = format!("{}/songs/demo.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap();
    let song = croky_core::Song::from_json(&text).unwrap();
    let canonical = song.to_json() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, &canonical).unwrap();
        return;
    }
    assert!(text.starts_with("{\n  \"schema\": 4,"));
    assert_eq!(
        text, canonical,
        "UPDATE_SNAPSHOTS=1 to rewrite songs/demo.json"
    );
}
