//! The n-gram table (`ngrams.json` schema 1) and next-chord suggestions with stupid backoff
//! (port of `suggest.ts`). Probabilities are count / row total, as in TS.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::theory::Mode;

pub const DEFAULT_MIN_CONTEXT_COUNT: f64 = 20.0;
pub const DEFAULT_SUGGESTION_LIMIT: usize = 12;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NgramSource {
    pub name: String,
    pub description: Option<String>,
    pub license: Option<String>,
    pub exported_at: Option<String>,
}

/// Per-chord statistics of a mode (other fields of the JSON are not kept).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NgramChordInfo {
    pub count: f64,
    pub song_count: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct NgramMode {
    pub sections: f64,
    pub chords: HashMap<String, NgramChordInfo>,
    /// context ("" | "I" | "IV,I") -> next token -> count
    pub ngrams: HashMap<String, HashMap<String, f64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NgramTable {
    #[serde(deserialize_with = "whole_number")]
    pub schema: u32,
    pub source: NgramSource,
    pub generated_at: String,
    #[serde(deserialize_with = "whole_number")]
    pub max_context: usize,
    pub token_format: String,
    pub modes: HashMap<String, NgramMode>,
}

#[derive(Debug)]
pub struct TableError(pub String);

impl std::fmt::Display for TableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TableError {}

/// A whole number that JSON may write as `2` or `2.0` (both are 2 in JS); checked before.
fn whole_number<'de, D: serde::Deserializer<'de>, T: TryFrom<u64>>(d: D) -> Result<T, D::Error> {
    let x = f64::deserialize(d)?;
    T::try_from(x as u64).map_err(|_| serde::de::Error::custom("number out of range"))
}

type Checked = Result<(), TableError>;

fn table_error(path: &str, reason: &str) -> TableError {
    TableError(if path.is_empty() {
        reason.to_string()
    } else {
        format!("{path}: {reason}")
    })
}

fn record<'a>(value: Option<&'a Value>, path: &str) -> Result<&'a Map<String, Value>, TableError> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| table_error(path, "expected an object"))
}

fn count(value: Option<&Value>, path: &str) -> Checked {
    match value.and_then(Value::as_f64) {
        Some(c) if c.is_finite() && c >= 0.0 => Ok(()),
        _ => Err(table_error(path, "expected a non-negative number")),
    }
}

fn string(value: Option<&Value>, path: &str) -> Checked {
    match value {
        Some(Value::String(_)) => Ok(()),
        _ => Err(table_error(path, "expected a string")),
    }
}

/// `parseMode`: the checks in document order, with the TS paths.
fn check_mode(value: &Value, path: &str) -> Checked {
    let obj = record(Some(value), path)?;
    count(obj.get("sections"), &format!("{path}.sections"))?;
    for (token, raw) in record(obj.get("chords"), &format!("{path}.chords"))? {
        let p = format!("{path}.chords.{token}");
        let info = record(Some(raw), &p)?;
        count(info.get("count"), &format!("{p}.count"))?;
        if let Some(song_count) = info.get("songCount") {
            count(Some(song_count), &format!("{p}.songCount"))?;
        }
    }
    for (context, raw) in record(obj.get("ngrams"), &format!("{path}.ngrams"))? {
        let shown = if context.is_empty() { "\"\"" } else { context };
        let p = format!("{path}.ngrams.{shown}");
        for (next, c) in record(Some(raw), &p)? {
            count(Some(c), &format!("{p}.{next}"))?;
        }
    }
    Ok(())
}

/// `parseNgramTable`'s checks in its order, so errors carry the same path and message.
fn check_table(value: &Value) -> Checked {
    let obj = record(Some(value), "")?;
    if obj.get("schema").and_then(Value::as_f64) != Some(1.0) {
        return Err(table_error("schema", "expected 1"));
    }
    if obj.get("tokenFormat").and_then(Value::as_str) != Some("roman-numeral-v1") {
        return Err(table_error("tokenFormat", "expected \"roman-numeral-v1\""));
    }
    count(obj.get("maxContext"), "maxContext")?;
    if !obj["maxContext"]
        .as_f64()
        .is_some_and(crate::json::is_integer)
    {
        return Err(table_error("maxContext", "expected an integer"));
    }
    for (name, raw) in record(obj.get("modes"), "modes")? {
        if Mode::from_name(name).is_none() {
            return Err(table_error(&format!("modes.{name}"), "unknown mode"));
        }
        check_mode(raw, &format!("modes.{name}"))?;
    }
    let source = record(obj.get("source"), "source")?;
    string(source.get("name"), "source.name")?;
    for field in ["description", "license", "exportedAt"] {
        if let Some(v) = source.get(field) {
            string(Some(v), &format!("source.{field}"))?;
        }
    }
    string(obj.get("generatedAt"), "generatedAt")
}

impl NgramTable {
    /// Parse an `ngrams.json` (schema 1). A JSON syntax error is reported as
    /// `ngram table: <serde_json message>`.
    pub fn from_json(json: &str) -> Result<NgramTable, TableError> {
        let value: Value =
            serde_json::from_str(json).map_err(|e| TableError(format!("ngram table: {e}")))?;
        NgramTable::from_value(&value)
    }

    /// `parseNgramTable`: validate a parsed table with the same error paths and messages.
    pub fn from_value(value: &Value) -> Result<NgramTable, TableError> {
        check_table(value)?;
        NgramTable::deserialize(value).map_err(|e| TableError(format!("ngram table: {e}")))
    }

    pub fn mode(&self, mode: Mode) -> Option<&NgramMode> {
        self.modes.get(mode.name())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub token: String,
    pub probability: f64,
    pub count: f64,
    /// The context tokens actually matched; empty for the unigram row.
    pub context_used: Vec<String>,
}

/// Keeps a suggested token (`filter` in TS); applied after ranking, before the limit.
pub type TokenFilter<'a> = &'a dyn Fn(&str) -> bool;

#[derive(Clone, Copy)]
pub struct SuggestOptions<'a> {
    /// Default: the table's `max_context`.
    pub max_context: Option<usize>,
    /// Back off if the matched context has fewer total observations (default 20).
    pub min_context_count: f64,
    /// Default 12.
    pub limit: usize,
    pub filter: Option<TokenFilter<'a>>,
}

impl Default for SuggestOptions<'_> {
    fn default() -> Self {
        SuggestOptions {
            max_context: None,
            min_context_count: DEFAULT_MIN_CONTEXT_COUNT,
            limit: DEFAULT_SUGGESTION_LIMIT,
            filter: None,
        }
    }
}

impl std::fmt::Debug for SuggestOptions<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuggestOptions")
            .field("max_context", &self.max_context)
            .field("min_context_count", &self.min_context_count)
            .field("limit", &self.limit)
            .field("filter", &self.filter.map(|_| "fn"))
            .finish()
    }
}

fn rank_row(
    row: &HashMap<String, f64>,
    context_used: &[String],
    filter: Option<TokenFilter<'_>>,
    limit: usize,
) -> Vec<Suggestion> {
    let total: f64 = row.values().sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let mut entries: Vec<(&String, f64)> = row.iter().map(|(t, &c)| (t, c)).collect();
    // Count descending, then token ascending by UTF-16 code unit as in JS string `<`.
    entries.sort_by(|(ta, ca), (tb, cb)| {
        cb.total_cmp(ca)
            .then_with(|| ta.encode_utf16().cmp(tb.encode_utf16()))
    });
    entries
        .into_iter()
        .filter(|(token, _)| filter.is_none_or(|f| f(token)))
        .take(limit)
        .map(|(token, count)| Suggestion {
            token: token.clone(),
            probability: count / total,
            count,
            context_used: context_used.to_vec(),
        })
        .collect()
}

/// Most likely next chords after `context` (rests removed): the longest context suffix (up to
/// max_context) whose row has >= min_context_count observations; the unigram row is the last
/// resort whatever its total.
pub fn suggest_next(
    table: &NgramTable,
    mode: Mode,
    context: &[String],
    opts: SuggestOptions<'_>,
) -> Vec<Suggestion> {
    let Some(mode_table) = table.mode(mode) else {
        return Vec::new();
    };
    let max_context = opts.max_context.unwrap_or(table.max_context);
    let recent = &context[context.len().saturating_sub(max_context)..];
    for n in (0..=recent.len()).rev() {
        let used = &recent[recent.len() - n..];
        let Some(row) = mode_table.ngrams.get(&used.join(",")) else {
            continue;
        };
        let total: f64 = row.values().sum();
        if total >= opts.min_context_count || (n == 0 && total > 0.0) {
            return rank_row(row, used, opts.filter, opts.limit);
        }
    }
    Vec::new()
}

#[derive(Clone, Copy)]
pub struct PopularOptions<'a> {
    /// Default 12.
    pub limit: usize,
    pub filter: Option<TokenFilter<'a>>,
}

impl Default for PopularOptions<'_> {
    fn default() -> Self {
        PopularOptions {
            limit: DEFAULT_SUGGESTION_LIMIT,
            filter: None,
        }
    }
}

/// `popularChords`: the unigram row, the most common chords of the mode. Probabilities are
/// normalised over the whole row before filter and limit, as in `suggest_next`.
pub fn popular_chords(table: &NgramTable, mode: Mode, opts: PopularOptions<'_>) -> Vec<Suggestion> {
    table
        .mode(mode)
        .and_then(|m| m.ngrams.get(""))
        .map_or_else(Vec::new, |row| rank_row(row, &[], opts.filter, opts.limit))
}

/// `seedTable`: the hand-seeded starter table (major and minor), so the app works without a
/// data build. `data/seed-ngrams.json` is a copy of `packages/core/src/data/seed-ngrams.json`
/// (a parity test keeps them equal).
pub fn seed_table() -> &'static NgramTable {
    static SEED: OnceLock<NgramTable> = OnceLock::new();
    SEED.get_or_init(|| {
        NgramTable::from_json(include_str!("../data/seed-ngrams.json"))
            .expect("the seed table is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> NgramTable {
        NgramTable::from_json(
            r#"{"schema":1,"source":{"name":"t"},"generatedAt":"x","maxContext":2,
            "tokenFormat":"roman-numeral-v1","modes":{"major":{"sections":1,"chords":{},
            "ngrams":{"":{"I":100,"IV":60,"V":60},"I":{"V":30,"IV":30,"vi":10},"V":{"I":15},
            "IV,I":{"V":40,"IV":10}}}}}"#,
        )
        .unwrap()
    }

    fn ctx(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn backs_off_to_shorter_contexts() {
        let t = table();
        let s = suggest_next(
            &t,
            Mode::Major,
            &ctx(&["IV", "I"]),
            SuggestOptions::default(),
        );
        assert_eq!(s[0].token, "V");
        assert_eq!(s[0].context_used, ctx(&["IV", "I"]));
        // "V" has only 15 observations: back off to the unigram row.
        let s = suggest_next(&t, Mode::Major, &ctx(&["V"]), SuggestOptions::default());
        assert!(s[0].context_used.is_empty());
        assert_eq!(s[0].token, "I");
        // Ties sort by token: IV before V.
        let s = suggest_next(&t, Mode::Major, &ctx(&["I"]), SuggestOptions::default());
        assert_eq!(s[0].token, "IV");
        assert!(suggest_next(&t, Mode::Minor, &[], SuggestOptions::default()).is_empty());
    }

    #[test]
    fn rejects_other_schemas() {
        assert!(NgramTable::from_json(
            r#"{"schema":2,"maxContext":1,"tokenFormat":"roman-numeral-v1","modes":{}}"#
        )
        .is_err());
    }
}
