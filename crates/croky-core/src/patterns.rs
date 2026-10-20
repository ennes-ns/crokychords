//! Built-in rhythm patterns, role defaults and the default band (port of `patterns.ts`,
//! `docs/specs/tracks-v1.md` §A2).

use std::sync::OnceLock;

use crate::tracks::{
    new_track_id, NoteSelector, Pattern, PatternStep, PatternTail, Track, TrackRole, TrackVoicing,
};

/// Steps at `ats`, each `length` long, notes and accent per step index.
fn steps(
    ats: &[f64],
    length: f64,
    notes: impl Fn(usize) -> NoteSelector,
    accent: impl Fn(usize) -> Option<f64>,
) -> Vec<PatternStep> {
    ats.iter()
        .enumerate()
        .map(|(i, &at)| PatternStep {
            at,
            length,
            notes: notes(i),
            accent: accent(i),
        })
        .collect()
}

fn same(notes: NoteSelector) -> impl Fn(usize) -> NoteSelector {
    move |_| notes
}

fn no_accent(_: usize) -> Option<f64> {
    None
}

/// 0, every, 2 * every, ... below `length` beats.
fn grid_of(every: f64, length: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut i = 0.0;
    while i * every < length {
        out.push(i * every);
        i += 1.0;
    }
    out
}

/// 0, every, 2 * every, ... below 4 beats.
fn grid(every: f64) -> Vec<f64> {
    grid_of(every, 4.0)
}

/// Tone selectors cycling through `indices`, one per step.
fn tones(indices: &'static [u64]) -> impl Fn(usize) -> NoteSelector {
    move |i| NoteSelector::Index(indices[i % indices.len()])
}

const ARP_UP_DOWN: [u64; 8] = [0, 1, 2, 3, 2, 1, 0, 1];
/// Walking bass over one chord: bass note, third, fifth, octave.
const WALK: [NoteSelector; 4] = [
    NoteSelector::Bass,
    NoteSelector::Index(1),
    NoteSelector::Index(2),
    NoteSelector::Octave,
];

struct PresetDef {
    pattern: Pattern,
    roles: &'static [TrackRole],
    /// One line for the pattern select.
    description: &'static str,
}

fn def(
    roles: &'static [TrackRole],
    description: &'static str,
    (id, name, length): (&str, &str, f64),
    steps: Vec<PatternStep>,
    tail: Option<PatternTail>,
) -> PresetDef {
    PresetDef {
        pattern: Pattern {
            id: id.into(),
            name: name.into(),
            length,
            steps,
            tail,
        },
        roles,
        description,
    }
}

fn presets() -> &'static [PresetDef] {
    static PRESETS: OnceLock<Vec<PresetDef>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        use NoteSelector::{Bass, Chord, Fifth, Index, Octave};
        use TrackRole as R;
        let sustain = Some(PatternTail::Sustain);
        let step = |at, length, notes, accent| PatternStep {
            at,
            length,
            notes,
            accent,
        };
        vec![
            def(
                &[R::Chords, R::Pad],
                "One chord held to the chord end",
                ("sustain", "Sustain", 4.0),
                steps(&[0.0], 4.0, same(Chord), no_accent),
                sustain,
            ),
            def(
                &[R::Chords],
                "One chord every four beats",
                ("whole", "Whole notes", 4.0),
                steps(&[0.0], 4.0, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Chords on beats 1 and 3",
                ("half", "Half notes", 4.0),
                steps(&[0.0, 2.0], 2.0, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Short chords on every beat",
                ("quarters", "Quarter stabs", 4.0),
                steps(&grid(1.0), 0.5, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Short chords on every eighth",
                ("eighths", "Eighths", 4.0),
                steps(&grid(0.5), 0.25, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Chords between the beats",
                ("offbeat", "Off-beat eighths", 4.0),
                steps(&[0.5, 1.5, 2.5, 3.5], 0.4, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Long-short-long-long ballad rhythm",
                ("pop-ballad", "Pop ballad", 4.0),
                vec![
                    PatternStep::new(0.0, 1.5, Chord),
                    PatternStep::new(1.5, 0.5, Chord),
                    PatternStep::new(2.0, 1.0, Chord),
                    PatternStep::new(3.0, 1.0, Chord),
                ],
                None,
            ),
            def(
                &[R::Bass],
                "The bass note held to the chord end",
                ("bass-whole", "Bass whole", 4.0),
                steps(&[0.0], 4.0, same(Bass), no_accent),
                sustain,
            ),
            def(
                &[R::Bass],
                "The bass note on every beat",
                ("bass-quarters", "Bass quarters", 4.0),
                steps(&grid(1.0), 0.9, same(Bass), no_accent),
                None,
            ),
            def(
                &[R::Bass],
                "Bass note and fifth, alternating per beat",
                ("bass-root-fifth", "Root–fifth", 4.0),
                steps(
                    &grid(1.0),
                    0.9,
                    |i| if i % 2 == 0 { Bass } else { Fifth },
                    no_accent,
                ),
                None,
            ),
            def(
                &[R::Bass],
                "The bass note on every eighth, off-beats softer",
                ("bass-octaves", "Octave eighths", 4.0),
                steps(&grid(0.5), 0.45, same(Bass), |i| {
                    (i % 2 == 1).then_some(0.8)
                }),
                None,
            ),
            def(
                &[R::Arp],
                "Chord tones climbing in eighths",
                ("arp-up-8", "Arp up 1/8", 4.0),
                steps(&grid(0.5), 0.45, |i| Index(i as u64), no_accent),
                None,
            ),
            def(
                &[R::Arp],
                "Four chord tones up, every beat",
                ("arp-up-16", "Arp up 1/16", 4.0),
                steps(&grid(0.25), 0.22, tones(&[0, 1, 2, 3]), no_accent),
                None,
            ),
            def(
                &[R::Arp],
                "Chord tones up and down in eighths",
                ("arp-updown-8", "Arp up–down 1/8", 4.0),
                steps(&grid(0.5), 0.45, |i| Index(ARP_UP_DOWN[i % 8]), no_accent),
                None,
            ),
            def(
                &[R::Arp],
                "Chord tones up and down in sixteenths",
                ("arp-updown-16", "Arp up–down 1/16", 4.0),
                steps(
                    &grid(0.25),
                    0.22,
                    tones(&[0, 1, 2, 3, 4, 3, 2, 1]),
                    no_accent,
                ),
                None,
            ),
            def(
                &[R::Arp],
                "Root, fifth, third, octave in eighths",
                ("arp-broken-8", "Broken chord 1/8", 4.0),
                steps(&grid(0.5), 0.45, tones(&[0, 2, 1, 3]), no_accent),
                None,
            ),
            def(
                &[R::Arp, R::Chords],
                "Low, high, middle, high: the classic left hand",
                ("alberti", "Alberti", 4.0),
                steps(&grid(0.5), 0.45, tones(&[0, 2, 1, 2]), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Short stabs between the beats with a pickup",
                ("stab-offbeat", "Off-beat stabs", 4.0),
                steps(&[0.5, 1.5, 2.5, 3.5, 3.75], 0.2, same(Chord), |i| {
                    (i == 4).then_some(0.75)
                }),
                None,
            ),
            def(
                &[R::Chords],
                "Syncopated piano stabs for four-on-the-floor",
                ("house-piano", "House piano", 4.0),
                steps(&[0.0, 0.75, 1.5, 2.5, 3.25], 0.4, same(Chord), |i| {
                    (i != 0).then_some(0.85)
                }),
                None,
            ),
            def(
                &[R::Chords],
                "Short chords on beats 2 and 4",
                ("reggae-skank", "Reggae skank", 4.0),
                steps(&[1.0, 3.0], 0.3, same(Chord), no_accent),
                None,
            ),
            def(
                &[R::Chords],
                "Bass note, then two softer chords (three beats)",
                ("waltz-3", "Waltz 3/4", 3.0),
                vec![
                    step(0.0, 0.9, Bass, None),
                    step(1.0, 0.6, Chord, Some(0.75)),
                    step(2.0, 0.6, Chord, Some(0.75)),
                ],
                None,
            ),
            def(
                &[R::Bass],
                "Bass note and its octave, alternating in eighths",
                ("bass-octave-8", "Bass octaves 1/8", 4.0),
                steps(
                    &grid(0.5),
                    0.45,
                    |i| if i % 2 == 0 { Bass } else { Octave },
                    |i| (i % 2 == 1).then_some(0.8),
                ),
                None,
            ),
            def(
                &[R::Bass],
                "Bass note, third, fifth, octave on the beats",
                ("bass-walk-4", "Walking bass", 4.0),
                steps(
                    &grid(1.0),
                    0.9,
                    |i| WALK.get(i).copied().unwrap_or(Bass),
                    no_accent,
                ),
                None,
            ),
            def(
                &[R::Pad],
                "A soft chord held to the chord end",
                ("pad", "Pad", 4.0),
                steps(&[0.0], 4.0, same(Chord), |_| Some(0.8)),
                sustain,
            ),
        ]
    })
}

/// Built-in rhythm patterns (`PATTERN_PRESETS`); clone one for a mutable copy.
pub fn pattern_presets() -> Vec<&'static Pattern> {
    presets().iter().map(|d| &d.pattern).collect()
}

/// Unknown preset id (`patternPreset` throws a `RangeError` with this message).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownPreset(pub String);

impl std::fmt::Display for UnknownPreset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Unknown pattern preset: \"{}\"", self.0)
    }
}

impl std::error::Error for UnknownPreset {}

/// A fresh copy of the preset with this id.
pub fn pattern_preset(id: &str) -> Result<Pattern, UnknownPreset> {
    presets()
        .iter()
        .find(|d| d.pattern.id == id)
        .map(|d| d.pattern.clone())
        .ok_or_else(|| UnknownPreset(id.into()))
}

/// Roles a preset is meant for (for grouping in the UI); empty for unknown ids and 'custom'.
pub fn pattern_roles(id: &str) -> &'static [TrackRole] {
    presets()
        .iter()
        .find(|d| d.pattern.id == id)
        .map_or(&[], |d| d.roles)
}

/// One-line description of a built-in preset (for the pattern select); '' for unknown ids.
pub fn pattern_description(id: &str) -> &'static str {
    presets()
        .iter()
        .find(|d| d.pattern.id == id)
        .map_or("", |d| d.description)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoleDefaults {
    pub name: &'static str,
    /// Octave of the lowest voiced tone.
    pub octave: i32,
    /// Preset id.
    pub pattern: &'static str,
    pub velocity: i32,
}

/// Defaults applied by `create_track` per role (`ROLE_DEFAULTS`).
pub fn role_defaults(role: TrackRole) -> RoleDefaults {
    let (name, octave, pattern, velocity) = match role {
        TrackRole::Chords => ("Chords", 4, "sustain", 96),
        TrackRole::Bass => ("Bass", 2, "bass-quarters", 100),
        TrackRole::Arp => ("Arp", 4, "arp-up-8", 96),
        TrackRole::Pad => ("Pad", 3, "pad", 80),
        TrackRole::Custom => ("Custom", 4, "sustain", 96),
    };
    RoleDefaults {
        name,
        octave,
        pattern,
        velocity,
    }
}

pub const DEFAULT_GATE: f64 = 0.9;

/// Fields of a track to set instead of the role defaults (`Partial<Omit<Track, 'role'>>`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackOverrides {
    pub id: Option<String>,
    pub name: Option<String>,
    pub channel: Option<i32>,
    pub octave: Option<i32>,
    pub voicing: Option<TrackVoicing>,
    pub pattern: Option<Pattern>,
    pub velocity: Option<i32>,
    pub gate: Option<f64>,
    pub muted: Option<bool>,
    pub transpose: Option<i32>,
}

/// A track with the role's defaults (name, octave, pattern, velocity; channel 0, close
/// voicing, gate 0.9, unmuted, no transpose) overridden by `overrides`. The id is generated
/// with `new_track_id(random)` unless given.
pub fn create_track(
    role: TrackRole,
    overrides: TrackOverrides,
    random: &mut dyn FnMut() -> f64,
) -> Track {
    let d = role_defaults(role);
    let pattern = overrides
        .pattern
        .unwrap_or_else(|| pattern_preset(d.pattern).expect("role defaults name existing presets"));
    Track {
        id: overrides.id.unwrap_or_else(|| new_track_id(random)),
        name: overrides.name.unwrap_or_else(|| d.name.into()),
        role,
        channel: overrides.channel.unwrap_or(0),
        octave: overrides.octave.unwrap_or(d.octave),
        voicing: overrides.voicing.unwrap_or(TrackVoicing::Close),
        pattern,
        velocity: overrides.velocity.unwrap_or(d.velocity),
        gate: overrides.gate.unwrap_or(DEFAULT_GATE),
        muted: overrides.muted.unwrap_or(false),
        transpose: overrides.transpose.unwrap_or(0),
    }
}

/// The default band: Chords (ch 0, octave 4, 'sustain'), Bass (ch 1, octave 2,
/// 'bass-quarters') and Arp (ch 2, octave 4, 'arp-up-8', muted). Fresh ids on every call.
pub fn default_tracks(random: &mut dyn FnMut() -> f64) -> Vec<Track> {
    let channel = |c: i32| TrackOverrides {
        channel: Some(c),
        ..TrackOverrides::default()
    };
    vec![
        create_track(TrackRole::Chords, channel(0), random),
        create_track(TrackRole::Bass, channel(1), random),
        create_track(
            TrackRole::Arp,
            TrackOverrides {
                muted: Some(true),
                ..channel(2)
            },
            random,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_and_roles() {
        assert_eq!(pattern_presets().len(), 24);
        assert_eq!(pattern_preset("arp-up-16").unwrap().steps.len(), 16);
        assert_eq!(
            pattern_preset("nope").unwrap_err().to_string(),
            "Unknown pattern preset: \"nope\""
        );
        assert_eq!(
            pattern_roles("sustain"),
            &[TrackRole::Chords, TrackRole::Pad]
        );
        assert!(pattern_roles("custom").is_empty());
    }
}
