//! `croky-tui --commands` (`docs/specs/assistant-v1.md` §A5): the command API without a screen.
//! One JSON-RPC 2.0 request per line on stdin, one response per line on stdout; a bare command
//! object or array is shorthand for `applyCommands`. Songs are the session's records (saved
//! after every request that changed the song) or the `--song` file (written with `save`).

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::SystemTime;

use croky_core::{
    diatonic_triad_token, is_diatonic_token, is_rest_token, popular_chords, serialize_song,
    song_to_midi, suggest_next, MidiOptions, PopularOptions, SuggestOptions,
};
use serde_json::{json, Map, Value};

use crate::app::App;
use crate::commands::{
    base64, prepare, step, CommandError, Effect, EngineState, OPS, SCHEMA_VERSION,
};
use crate::edit::play_start;
use crate::export;
use crate::player::Player;
use crate::session::{Saved, Session};

/// Opens the MIDI output on first use; `Err` carries the reason.
pub type OpenPlayer = Box<dyn FnMut() -> Result<Player, String>>;

pub struct CommandMode {
    pub app: App,
    session: Session,
    exports: PathBuf,
    audition: bool,
    open: OpenPlayer,
    player: Option<Player>,
}

/// JSON-RPC error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl CommandMode {
    pub fn new(
        app: App,
        session: Session,
        exports: PathBuf,
        audition: bool,
        open: OpenPlayer,
    ) -> Self {
        CommandMode {
            app,
            session,
            exports,
            audition,
            open,
            player: None,
        }
    }

    fn state(&self) -> EngineState {
        EngineState {
            song: self.app.song.clone(),
            selected: self.app.selected,
            looping: self.app.looping,
            loop_range: self.app.loop_range,
            undo: self.app.undo.clone(),
            redo: self.app.redo.clone(),
        }
    }

    /// Write an engine state back into the app; let playback and the saved loop follow.
    fn set_state(&mut self, s: EngineState) {
        let song_changed = s.song != self.app.song;
        let loop_changed = s.looping != self.app.looping || s.loop_range != self.app.loop_range;
        self.app.song = s.song;
        self.app.selected = s.selected;
        self.app.looping = s.looping;
        self.app.loop_range = s.loop_range;
        self.app.undo = s.undo;
        self.app.redo = s.redo;
        if song_changed {
            self.app.revision += 1;
            self.session.dirty = true;
        }
        self.app.refresh();
        if let Some(p) = self.player.as_ref().filter(|p| p.is_playing()) {
            if song_changed {
                p.update(&self.app.song);
            }
            if loop_changed {
                p.set_loop(self.app.looping, self.app.loop_range);
            }
        }
        if loop_changed {
            self.session.set_loop(self.app.loop_state());
        }
    }

    fn player(&mut self) -> Result<&Player, String> {
        if self.player.is_none() {
            self.player = Some((self.open)().map_err(|e| format!("no MIDI output: {e}"))?);
        }
        self.player
            .as_ref()
            .ok_or_else(|| "no MIDI output".to_string())
    }

    fn save(&mut self) -> Result<(), String> {
        match self.session.save(&self.app.song, SystemTime::now())? {
            Saved::Version(_) => Ok(()),
            Saved::Copy { title, .. } => {
                self.app.song.title = title;
                Ok(())
            }
        }
    }

    fn run_effect(
        &mut self,
        effect: &Effect,
        result: &mut Map<String, Value>,
    ) -> Result<(), String> {
        match effect {
            Effect::Play(from) => {
                let song = self.app.song.clone();
                let (looping, range) = (self.app.looping, self.app.loop_range);
                let total = song.total_beats();
                let start =
                    from.map_or_else(|| play_start(looping, range, total), |b| b.min(total));
                self.player()?.play(&song, start, looping, range);
            }
            Effect::Stop => {
                if let Some(p) = &self.player {
                    p.stop();
                }
            }
            Effect::Audition(token) => {
                let channel = self.app.audition_channel();
                let song = self.app.song.clone();
                let audition = self.audition;
                let p = self.player()?;
                if audition && !p.is_playing() {
                    p.audition(&song, token, channel);
                }
            }
            Effect::ExportMidi => {
                let song = &self.app.song;
                let opts = MidiOptions {
                    programs: export::programs(song),
                    ..MidiOptions::default()
                };
                let bytes = song_to_midi(song, &opts).map_err(|e| e.to_string())?;
                let path = export::export(song, &self.exports)?;
                result.insert("fileName".into(), json!(export::file_name(&song.title)));
                result.insert("bytes".into(), json!(bytes.len()));
                result.insert("base64".into(), json!(base64(&bytes)));
                result.insert("path".into(), json!(path.display().to_string()));
            }
            Effect::Save => self.save()?,
        }
        Ok(())
    }

    /// `applyCommands` (§A3): validate, dry-run, then run each command.
    pub fn apply(&mut self, input: &Value, batch: bool) -> Value {
        let commands = match prepare(&self.state(), input, batch) {
            Ok(c) => c,
            Err(e) => {
                return json!({ "ok": false, "applied": 0, "results": [], "error": e.to_json() })
            }
        };
        let before = self.app.song.clone();
        let base = self.app.undo.len();
        let mut results = Vec::new();
        let mut failure: Option<CommandError> = None;
        for (index, cmd) in commands.iter().enumerate() {
            let mut state = self.state();
            let outcome = match step(&mut state, cmd) {
                Ok(o) => o,
                Err(p) => {
                    failure = Some(CommandError {
                        code: p.code,
                        index,
                        op: Some(cmd.op().into()),
                        path: p.path,
                        message: p.message,
                    });
                    break;
                }
            };
            self.set_state(state);
            let mut result = outcome.result;
            for effect in &outcome.effects {
                if let Err(message) = self.run_effect(effect, &mut result) {
                    failure = Some(CommandError {
                        code: "failed",
                        index,
                        op: Some(cmd.op().into()),
                        path: String::new(),
                        message,
                    });
                    break;
                }
            }
            if failure.is_some() {
                break;
            }
            results.push(Value::Object(result));
        }
        if batch && self.app.song != before {
            // One undo step for the whole batch: the song before it.
            self.app.undo.truncate(base);
            self.app.undo.push(before);
        }
        if self.session.dirty && !self.session.is_file() {
            if let Err(e) = self.save() {
                eprintln!("croky-tui: save failed: {e}");
            }
        }
        let applied = results.len();
        match failure {
            None => json!({ "ok": true, "applied": applied, "results": results }),
            Some(e) => {
                json!({ "ok": false, "applied": applied, "results": results, "error": e.to_json() })
            }
        }
    }

    pub fn get_song(&self) -> Value {
        serde_json::from_str(&serialize_song(&self.app.song)).unwrap_or(Value::Null)
    }

    pub fn get_state(&self) -> Value {
        let (playing, position, port) = match &self.player {
            Some(p) => (
                p.is_playing(),
                p.position().unwrap_or(0.0),
                Some(p.port_name.clone()),
            ),
            None => (false, 0.0, None),
        };
        let range = self
            .app
            .loop_range
            .map(|r| json!({ "start": r.start, "end": r.end }));
        json!({
            "selected": self.app.selected,
            "playing": playing,
            "cursor": position,
            "loop": { "enabled": self.app.looping, "range": range },
            "canUndo": !self.app.undo.is_empty(),
            "canRedo": !self.app.redo.is_empty(),
            "table": { "status": "loaded", "name": self.app.table_name },
            "audioReady": false,
            "midi": port,
        })
    }

    /// The Next chord list for a slot (`{ at?, limit?, popular?, diatonicOnly? }`).
    pub fn suggestions(&self, params: &Value) -> Value {
        let song = &self.app.song;
        let at = match params.get("at") {
            Some(Value::Null) => None,
            Some(v) => v.as_u64().map(|i| i as usize),
            None => self.app.selected,
        };
        let end = at.unwrap_or(song.chords.len()).min(song.chords.len());
        let context: Vec<String> = song.chords[..end]
            .iter()
            .filter(|c| !is_rest_token(&c.token))
            .map(|c| c.token.clone())
            .collect();
        let mode = song.key.mode;
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(16, |l| l.clamp(1, 16) as usize);
        let diatonic = params
            .get("diatonicOnly")
            .and_then(Value::as_bool)
            .unwrap_or(self.app.diatonic_only);
        let keep = |t: &str| is_diatonic_token(t, mode);
        let filter: Option<&dyn Fn(&str) -> bool> = if diatonic { Some(&keep) } else { None };
        let popular = params.get("popular").and_then(Value::as_bool) == Some(true);
        if self.app.table.mode(mode).is_none() {
            let items: Vec<Value> = (1..=7)
                .map(|d| {
                    let token = diatonic_triad_token(d, mode);
                    json!({ "token": token, "name": self.app.name(&token), "probability": null })
                })
                .collect();
            return json!({ "context": "no data for this mode: diatonic triads", "items": items });
        }
        let list = if popular {
            popular_chords(&self.app.table, mode, PopularOptions { limit, filter })
        } else {
            let opts = SuggestOptions {
                limit,
                filter,
                ..SuggestOptions::default()
            };
            suggest_next(&self.app.table, mode, &context, opts)
        };
        let used = list
            .first()
            .map(|s| s.context_used.clone())
            .unwrap_or_default();
        let items: Vec<Value> = list
            .iter()
            .map(|s| json!({ "token": s.token, "name": self.app.name(&s.token), "probability": s.probability }))
            .collect();
        let context = if used.is_empty() {
            "any position".to_string()
        } else {
            format!("after {}", used.join(", "))
        };
        json!({ "context": context, "items": items })
    }

    pub fn commands(&self) -> Value {
        let ops: Vec<Value> = OPS
            .iter()
            .map(
                |(op, kind)| json!({ "op": op, "kind": kind, "supported": *op != "setInstrument" }),
            )
            .collect();
        json!({ "version": SCHEMA_VERSION, "ops": ops })
    }

    /// Answer one input line; None for a blank line.
    pub fn handle_line(&mut self, line: &str) -> Option<Value> {
        if line.trim().is_empty() {
            return None;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                return Some(rpc_error(
                    &Value::Null,
                    PARSE_ERROR,
                    &format!("parse error: {e}"),
                ))
            }
        };
        let is_rpc = value.get("jsonrpc").is_some() || value.get("method").is_some();
        if !is_rpc {
            if value.is_array() || value.get("op").is_some() {
                return Some(self.apply(&value, false));
            }
            return Some(rpc_error(
                &Value::Null,
                INVALID_REQUEST,
                "expected a JSON-RPC request or commands",
            ));
        }
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let (Some("2.0"), Some(method)) = (
            value.get("jsonrpc").and_then(Value::as_str),
            value.get("method").and_then(Value::as_str),
        ) else {
            return Some(rpc_error(
                &id,
                INVALID_REQUEST,
                "expected \"jsonrpc\": \"2.0\" and a method",
            ));
        };
        let params = value.get("params").cloned().unwrap_or(json!({}));
        let result = match method {
            "getSong" => self.get_song(),
            "getState" => self.get_state(),
            "commands" => self.commands(),
            "suggestions" => self.suggestions(&params),
            "applyCommands" => {
                let Some(commands) = params.get("commands") else {
                    return Some(rpc_error(
                        &id,
                        INVALID_PARAMS,
                        "params.commands is required",
                    ));
                };
                let batch = match params.get("undo").and_then(Value::as_str) {
                    None | Some("each") => false,
                    Some("batch") => true,
                    Some(_) => {
                        return Some(rpc_error(
                            &id,
                            INVALID_PARAMS,
                            "params.undo is 'each' or 'batch'",
                        ))
                    }
                };
                self.apply(commands, batch)
            }
            _ => {
                return Some(rpc_error(
                    &id,
                    METHOD_NOT_FOUND,
                    &format!("unknown method {method}"),
                ))
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    /// Stop playback (end of input).
    pub fn finish(&mut self) {
        if let Some(p) = &self.player {
            p.stop();
        }
        if self.session.dirty && !self.session.is_file() {
            let _ = self.save();
        }
    }
}

/// Read requests from `input` until it ends, answering on `output`.
pub fn serve(
    mode: &mut CommandMode,
    input: impl BufRead,
    mut output: impl Write,
) -> Result<(), String> {
    for line in input.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Some(response) = mode.handle_line(&line) {
            writeln!(output, "{response}").map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
        }
    }
    mode.finish();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::saves::tests::temp_dir;
    use crate::testdata::table;
    use croky_core::create_song;

    fn mode(dir: &std::path::Path) -> CommandMode {
        let mut session = Session::new(dir.to_path_buf());
        let opened = session.start().unwrap();
        let mut app = App::new(create_song(), table(), "default.json".into());
        app.load(opened.song, opened.looping);
        CommandMode::new(
            app,
            session,
            dir.join("exports"),
            true,
            Box::new(|| Err("no port in tests".into())),
        )
    }

    fn rpc(m: &mut CommandMode, line: &str) -> Value {
        m.handle_line(line).unwrap()
    }

    #[test]
    fn json_rpc_round_trip_and_shorthand() {
        let dir = temp_dir("rpc");
        let mut m = mode(&dir);
        let r = rpc(
            &mut m,
            r#"{"jsonrpc":"2.0","id":1,"method":"applyCommands","params":{"commands":[{"op":"appendChord","token":"I"},{"op":"appendChord","token":"V"},{"op":"appendChord","token":"vi"},{"op":"appendChord","token":"IV"}]}}"#,
        );
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["ok"], true);
        assert_eq!(r["result"]["applied"], 4);
        let song = rpc(&mut m, r#"{"jsonrpc":"2.0","id":2,"method":"getSong"}"#);
        let tokens: Vec<&str> = song["result"]["chords"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["token"].as_str().unwrap())
            .collect();
        assert_eq!(tokens, ["I", "V", "vi", "IV"]);
        assert_eq!(song["result"]["schema"], 4);

        // A bare command is answered with the ApplyResult itself.
        let r = rpc(&mut m, r#"{"op":"addNote","beat":0,"length":2,"degree":3}"#);
        assert_eq!(r["ok"], true);
        assert_eq!(r["results"][0]["index"], 0);

        let state = rpc(&mut m, r#"{"jsonrpc":"2.0","id":"s","method":"getState"}"#);
        assert_eq!(state["result"]["canUndo"], true);
        assert_eq!(state["result"]["playing"], false);

        let s = rpc(
            &mut m,
            r#"{"jsonrpc":"2.0","id":3,"method":"suggestions","params":{"limit":3}}"#,
        );
        assert_eq!(s["result"]["items"].as_array().unwrap().len(), 3);
        assert!(s["result"]["context"]
            .as_str()
            .unwrap()
            .starts_with("after "));

        let list = rpc(&mut m, r#"{"jsonrpc":"2.0","id":4,"method":"commands"}"#);
        assert_eq!(list["result"]["ops"].as_array().unwrap().len(), OPS.len());

        // Records are saved after every request that changed the song.
        let saves = std::fs::read_dir(dir.join("saves")).unwrap().count();
        assert_eq!(saves, 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_play_and_errors() {
        let dir = temp_dir("rpc-export");
        let mut m = mode(&dir);
        let r = m.apply(
            &json!([{ "op": "appendChord", "token": "I" }, { "op": "setTitle", "title": "Axis" }, { "op": "exportMidi" }]),
            false,
        );
        assert_eq!(r["ok"], true, "{r}");
        let export = &r["results"][2];
        assert_eq!(export["fileName"], "Axis.mid");
        assert!(export["base64"].as_str().unwrap().starts_with("TVRoZ"));
        assert!(std::path::Path::new(export["path"].as_str().unwrap()).exists());

        // No MIDI port: play fails at run time, the commands before it stay applied.
        let r = m.apply(
            &json!([{ "op": "appendChord", "token": "V" }, { "op": "play" }]),
            false,
        );
        assert_eq!(r["ok"], false);
        assert_eq!(r["applied"], 1);
        assert_eq!(r["error"]["code"], "failed");
        assert_eq!(m.app.song.chords.len(), 2);

        // A batch is one undo step.
        let r = m.apply(
            &json!([{ "op": "appendChord", "token": "vi" }, { "op": "appendChord", "token": "IV" }]),
            true,
        );
        assert_eq!(r["ok"], true);
        m.apply(&json!({ "op": "undo" }), false);
        assert_eq!(m.app.song.chords.len(), 2);

        assert_eq!(rpc(&mut m, "not json")["error"]["code"], PARSE_ERROR);
        assert_eq!(
            rpc(&mut m, r#"{"jsonrpc":"2.0","id":1,"method":"nope"}"#)["error"]["code"],
            METHOD_NOT_FOUND
        );
        assert_eq!(
            rpc(
                &mut m,
                r#"{"jsonrpc":"2.0","id":1,"method":"applyCommands"}"#
            )["error"]["code"],
            INVALID_PARAMS
        );
        assert_eq!(
            rpc(&mut m, r#"{"hello":1}"#)["error"]["code"],
            INVALID_REQUEST
        );
        assert!(m.handle_line("   ").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn serve_answers_line_by_line() {
        let dir = temp_dir("rpc-serve");
        let mut m = mode(&dir);
        let input = b"{\"op\":\"appendChord\",\"token\":\"ii\"}\n\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"getState\"}\n";
        let mut out = Vec::new();
        serve(&mut m, &input[..], &mut out).unwrap();
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["ok"], true);
        assert_eq!(lines[1]["id"], 7);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
