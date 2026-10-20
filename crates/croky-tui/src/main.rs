//! croky-tui: Croky Chords in the terminal, for a headless machine that sends MIDI to a DAW.
//! Chord grid with replace-first editing, Next chord suggestions, the band (every track with its
//! pattern, plus the melody) played to an ALSA sequencer port on a real-time scheduler thread,
//! loop points, and songs saved as SaveStore records. See docs/specs/tui-v1.md. `--commands`
//! drives the same editor with JSON commands over stdin (docs/specs/assistant-v1.md §A5).

mod app;
mod commands;
mod config;
mod edit;
mod export;
mod jitter;
mod keys;
mod latency;
mod player;
#[cfg(test)]
mod render_tests;
mod rpc;
mod saves;
mod session;
#[cfg(test)]
mod testdata;
mod view;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime};

use croky_core::{create_song, seed_table, NgramTable};
use midir::{MidiOutput, MidiOutputConnection};
use ratatui::crossterm::event::{
    self, Event, KeyEventKind, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::{execute, terminal};

use app::{App, Effect, PlayView, SavesView, Screen};
use config::{default_config_path, Config, FileConfig};
use player::Player;
use rpc::{serve, CommandMode, OpenPlayer};
use session::{Opened, Saved, Session};

const USAGE: &str = "\
croky-tui [options]

  --config PATH       settings file (default $XDG_CONFIG_HOME/croky-chords/tui.toml)
  --port NAME         MIDI output: 'virtual' (default, creates port croky-tui:out),
                      part of a port name (e.g. rtpmidid), or a port index
  --table PATH        n-gram table (default: <data dir>/default.json, then
                      apps/web/public/data/default.json, else the built-in seed table)
  --data DIR          saves in DIR/saves, .mid exports in DIR/exports
                      (default $XDG_DATA_HOME/croky-chords)
  --song PATH         edit this file instead (a song JSON or a save record); w writes it back
  --commands          no screen: read JSON-RPC requests (or bare commands) from stdin, one per
                      line, and answer on stdout (docs/howto/agents.md)
  --list-ports        list MIDI outputs and inputs, then exit
  --latency-test      measure MIDI round trips through an in-process loopback and exit
    --count N         round trips (default 500)
    --out NAME --in NAME   measure through an external echo path instead
  --jitter-test       play a band through the scheduler into an in-process loopback and
                      report the timing error per note (acceptance: p99 < 0.5 ms)
    --seconds S       how long (default 10)";

/// Autosave this long after the last change (records only; `--song` files are written with w).
const AUTOSAVE_AFTER: Duration = Duration::from_millis(1000);
/// Screen refresh while idle; keys are handled as they come.
const FRAME: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Args {
    config: Option<PathBuf>,
    table: Option<PathBuf>,
    data: Option<PathBuf>,
    song: Option<PathBuf>,
    port: Option<String>,
    list_ports: bool,
    latency: bool,
    jitter: bool,
    commands: bool,
    seconds: f64,
    count: usize,
    out: Option<String>,
    inp: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        count: 500,
        seconds: 10.0,
        ..Args::default()
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--config" => a.config = Some(value()?.into()),
            "--table" => a.table = Some(value()?.into()),
            "--data" => a.data = Some(value()?.into()),
            "--song" => a.song = Some(value()?.into()),
            "--port" => a.port = Some(value()?),
            "--list-ports" => a.list_ports = true,
            "--latency-test" => a.latency = true,
            "--jitter-test" => a.jitter = true,
            "--commands" => a.commands = true,
            "--count" => a.count = value()?.parse().map_err(|_| "--count needs a number")?,
            "--seconds" => {
                a.seconds = value()?
                    .parse()
                    .ok()
                    .filter(|s: &f64| *s > 0.0 && s.is_finite())
                    .ok_or("--seconds needs a positive number")?
            }
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

/// Open the MIDI output; `Err` carries the reason, shown on screen (the TUI still runs).
fn open_output(port: &str) -> Result<(MidiOutputConnection, String), String> {
    let out = MidiOutput::new("croky-tui").map_err(|e| e.to_string())?;
    if port == "virtual" {
        use midir::os::unix::VirtualOutput;
        let conn = out.create_virtual("out").map_err(|e| e.to_string())?;
        return Ok((conn, "croky-tui:out (virtual)".into()));
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
    Ok((conn, name))
}

/// The configured table, else the first one found, else the seed table (with a warning).
fn load_table(config: &Config) -> Result<(NgramTable, String, Option<String>), String> {
    let read = |p: &PathBuf| -> Result<NgramTable, String> {
        let text = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
        NgramTable::from_json(&text).map_err(|e| format!("{}: {e}", p.display()))
    };
    let name = |p: &PathBuf| {
        p.file_name()
            .map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into())
    };
    if let Some(path) = &config.table {
        return Ok((read(path)?, name(path), None));
    }
    for path in config.table_candidates() {
        if path.exists() {
            return Ok((read(&path)?, name(&path), None));
        }
    }
    Ok((
        seed_table().clone(),
        "seed table".into(),
        Some("no default.json found (see --table); using the small seed table".into()),
    ))
}

struct Runtime {
    app: App,
    session: Session,
    player: Option<Player>,
    config: Config,
    /// `app.revision` that the session and the player have seen.
    seen: u64,
    last_change: Instant,
    /// q was pressed with unsaved changes in a `--song` file.
    quit_armed: bool,
}

impl Runtime {
    fn play_view(&self) -> PlayView {
        match &self.player {
            Some(p) => {
                let (sent, p99, max) = p.shared.late.summary();
                PlayView {
                    port: Some(p.port_name.clone()),
                    playing: p.is_playing(),
                    position: p.position(),
                    sent,
                    late_p99_us: p99,
                    late_max_us: max,
                    sched: p.sched(),
                }
            }
            None => PlayView::default(),
        }
    }

    fn is_playing(&self) -> bool {
        self.player.as_ref().is_some_and(Player::is_playing)
    }

    /// The song changed (edit or undo): mark it for the autosave and let playback follow.
    fn sync_revision(&mut self) {
        if self.app.revision == self.seen {
            return;
        }
        self.seen = self.app.revision;
        self.session.dirty = true;
        self.last_change = Instant::now();
        self.quit_armed = false;
        if let Some(p) = self.player.as_ref().filter(|p| p.is_playing()) {
            p.update(&self.app.song);
        }
    }

    fn save(&mut self) {
        match self.session.save(&self.app.song, SystemTime::now()) {
            Ok(Saved::Version(v)) => {
                self.app.status = if self.session.is_file() {
                    "→ written".into()
                } else {
                    format!("→ saved v{v}")
                };
            }
            Ok(Saved::Copy { title, .. }) => {
                // Another program saved this record first: both versions are kept.
                self.app.song.title = title.clone();
                self.app.status = format!("→ saved elsewhere meanwhile; kept yours as \"{title}\"");
            }
            Err(e) => self.app.status = format!("→ save failed: {e}"),
        }
    }

    /// Save pending edits of a record before switching songs or quitting.
    fn flush(&mut self) {
        if self.session.dirty && !self.session.is_file() {
            self.save();
        }
    }

    fn autosave(&mut self) {
        if self.session.dirty
            && !self.session.is_file()
            && self.last_change.elapsed() >= AUTOSAVE_AFTER
        {
            self.save();
        }
    }

    fn load(&mut self, opened: Opened) {
        if let Some(p) = &self.player {
            p.stop();
        }
        self.app.load(opened.song, opened.looping);
        self.seen = self.app.revision;
        self.session.dirty = false;
    }

    fn show_saves(&mut self, index: usize) {
        match self.session.list() {
            Ok((list, unreadable)) => {
                let index = index.min(list.len().saturating_sub(1));
                self.app.screen = Screen::Saves(SavesView {
                    list,
                    unreadable,
                    index,
                    confirm_delete: false,
                    current: self.session.current_id().map(String::from),
                });
            }
            Err(e) => self.app.status = format!("→ cannot list saves: {e}"),
        }
    }

    /// Carry out an effect; false to quit.
    fn apply(&mut self, effect: Effect) -> bool {
        let song = &self.app.song;
        match effect {
            Effect::None => {}
            Effect::TogglePlay | Effect::PlayFrom(_) => match &self.player {
                None => self.app.status = "→ no MIDI output; restart with --port".into(),
                Some(p) if effect == Effect::TogglePlay && p.is_playing() => {
                    p.stop();
                    self.app.status = "→ stopped".into();
                }
                Some(_) if song.chords.is_empty() => {
                    self.app.status = "→ nothing to play yet".into()
                }
                Some(p) => {
                    let total = song.total_beats();
                    let from = match effect {
                        Effect::PlayFrom(beat) => beat,
                        _ => edit::play_start(self.app.looping, self.app.loop_range, total),
                    };
                    p.play(song, from, self.app.looping, self.app.loop_range);
                    self.app.status = format!("→ playing on {}", p.port_name);
                }
            },
            Effect::LoopChanged => {
                if let Some(p) = &self.player {
                    p.set_loop(self.app.looping, self.app.loop_range);
                }
                self.session.set_loop(self.app.loop_state());
            }
            Effect::Audition(token) => {
                if let Some(p) = self.player.as_ref().filter(|_| self.config.audition) {
                    if !p.is_playing() {
                        p.audition(song, &token, self.app.audition_channel());
                    }
                }
            }
            Effect::Save => self.save(),
            Effect::Export => {
                let dir = self.config.data_dir.join("exports");
                self.app.status = match export::export(song, &dir) {
                    Ok(path) => format!("→ wrote {}", path.display()),
                    Err(e) => format!("→ export failed: {e}"),
                };
            }
            Effect::OpenSaves => {
                self.flush();
                self.show_saves(0);
            }
            Effect::Open(id) => {
                self.flush();
                match self.session.open(&id) {
                    Ok(opened) => {
                        self.load(opened);
                        self.app.screen = Screen::Editor;
                        self.app.status = format!("→ opened {}", self.app.song.title);
                    }
                    Err(e) => self.app.status = format!("→ cannot open: {e}"),
                }
            }
            Effect::NewSong => {
                self.flush();
                let opened = self.session.new_song();
                self.load(opened);
                self.app.screen = Screen::Editor;
                self.app.status = "→ new song (saved after the first change)".into();
            }
            Effect::Delete(id) => {
                let index = match &self.app.screen {
                    Screen::Saves(v) => v.index,
                    _ => 0,
                };
                match self.session.delete(&id) {
                    Ok(opened) => {
                        if let Some(opened) = opened {
                            self.load(opened);
                        }
                        self.app.status = "→ deleted".into();
                        self.show_saves(index);
                    }
                    Err(e) => self.app.status = format!("→ delete failed: {e}"),
                }
            }
            Effect::Quit => {
                if self.session.is_file() && self.session.dirty && !self.quit_armed {
                    self.quit_armed = true;
                    self.app.status = "→ unsaved changes: w writes the file, q again quits".into();
                    return true;
                }
                self.flush();
                return false;
            }
        }
        true
    }
}

fn run_tui(args: Args, config: Config) -> Result<(), String> {
    let (table, table_name, warning) = load_table(&config)?;
    let mut session = Session::new(config.data_dir.clone());
    let opened = match &args.song {
        Some(path) => session.open_file(path.clone())?,
        None => session.start()?,
    };
    let mut app = App::new(create_song(), table, table_name);
    app.load(opened.song, opened.looping);
    app.status = warning.unwrap_or_default();
    let player = match open_output(&config.port) {
        Ok((conn, name)) => Some(Player::new(conn, name, config.realtime_priority)),
        Err(e) => {
            app.error = Some(format!("MIDI: {e}"));
            None
        }
    };
    let mut rt = Runtime {
        seen: app.revision,
        app,
        session,
        player,
        config,
        last_change: Instant::now(),
        quit_armed: false,
    };

    let mut terminal = ratatui::init();
    // Kitty keyboard protocol where the terminal has it: Shift+Enter, Alt+[ and Esc arrive
    // unambiguously. The Linux console does not; the plain-key aliases cover it.
    let enhanced = terminal::supports_keyboard_enhancement().unwrap_or(false);
    if enhanced {
        let _ = execute!(
            std::io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        );
    }
    let result = (|| -> std::io::Result<()> {
        loop {
            rt.app.save_label = rt.session.label();
            let play = rt.play_view();
            terminal.draw(|f| view::render(f, &rt.app, &play))?;
            rt.autosave();
            if !event::poll(FRAME)? {
                continue;
            }
            let Event::Key(k) = event::read()? else {
                continue;
            };
            if k.kind == KeyEventKind::Release {
                continue;
            }
            let Some(key) = keys::from_event(k) else {
                continue;
            };
            let effect = rt.app.handle(key);
            rt.sync_revision();
            if !rt.apply(effect) {
                break;
            }
            rt.sync_revision();
        }
        Ok(())
    })();
    if rt.is_playing() {
        if let Some(p) = &rt.player {
            p.stop();
        }
    }
    drop(rt.player.take());
    if enhanced {
        let _ = execute!(std::io::stdout(), PopKeyboardEnhancementFlags);
    }
    ratatui::restore();
    let _ = std::io::stdout().flush();
    result.map_err(|e| e.to_string())
}

/// `--commands`: the command API over stdin/stdout, no terminal UI.
fn run_commands(args: Args, config: Config) -> Result<(), String> {
    let (table, table_name, warning) = load_table(&config)?;
    if let Some(w) = warning {
        eprintln!("croky-tui: {w}");
    }
    let mut session = Session::new(config.data_dir.clone());
    let opened = match &args.song {
        Some(path) => session.open_file(path.clone())?,
        None => session.start()?,
    };
    let mut app = App::new(create_song(), table, table_name);
    app.load(opened.song, opened.looping);
    let port = config.port.clone();
    let priority = config.realtime_priority;
    let open: OpenPlayer = Box::new(move || {
        let (conn, name) = open_output(&port)?;
        Ok(Player::new(conn, name, priority))
    });
    let exports = config.data_dir.join("exports");
    let mut mode = CommandMode::new(app, session, exports, config.audition, open);
    serve(&mut mode, std::io::stdin().lock(), std::io::stdout().lock())
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
        let config_path = args.config.clone().unwrap_or_else(default_config_path);
        let file = match FileConfig::load(&config_path, args.config.is_some()) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("croky-tui: {e}");
                return ExitCode::from(2);
            }
        };
        let config = Config::resolve(
            file,
            args.port.clone(),
            args.table.clone(),
            args.data.clone(),
        );
        if args.jitter {
            jitter::run(args.seconds, config.realtime_priority).map(|r| println!("{}", r.text()))
        } else if args.commands {
            run_commands(args, config)
        } else {
            run_tui(args, config)
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("croky-tui: {e}");
            ExitCode::FAILURE
        }
    }
}
