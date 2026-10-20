//! Diatonic triads of a mode and the diatonic test (port of `diatonic.ts`).

use crate::chords::chord_pitch_classes;
use crate::theory::{Key, Mode};
use crate::token::{format_token, parse_token, Chord, Extension, Quality};

/// Semitones from the tonic of scale step `index` (0-based, may exceed 6: next octave).
fn step(mode: Mode, index: usize) -> i32 {
    mode.scale()[index % 7] + 12 * (index / 7) as i32
}

/// Quality of the diatonic triad on `degree` (1-7) of `mode` (stacked thirds of the scale).
/// Panics on another degree (TS throws a `RangeError`).
pub fn diatonic_quality(degree: u8, mode: Mode) -> Quality {
    assert!((1..=7).contains(&degree), "Invalid scale degree {degree}");
    let d = usize::from(degree);
    let root = step(mode, d - 1);
    let third = step(mode, d + 1) - root;
    let fifth = step(mode, d + 3) - root;
    match (third, fifth) {
        (4, 8) => Quality::Aug,
        (4, _) => Quality::Major,
        (_, 6) => Quality::Dim,
        _ => Quality::Minor,
    }
}

/// Token of the diatonic triad on `degree`, e.g. 'ii' in major, 'III' in minor, 'vii°'.
/// Panics on a degree outside 1..7, as `diatonic_quality`.
pub fn diatonic_triad_token(degree: u8, mode: Mode) -> String {
    let chord = Chord {
        degree,
        accidental: 0,
        quality: diatonic_quality(degree, mode),
        extension: Extension::None,
        sus: Vec::new(),
        adds: Vec::new(),
        alterations: Vec::new(),
        inversion: 0,
        applied: None,
    };
    // A plain triad always has a spelling.
    format_token(&chord).unwrap_or_default()
}

/// True when every pitch class of the chord belongs to the scale of the mode.
pub fn is_diatonic(chord: &Chord, mode: Mode) -> bool {
    let scale = mode.scale();
    chord_pitch_classes(chord, Key { tonic: 0, mode })
        .into_iter()
        .all(|pc| scale.contains(&i32::from(pc)))
}

/// `isDiatonic` for a token: one that does not parse (including 'rest') is not diatonic.
pub fn is_diatonic_token(token: &str, mode: Mode) -> bool {
    parse_token(token).is_ok_and(|c| is_diatonic(&c, mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triads() {
        let major: Vec<String> = (1..=7)
            .map(|d| diatonic_triad_token(d, Mode::Major))
            .collect();
        assert_eq!(major, ["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
        assert_eq!(diatonic_triad_token(3, Mode::HarmonicMinor), "III+");
        assert!(is_diatonic_token("V7", Mode::Major));
        assert!(!is_diatonic_token("V7", Mode::Minor));
        assert!(!is_diatonic_token("rest", Mode::Major));
    }
}
