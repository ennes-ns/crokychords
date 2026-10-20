//! croky-tui: throwaway terminal prototype of Croky Chords (spike, issue #39). Loads the
//! n-gram table and a song JSON, shows the chord grid and next-chord suggestions, and plays
//! the progression to an ALSA MIDI output. See docs/specs/tui-v1.md.

mod app;
mod latency;
mod player;
#[cfg(test)]
mod render_tests;
#[cfg(test)]
mod testdata;
mod view;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::Duration;

use croky_core::{NgramTable, Song};
use midir::MidiOutput;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

use app::{Action, App, Key, PlayView};
use player::Player;

const USAGE: &str = "\
croky-tui [options]

  --table PATH        n-gram table (default apps/web/public/data/default.json)
  --song PATH         song JSON as written by serializeSong (default: empty song in C major)
  --port NAME         MIDI output: 'virtual' (default, creates port croky-tui:out),
                      a substring of a port name (e.g. rtpmidid), or a port index
  --list-ports        list MIDI outputs and inputs, then exit
  --latency-test      measure MIDI round trips through an in-process loopback and exit
    --count N         round trips (default 500)
    --out NAME --in NAME   measure through an external echo path instead";

struct Args {
    table: PathBuf,
    song: Option<PathBuf>,
    port: String,
    list_ports: bool,
    latency: bool,
    count: usize,
    out: Option<String>,
    inp: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        table: PathBuf::from("apps/web/public/data/default.json"),
        song: None,
        port: "virtual".into(),
        list_ports: false,
        latency: false,
        count: 500,
        out: None,
        inp: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--table" => a.table = value()?.into(),
            "--song" => a.song = Some(value()?.into()),
            "--port" => a.port = value()?,
            "--list-ports" => a.list_ports = true,
            "--latency-test" => a.latency = true,
            "--count" => a.count = value()?.parse().map_err(|_| "--count needs a number")?,
            "--out" => a.out = Some(value()?),
            "--in" => a.inp = Some(value()?),
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument {other}\n\n{USAGE}")),
        }
    }
    Ok(a)
}

fn list_ports() -> Result<String, String> {
    let out = MidiOutput::new("croky-tui").map_err(|e| e.to_string())?;
    let inp = midir::MidiInput::new("croky-tui").map_err(|e| e.to_string())?;
    let mut s = String::from("outputs:\n");
    for (i, p) in out.ports().iter().enumerate() {
        s += &format!("  {i}: {}\n", out.port_name(p).unwrap_or_default());
    }
    s += "inputs:\n";
    for (i, p) in inp.ports().iter().enumerate() {
        s += &format!("  {i}: {}\n", inp.port_name(p).unwrap_or_default());
    }
    Ok(s)
}

/// Open the MIDI output; Err carries the reason, shown on screen (the TUI still runs).
fn open_output(port: &str) -> Result<Player, String> {
    let out = MidiOutput::new("croky-tui").map_err(|e| e.to_string())?;
    if port == "virtual" {
        use midir::os::unix::VirtualOutput;
        let conn = out.create_virtual("out").map_err(|e| e.to_string())?;
        return Ok(Player::new(conn, "croky-tui:out (virtual)".into()));
    }
    let ports = out.ports();
    let chosen = match port.parse::<usize>() {
        Ok(i) => ports.get(i).cloned(),
        Err(_) => ports
            .iter()
            .find(|p| out.port_name(p).unwrap_or_default().contains(port))
            .cloned(),
    }
    .ok_or(format!(
        "no MIDI output matching '{port}' (see --list-ports)"
    ))?;
    let name = out.port_name(&chosen).unwrap_or_default();
    let conn = out.connect(&chosen, "out").map_err(|e| e.to_string())?;
    Ok(Player::new(conn, name))
}

fn load(args: &Args) -> Result<App, String> {
    let read =
        |p: &PathBuf| std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()));
    let table = NgramTable::from_json(&read(&args.table)?).map_err(|e| e.to_string())?;
    let song = match &args.song {
        Some(p) => Song::from_json(&read(p)?).map_err(|e| e.to_string())?,
        None => Song::from_json(
            r#"{"schema":1,"title":"Untitled","key":{"tonic":"C","mode":"major"},"tempo":120,
            "meter":{"beats":4,"unit":4},"chords":[]}"#,
        )
        .map_err(|e| e.to_string())?,
    };
    let name = args
        .table
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(App::new(song, table, name))
}

fn to_key(code: KeyCode) -> Option<Key> {
    Some(match code {
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Enter => Key::Enter,
        KeyCode::Tab => Key::Char('\t'),
        KeyCode::Delete | KeyCode::Backspace => Key::Delete,
        KeyCode::Char(c) => Key::Char(c),
        KeyCode::Esc => Key::Char('q'),
        _ => return None,
    })
}

fn run_tui(args: &Args) -> Result<(), String> {
    let mut app = load(args)?;
    let mut player = match open_output(&args.port) {
        Ok(p) => Some(p),
        Err(e) => {
            app.error = Some(format!("MIDI: {e}"));
            None
        }
    };
    let mut terminal = ratatui::init();
    let result = (|| -> std::io::Result<()> {
        loop {
            let play = match &player {
                Some(p) => PlayView {
                    port: Some(p.port_name.clone()),
                    playing: p.is_playing(),
                    chord: p.shared.chord.load(Ordering::Relaxed),
                    max_late_us: p.shared.max_late_us.load(Ordering::Relaxed),
                    sent: p.shared.sent.load(Ordering::Relaxed),
                },
                None => PlayView::default(),
            };
            terminal.draw(|f| view::render(f, &app, &play))?;
            if !event::poll(Duration::from_millis(66))? {
                continue;
            }
            let Event::Key(k) = event::read()? else {
                continue;
            };
            if k.kind != KeyEventKind::Press {
                continue;
            }
            if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                break;
            }
            let Some(key) = to_key(k.code) else { continue };
            match app.handle(key) {
                Action::None => {}
                Action::Quit => break,
                Action::TogglePlay => match player.as_mut() {
                    Some(p) if p.is_playing() => {
                        p.stop();
                        app.status = "→ stopped".into();
                    }
                    Some(p) => {
                        p.play(&app.song, app.looped);
                        app.status = format!("→ playing on {}", p.port_name);
                    }
                    None => app.status = "→ no MIDI output; restart with --port".into(),
                },
                Action::Save => {
                    app.status = match &args.song {
                        Some(path) => match std::fs::write(path, app.song.to_json() + "\n") {
                            Ok(()) => format!("→ wrote {}", path.display()),
                            Err(e) => format!("→ write failed: {e}"),
                        },
                        None => "→ no --song path to write to".into(),
                    }
                }
            }
        }
        Ok(())
    })();
    if let Some(p) = player.as_mut() {
        p.stop();
    }
    ratatui::restore();
    result.map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let result = if args.list_ports {
        list_ports().map(|s| print!("{s}"))
    } else if args.latency {
        let route = match (&args.out, &args.inp) {
            (Some(o), Some(i)) => Some((o.as_str(), i.as_str())),
            (None, None) => None,
            _ => {
                eprintln!("--out and --in go together");
                return ExitCode::from(2);
            }
        };
        latency::run(args.count, route).map(|s| println!("{s}"))
    } else {
        run_tui(&args)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("croky-tui: {e}");
            ExitCode::FAILURE
        }
    }
}
