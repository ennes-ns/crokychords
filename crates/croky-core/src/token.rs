//! The chord model and the `roman-numeral-v1` token grammar (port of `token.ts` and the
//! types of `chords.ts`). `format_token(parse_token(t)) == t` for every fixture token.

use std::fmt;

pub const REST_TOKEN: &str = "rest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    Major,
    Minor,
    Dim,
    Aug,
}

/// Seventh-and-up extension; the diminished family (`ø7`, `°7`, ...) carries its own sign.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extension {
    None,
    Seven,
    Maj7,
    Half7,
    Dim7,
    Nine,
    Maj9,
    Half9,
    Dim9,
    Eleven,
    Maj11,
    Half11,
    Dim11,
    Thirteen,
    Maj13,
    Half13,
    Dim13,
}

impl Extension {
    /// Longest first so that 'maj13' wins over 'maj1...' and '13' over '1...'.
    const BY_SPELLING_LENGTH: [Extension; 16] = [
        Extension::Maj13,
        Extension::Maj11,
        Extension::Maj9,
        Extension::Maj7,
        Extension::Half13,
        Extension::Half11,
        Extension::Half9,
        Extension::Half7,
        Extension::Dim13,
        Extension::Dim11,
        Extension::Dim9,
        Extension::Dim7,
        Extension::Thirteen,
        Extension::Eleven,
        Extension::Nine,
        Extension::Seven,
    ];

    pub fn spelling(self) -> &'static str {
        match self {
            Extension::None => "",
            Extension::Seven => "7",
            Extension::Maj7 => "maj7",
            Extension::Half7 => "ø7",
            Extension::Dim7 => "°7",
            Extension::Nine => "9",
            Extension::Maj9 => "maj9",
            Extension::Half9 => "ø9",
            Extension::Dim9 => "°9",
            Extension::Eleven => "11",
            Extension::Maj11 => "maj11",
            Extension::Half11 => "ø11",
            Extension::Dim11 => "°11",
            Extension::Thirteen => "13",
            Extension::Maj13 => "maj13",
            Extension::Half13 => "ø13",
            Extension::Dim13 => "°13",
        }
    }

    pub fn is_diminished(self) -> bool {
        let s = self.spelling();
        s.starts_with('ø') || s.starts_with('°')
    }

    pub fn is_maj(self) -> bool {
        self.spelling().starts_with("maj")
    }

    /// Interval of the seventh, None for a triad.
    pub(crate) fn seventh(self) -> Option<i32> {
        let s = self.spelling();
        if s.is_empty() {
            None
        } else if s.starts_with("maj") {
            Some(11)
        } else if s.starts_with('°') {
            Some(9)
        } else {
            Some(10)
        }
    }

    /// 5 (triad), 7, 9, 11 or 13.
    pub(crate) fn size(self) -> u8 {
        let digits: String = self
            .spelling()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        digits.parse().unwrap_or(5)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Alteration {
    B5,
    S5,
    B9,
    S9,
    S11,
    B13,
}

impl Alteration {
    /// Canonical order (also the token order).
    pub const ALL: [Alteration; 6] = [
        Alteration::B5,
        Alteration::S5,
        Alteration::B9,
        Alteration::S9,
        Alteration::S11,
        Alteration::B13,
    ];

    pub fn spelling(self) -> &'static str {
        match self {
            Alteration::B5 => "b5",
            Alteration::S5 => "#5",
            Alteration::B9 => "b9",
            Alteration::S9 => "#9",
            Alteration::S11 => "#11",
            Alteration::B13 => "b13",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedTarget {
    pub target: u8,
    pub target_accidental: i32,
    pub target_quality: Quality,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    /// 1-7
    pub degree: u8,
    /// -2..=2 (bb, b, natural, #, ##)
    pub accidental: i32,
    pub quality: Quality,
    pub extension: Extension,
    /// sorted, values 2 and 4
    pub sus: Vec<u8>,
    /// sorted, values 6, 9 and 11
    pub adds: Vec<u8>,
    /// canonical order
    pub alterations: Vec<Alteration>,
    /// 0-3
    pub inversion: u8,
    /// Secondary chord: this chord is `degree`/`quality`/... *of* the target.
    pub applied: Option<AppliedTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenError {
    pub token: String,
    pub reason: String,
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid chord token \"{}\": {}", self.token, self.reason)
    }
}

impl std::error::Error for TokenError {}

pub fn is_rest_token(token: &str) -> bool {
    token == REST_TOKEN
}

const UPPER_NUMERALS: [&str; 7] = ["I", "II", "III", "IV", "V", "VI", "VII"];
const PREFIXES: [(&str, i32); 4] = [("bb", -2), ("b", -1), ("##", 2), ("#", 1)];
const ADD_SPELLINGS: [(&str, u8); 3] = [("add11", 11), ("add6", 6), ("add9", 9)];

struct Numeral {
    degree: u8,
    upper: bool,
}

struct Scanner<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn rest(&self) -> &'a str {
        &self.input[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    /// The char after the next one.
    fn peek2(&self) -> Option<char> {
        self.rest().chars().nth(1)
    }

    fn eat(&mut self, text: &str) -> bool {
        if self.rest().starts_with(text) {
            self.pos += text.len();
            true
        } else {
            false
        }
    }

    fn fail<T>(&self, reason: &str) -> Result<T, TokenError> {
        Err(TokenError {
            token: self.input.to_string(),
            // Positions count UTF-16 code units, as in TS (`°` and `ø` are one unit there).
            reason: format!(
                "{reason} at position {}",
                self.input[..self.pos].encode_utf16().count()
            ),
        })
    }

    fn prefix(&mut self) -> i32 {
        for (text, acc) in PREFIXES {
            if self.eat(text) {
                return acc;
            }
        }
        0
    }

    fn numeral(&mut self) -> Result<Numeral, TokenError> {
        let mut best: Option<(Numeral, usize)> = None;
        for (i, upper_text) in UPPER_NUMERALS.iter().enumerate() {
            let lower_text = upper_text.to_lowercase();
            for (text, upper) in [(*upper_text, true), (lower_text.as_str(), false)] {
                let longer = best.as_ref().is_none_or(|(_, len)| text.len() > *len);
                if longer && self.rest().starts_with(text) {
                    let degree = u8::try_from(i + 1).unwrap_or(1);
                    best = Some((Numeral { degree, upper }, text.len()));
                }
            }
        }
        match best {
            Some((numeral, len)) => {
                self.pos += len;
                Ok(numeral)
            }
            None => self.fail("expected a Roman numeral"),
        }
    }

    /// '+' after an uppercase numeral, '°' after a lowercase one (not '°7', an extension).
    fn triad_sign(&mut self, numeral: &Numeral) -> Quality {
        if numeral.upper {
            return if self.eat("+") {
                Quality::Aug
            } else {
                Quality::Major
            };
        }
        let digit_next = self.peek2().is_some_and(|c| c.is_ascii_digit());
        if self.peek() == Some('°') && !digit_next && self.eat("°") {
            Quality::Dim
        } else {
            Quality::Minor
        }
    }
}

/// Parse a Roman-numeral token (`roman-numeral-v1`). Errors also for 'rest'.
pub fn parse_token(token: &str) -> Result<Chord, TokenError> {
    let mut s = Scanner {
        input: token,
        pos: 0,
    };
    if is_rest_token(token) {
        return s.fail("\"rest\" is not a chord");
    }
    if token.is_empty() {
        return s.fail("empty token");
    }

    let accidental = s.prefix();
    let numeral = s.numeral()?;
    let mut quality = s.triad_sign(&numeral);
    let signed = matches!(quality, Quality::Dim | Quality::Aug);

    let mut extension = Extension::None;
    for ext in Extension::BY_SPELLING_LENGTH {
        if s.eat(ext.spelling()) {
            extension = ext;
            break;
        }
    }
    if extension.is_diminished() {
        if numeral.upper || signed {
            return s.fail(&format!(
                "\"{}\" needs a bare lowercase numeral",
                extension.spelling()
            ));
        }
        quality = Quality::Dim;
    }

    let mut sus: Vec<u8> = Vec::new();
    while s.eat("sus") {
        let n = if s.eat("2") {
            2
        } else if s.eat("4") {
            4
        } else {
            return s.fail("expected sus2 or sus4");
        };
        if sus.last().is_some_and(|&last| n <= last) {
            return s.fail("sus must be ascending without repeats");
        }
        sus.push(n);
    }

    let mut adds: Vec<u8> = Vec::new();
    while s.peek() == Some('a') {
        let Some(&(text, n)) = ADD_SPELLINGS
            .iter()
            .find(|(text, _)| s.rest().starts_with(text))
        else {
            return s.fail("expected add6, add9 or add11");
        };
        s.eat(text);
        if adds.last().is_some_and(|&last| n <= last) {
            return s.fail("adds must be ascending without repeats");
        }
        adds.push(n);
    }

    let mut alterations: Vec<Alteration> = Vec::new();
    while s.peek() == Some('(') {
        let Some(found) = Alteration::ALL
            .into_iter()
            .find(|a| s.rest().starts_with(&format!("({})", a.spelling())))
        else {
            return s.fail("expected (b5), (#5), (b9), (#9), (#11) or (b13)");
        };
        s.eat(&format!("({})", found.spelling()));
        if alterations.last().is_some_and(|&last| found <= last) {
            return s.fail("alterations must be in canonical order without repeats");
        }
        alterations.push(found);
    }

    let mut applied = None;
    if s.peek() == Some('/') && !s.peek2().is_some_and(|c| c.is_ascii_digit()) {
        s.eat("/");
        let target_accidental = s.prefix();
        let target = s.numeral()?;
        let target_quality = s.triad_sign(&target);
        applied = Some(AppliedTarget {
            target: target.degree,
            target_accidental,
            target_quality,
        });
    }

    let mut inversion = 0;
    if s.eat("/") {
        inversion = if s.eat("1") {
            1
        } else if s.eat("2") {
            2
        } else if s.eat("3") {
            3
        } else {
            return s.fail("expected /1, /2 or /3");
        };
    }
    if let Some(c) = s.peek() {
        return s.fail(&format!("unexpected \"{c}\""));
    }

    Ok(Chord {
        degree: numeral.degree,
        accidental,
        quality,
        extension,
        sus,
        adds,
        alterations,
        inversion,
        applied,
    })
}

fn prefix_text(accidental: i32) -> &'static str {
    match accidental {
        -2 => "bb",
        -1 => "b",
        1 => "#",
        2 => "##",
        _ => "",
    }
}

fn numeral_text(degree: u8, quality: Quality) -> String {
    let upper = UPPER_NUMERALS[usize::from(degree - 1)];
    if matches!(quality, Quality::Major | Quality::Aug) {
        upper.to_string()
    } else {
        upper.to_lowercase()
    }
}

fn triad_text(degree: u8, quality: Quality) -> String {
    let sign = match quality {
        Quality::Dim => "°",
        Quality::Aug => "+",
        _ => "",
    };
    numeral_text(degree, quality) + sign
}

/// Format a chord as its canonical token. Errors if the chord has no token spelling.
pub fn format_token(chord: &Chord) -> Result<String, TokenError> {
    let err = |reason: &str| TokenError {
        token: format!("{chord:?}"),
        reason: reason.to_string(),
    };
    let mut token = prefix_text(chord.accidental).to_string();
    let (degree, quality, extension) = (chord.degree, chord.quality, chord.extension);
    if extension == Extension::None {
        token += &triad_text(degree, quality);
    } else if extension.is_diminished() {
        if quality != Quality::Dim {
            return Err(err("diminished extension requires dim"));
        }
        token += &(numeral_text(degree, quality) + extension.spelling());
    } else {
        if quality == Quality::Dim && !extension.is_maj() {
            return Err(err("dim with a minor seventh has no token spelling"));
        }
        token += &(triad_text(degree, quality) + extension.spelling());
    }
    let mut sus = chord.sus.clone();
    sus.sort_unstable();
    sus.dedup();
    for n in sus {
        token += &format!("sus{n}");
    }
    let mut adds = chord.adds.clone();
    adds.sort_unstable();
    adds.dedup();
    for n in adds {
        token += &format!("add{n}");
    }
    for a in Alteration::ALL {
        if chord.alterations.contains(&a) {
            token += &format!("({})", a.spelling());
        }
    }
    if let Some(applied) = chord.applied {
        token += "/";
        token += prefix_text(applied.target_accidental);
        token += &triad_text(applied.target, applied.target_quality);
    }
    if chord.inversion != 0 {
        token += &format!("/{}", chord.inversion);
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_tokens() {
        let c = parse_token("V7/vi/1").unwrap();
        assert_eq!(c.degree, 5);
        assert_eq!(c.extension, Extension::Seven);
        assert_eq!(c.inversion, 1);
        assert_eq!(c.applied.unwrap().target, 6);
        assert_eq!(parse_token("vii°7").unwrap().quality, Quality::Dim);
        assert_eq!(parse_token("vii°").unwrap().extension, Extension::None);
    }

    #[test]
    fn rejects_bad_tokens() {
        for bad in [
            "",
            "rest",
            "VIIIx",
            "Isus4sus2",
            "V°7",
            "I/4",
            "Iadd9add6",
            "X",
        ] {
            assert!(parse_token(bad).is_err(), "{bad} should not parse");
        }
    }
}
