//! The n-gram table (`ngrams.json` schema 1) and next-chord suggestions with stupid backoff
//! (port of `suggest.ts`). Probabilities are count / row total, as in TS.

use std::collections::HashMap;

use serde::Deserialize;

use crate::theory::Mode;

pub const DEFAULT_MIN_CONTEXT_COUNT: f64 = 20.0;
pub const DEFAULT_SUGGESTION_LIMIT: usize = 12;

#[derive(Clone, Debug, Deserialize)]
pub struct NgramMode {
    pub sections: f64,
    /// context ("" | "I" | "IV,I") -> next token -> count
    pub ngrams: HashMap<String, HashMap<String, f64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NgramTable {
    pub schema: u32,
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

impl NgramTable {
    /// Parse and check the header fields (schema, token format, mode names).
    pub fn from_json(json: &str) -> Result<NgramTable, TableError> {
        let table: NgramTable =
            serde_json::from_str(json).map_err(|e| TableError(format!("ngram table: {e}")))?;
        if table.schema != 1 {
            return Err(TableError("schema: expected 1".into()));
        }
        if table.token_format != "roman-numeral-v1" {
            return Err(TableError(
                "tokenFormat: expected \"roman-numeral-v1\"".into(),
            ));
        }
        if let Some(bad) = table.modes.keys().find(|m| Mode::from_name(m).is_none()) {
            return Err(TableError(format!("modes.{bad}: unknown mode")));
        }
        Ok(table)
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

#[derive(Clone, Copy, Debug)]
pub struct SuggestOptions {
    pub max_context: Option<usize>,
    pub min_context_count: f64,
    pub limit: usize,
}

impl Default for SuggestOptions {
    fn default() -> Self {
        SuggestOptions {
            max_context: None,
            min_context_count: DEFAULT_MIN_CONTEXT_COUNT,
            limit: DEFAULT_SUGGESTION_LIMIT,
        }
    }
}

fn rank_row(row: &HashMap<String, f64>, context_used: &[String], limit: usize) -> Vec<Suggestion> {
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
    opts: SuggestOptions,
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
            return rank_row(row, used, opts.limit);
        }
    }
    Vec::new()
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
