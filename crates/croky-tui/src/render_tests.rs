//! Render tests: draw the whole screen into a `TestBackend` and compare the text with golden
//! snapshots in `tests/snapshots/`. `UPDATE_SNAPSHOTS=1 cargo test` rewrites them; review
//! the diff like any other change.

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;

use crate::app::{App, Key, PlayView};
use crate::testdata::{song, table};
use crate::view;

const W: u16 = 100;
const H: u16 = 24;

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

fn draw(app: &App, play: &PlayView) -> String {
    let mut terminal = Terminal::new(TestBackend::new(W, H)).unwrap();
    terminal.draw(|f| view::render(f, app, play)).unwrap();
    buffer_text(terminal.backend().buffer())
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
        ..PlayView::default()
    }
}

#[test]
fn shows_grid_suggestions_and_port() {
    let app = App::new(song(), table(), "default.json".into());
    let text = draw(&app, &idle());
    assert!(text.contains("Axis · C major · 120 BPM · 4/4 · 4 chords · 16 beats"));
    assert!(text.contains("›IV"), "cursor on the last chord");
    assert!(text.contains("Next chord after IV"));
    assert!(text.contains("croky-tui:out (virtual)"));
    check("idle", &text);
}

#[test]
fn shows_the_playing_chord_and_inserted_suggestion() {
    let mut app = App::new(song(), table(), "default.json".into());
    app.handle(Key::Enter);
    let play = PlayView {
        playing: true,
        chord: 1,
        max_late_us: 120,
        sent: 42,
        ..idle()
    };
    let text = draw(&app, &play);
    assert!(text.contains("♪V"));
    assert!(text.contains("● playing"));
    assert!(text.contains("max 0.12 ms over 42 msgs"));
    assert!(text.contains("→ inserted"));
    check("playing", &text);
}

#[test]
fn empty_song_and_missing_port() {
    let mut s = song();
    s.chords.clear();
    let mut app = App::new(s, table(), "default.json".into());
    app.error = Some("MIDI: no MIDI output matching 'rtpmidid' (see --list-ports)".into());
    let text = draw(&app, &PlayView::default());
    assert!(text.contains("(empty: press Enter"));
    assert!(text.contains("Next chord (song start)"));
    assert!(text.contains("out  none"));
    check("empty-no-port", &text);
}
