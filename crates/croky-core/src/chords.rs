//! Chord tones, voicing and lead-sheet names (port of the functions in `chords.ts`).

use crate::theory::{
    degree_pitch, key_signature, midi_note, note_name, pitch_class_of, to_pitch_class, Key, Mode,
    PitchClass,
};
use crate::token::{Alteration, Chord, Quality};

struct Structure {
    thirds: Vec<i32>,
    fifths: Vec<i32>,
    seventh: Option<i32>,
    upper: Vec<i32>,
}

fn structure(chord: &Chord) -> Structure {
    let has = |a: Alteration| chord.alterations.contains(&a);
    let size = chord.extension.size();
    let minor_third = matches!(chord.quality, Quality::Minor | Quality::Dim);

    let thirds = if chord.sus.is_empty() {
        vec![if minor_third { 3 } else { 4 }]
    } else {
        chord
            .sus
            .iter()
            .map(|&s| if s == 2 { 2 } else { 5 })
            .collect()
    };

    let mut fifths = Vec::new();
    if has(Alteration::B5) {
        fifths.push(6);
    }
    if has(Alteration::S5) {
        fifths.push(8);
    }
    if fifths.is_empty() {
        fifths.push(match chord.quality {
            Quality::Dim => 6,
            Quality::Aug => 8,
            _ => 7,
        });
    }

    let mut upper = Vec::new();
    let mut ninths = Vec::new();
    if has(Alteration::B9) {
        ninths.push(13);
    }
    if has(Alteration::S9) {
        ninths.push(15);
    }
    if !ninths.is_empty() {
        upper.extend(ninths);
    } else if size >= 9 {
        upper.push(14);
    }
    if has(Alteration::S11) {
        upper.push(18);
    } else if size >= 11 {
        upper.push(17);
    }
    if has(Alteration::B13) {
        upper.push(20);
    } else if size >= 13 {
        upper.push(21);
    }
    for &add in &chord.adds {
        upper.push(match add {
            6 => 9,
            9 => 14,
            _ => 17,
        });
    }

    Structure {
        thirds,
        fifths,
        seventh: chord.extension.seventh(),
        upper,
    }
}

/// Intervals in semitones from the root, ascending and deduplicated (0 included).
pub fn chord_intervals(chord: &Chord) -> Vec<i32> {
    let s = structure(chord);
    let mut all = vec![0];
    all.extend(&s.thirds);
    all.extend(&s.fifths);
    all.extend(s.seventh);
    all.extend(&s.upper);
    all.sort_unstable();
    all.dedup();
    all
}

pub fn chord_root_pitch_class(chord: &Chord, key: Key) -> PitchClass {
    match chord.applied {
        None => pitch_class_of(key, chord.degree, chord.accidental),
        Some(a) => {
            let target = pitch_class_of(key, a.target, a.target_accidental);
            to_pitch_class(i32::from(target) + degree_pitch(Mode::Major, chord.degree))
        }
    }
}

/// Pitch classes, root first, in ascending interval order, deduplicated.
pub fn chord_pitch_classes(chord: &Chord, key: Key) -> Vec<PitchClass> {
    let root = i32::from(chord_root_pitch_class(chord, key));
    let mut out: Vec<PitchClass> = Vec::new();
    for i in chord_intervals(chord) {
        let pc = to_pitch_class(root + i);
        if !out.contains(&pc) {
            out.push(pc);
        }
    }
    out
}

fn bass_interval(chord: &Chord) -> i32 {
    let s = structure(chord);
    let third = s.thirds.first().copied().unwrap_or(0);
    let fifth = s.fifths.first().copied().unwrap_or(third);
    match chord.inversion {
        1 => third,
        2 => fifth,
        3 => s.seventh.unwrap_or(fifth),
        _ => 0,
    }
}

pub fn chord_bass_pitch_class(chord: &Chord, key: Key) -> PitchClass {
    to_pitch_class(i32::from(chord_root_pitch_class(chord, key)) + bass_interval(chord))
}

/// Bass note in `bass_octave`, then every chord tone in close position from `octave` upward
/// (the TS defaults are 2 and 4).
pub fn voice_chord(chord: &Chord, key: Key, bass_octave: i32, octave: i32) -> Vec<i32> {
    let bass_pc = chord_bass_pitch_class(chord, key);
    let pcs = chord_pitch_classes(chord, key);
    let start = pcs.iter().position(|&pc| pc == bass_pc).unwrap_or(0);
    let mut notes = vec![midi_note(bass_pc, bass_octave)];
    let mut previous: Option<i32> = None;
    for &pc in pcs[start..].iter().chain(&pcs[..start]) {
        let mut note = midi_note(pc, octave);
        if let Some(p) = previous {
            while note <= p {
                note += 12;
            }
        }
        notes.push(note);
        previous = Some(note);
    }
    notes
}

const MAJOR_DEGREE_FIFTHS: [i32; 7] = [0, 2, 4, -1, 1, 3, 5];

fn interval_fifths(interval: i32) -> i32 {
    match interval {
        2 => 2,
        3 => -3,
        4 => 4,
        5 => -1,
        6 => -6,
        7 => 1,
        8 => 8,
        9 => -9,
        10 => -2,
        11 => 5,
        _ => 0,
    }
}

fn degree_fifths(key: Key, degree: u8, accidental: i32) -> i32 {
    let rotation = key.mode.rotation();
    let major = Mode::Major.scale();
    let parent_index = (usize::from(degree) - 1 + rotation) % 7;
    let parent_tonic = i32::from(key.tonic) - major[rotation];
    let parent_pc = i32::from(to_pitch_class(parent_tonic + major[parent_index]));
    let raised = (i32::from(pitch_class_of(key, degree, 0)) - parent_pc + 18).rem_euclid(12) - 6;
    key_signature(key) + MAJOR_DEGREE_FIFTHS[parent_index] + 7 * (raised + accidental)
}

fn root_fifths(chord: &Chord, key: Key) -> i32 {
    match chord.applied {
        None => degree_fifths(key, chord.degree, chord.accidental),
        Some(a) => {
            degree_fifths(key, a.target, a.target_accidental)
                + MAJOR_DEGREE_FIFTHS[usize::from(chord.degree - 1)]
        }
    }
}

fn spell(pc: PitchClass, fifths: i32) -> &'static str {
    note_name(pc, fifths < 0)
}

fn quality_symbol(q: Quality) -> &'static str {
    match q {
        Quality::Major => "",
        Quality::Minor => "m",
        Quality::Dim => "°",
        Quality::Aug => "+",
    }
}

fn quality_and_extension_name(chord: &Chord) -> String {
    let (quality, ext) = (chord.quality, chord.extension);
    let sus = !chord.sus.is_empty();
    let spelling = ext.spelling();
    if spelling.is_empty() {
        return if sus {
            String::new()
        } else {
            quality_symbol(quality).to_string()
        };
    }
    if ext.is_diminished() {
        return if quality == Quality::Dim || sus {
            spelling.to_string()
        } else {
            format!("{}{spelling}", quality_symbol(quality))
        };
    }
    if sus {
        return spelling.to_string();
    }
    if quality == Quality::Dim {
        return if ext.is_maj() {
            format!("°{spelling}")
        } else {
            format!("ø{spelling}")
        };
    }
    if quality == Quality::Minor && ext.is_maj() {
        return format!("mMaj{}", &spelling[3..]);
    }
    format!("{}{spelling}", quality_symbol(quality))
}

/// Lead-sheet name: 'C', 'Am', 'G7', 'Fmaj7', 'Bø7', 'Gsus4', 'G/B'; spelling follows the key.
pub fn chord_name(chord: &Chord, key: Key) -> String {
    let fifths = root_fifths(chord, key);
    let mut name = spell(chord_root_pitch_class(chord, key), fifths).to_string()
        + &quality_and_extension_name(chord);
    for s in &chord.sus {
        name += &format!("sus{s}");
    }
    for a in &chord.adds {
        name += &format!("add{a}");
    }
    let mut alts = chord.alterations.clone();
    if !chord.sus.is_empty() && !alts.contains(&Alteration::B5) && !alts.contains(&Alteration::S5) {
        if chord.quality == Quality::Dim {
            alts.push(Alteration::B5);
        }
        if chord.quality == Quality::Aug {
            alts.push(Alteration::S5);
        }
    }
    for a in Alteration::ALL {
        if alts.contains(&a) {
            name += &format!("({})", a.spelling());
        }
    }
    if chord.inversion != 0 {
        let bass_fifths = fifths + interval_fifths(bass_interval(chord));
        name += "/";
        name += spell(chord_bass_pitch_class(chord, key), bass_fifths);
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::parse_token;

    const C: Key = Key {
        tonic: 0,
        mode: Mode::Major,
    };

    #[test]
    fn names_and_voicings() {
        let name = |t: &str| chord_name(&parse_token(t).unwrap(), C);
        assert_eq!(name("bVII"), "Bb");
        assert_eq!(name("V/vi/1"), "E/G#");
        assert_eq!(name("vi7"), "Am7");
        assert_eq!(
            voice_chord(&parse_token("I").unwrap(), C, 2, 4),
            vec![36, 60, 64, 67]
        );
    }
}
