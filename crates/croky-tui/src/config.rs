//! Settings: the config file (`$XDG_CONFIG_HOME/croky-chords/tui.toml`, TOML), overridden by the
//! command line. Every key is optional:
//!
//! ```toml
//! port = "rtpmidid"          # MIDI output: "virtual", part of a port name, or a port index
//! table = "/path/to/default.json"
//! data_dir = "/var/lib/croky" # saves in <data_dir>/saves, device state in <data_dir>/tui-state.json
//! realtime_priority = 40      # SCHED_FIFO priority of the scheduler thread; 0 = normal scheduling
//! audition = true             # sound a picked chord while stopped
//! ```

use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const DEFAULT_PORT: &str = "virtual";
pub const DEFAULT_PRIORITY: i32 = 40;
/// Where the table is looked for when none is given (relative to the working directory).
pub const REPO_TABLE: &str = "apps/web/public/data/default.json";

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    pub port: Option<String>,
    pub table: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub realtime_priority: Option<i32>,
    pub audition: Option<bool>,
}

impl FileConfig {
    pub fn parse(text: &str) -> Result<FileConfig, String> {
        toml::from_str(text).map_err(|e| e.to_string())
    }

    /// Read `path`; a missing file is an empty config unless it was named explicitly.
    pub fn load(path: &Path, explicit: bool) -> Result<FileConfig, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => FileConfig::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !explicit => {
                Ok(FileConfig::default())
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }
}

/// The settings in effect.
#[derive(Debug, PartialEq)]
pub struct Config {
    pub port: String,
    /// `None`: look in the usual places (`table_candidates`), else use the seed table.
    pub table: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub realtime_priority: i32,
    pub audition: bool,
}

/// `$name` when set and not empty.
fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn home() -> PathBuf {
    env_path("HOME").unwrap_or_else(|| PathBuf::from("."))
}

/// `$XDG_CONFIG_HOME/croky-chords/tui.toml` (default `~/.config/...`).
pub fn default_config_path() -> PathBuf {
    env_path("XDG_CONFIG_HOME")
        .unwrap_or_else(|| home().join(".config"))
        .join("croky-chords/tui.toml")
}

/// `$XDG_DATA_HOME/croky-chords` (default `~/.local/share/croky-chords`).
pub fn default_data_dir() -> PathBuf {
    env_path("XDG_DATA_HOME")
        .unwrap_or_else(|| home().join(".local/share"))
        .join("croky-chords")
}

impl Config {
    /// Combine the file with the command line (`Some` values win).
    pub fn resolve(
        file: FileConfig,
        port: Option<String>,
        table: Option<PathBuf>,
        data_dir: Option<PathBuf>,
    ) -> Config {
        Config {
            port: port
                .or(file.port)
                .unwrap_or_else(|| DEFAULT_PORT.to_string()),
            table: table.or(file.table),
            data_dir: data_dir.or(file.data_dir).unwrap_or_else(default_data_dir),
            realtime_priority: file.realtime_priority.unwrap_or(DEFAULT_PRIORITY),
            audition: file.audition.unwrap_or(true),
        }
    }

    /// Where to look for the table when none is configured: the data dir, then the repository.
    pub fn table_candidates(&self) -> Vec<PathBuf> {
        vec![
            self.data_dir.join("default.json"),
            PathBuf::from(REPO_TABLE),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_file_and_lets_the_command_line_win() {
        let file = FileConfig::parse(
            "port = \"rtpmidid\"\nrealtime_priority = 0\naudition = false\ndata_dir = \"/tmp/x\"\n",
        )
        .unwrap();
        let c = Config::resolve(file, None, Some("t.json".into()), None);
        assert_eq!(c.port, "rtpmidid");
        assert_eq!(c.realtime_priority, 0);
        assert!(!c.audition);
        assert_eq!(c.data_dir, PathBuf::from("/tmp/x"));
        assert_eq!(c.table, Some(PathBuf::from("t.json")));
        let c = Config::resolve(FileConfig::default(), Some("aseq".into()), None, None);
        assert_eq!(c.port, "aseq");
        assert_eq!(c.realtime_priority, DEFAULT_PRIORITY);
        assert!(FileConfig::parse("prot = \"x\"")
            .unwrap_err()
            .contains("unknown field"));
        assert!(FileConfig::load(Path::new("/nonexistent/tui.toml"), false).is_ok());
        assert!(FileConfig::load(Path::new("/nonexistent/tui.toml"), true).is_err());
    }
}
