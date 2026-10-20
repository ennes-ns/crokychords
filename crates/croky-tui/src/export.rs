//! `.mid` export (key `e`): `song_to_midi` with a General MIDI Program Change per track, so a
//! DAW or GM player picks a fitting sound (`docs/specs/soundfonts-v1.md` §9). The terminal has
//! no instrument choice; it writes the programs of the web app's default "Band" sound preset per
//! role (§8), so a file exported here equals the web export with default sound settings.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use croky_core::melody::MELODY_TRACK_ID;
use croky_core::tracks::TrackRole;
use croky_core::{song_to_midi, MidiOptions, Song};

use crate::saves::write_atomic;

/// GM program (0-based) of the Band preset's instrument for a role.
pub fn role_program(role: TrackRole) -> u8 {
    match role {
        TrackRole::Chords | TrackRole::Custom => 0, // Acoustic Grand Piano
        TrackRole::Bass => 32,                      // Acoustic Bass
        TrackRole::Arp => 4,                        // Electric Piano 1
        TrackRole::Pad => 48,                       // String Ensemble 1
    }
}

/// The Band preset's lead (the synth `lead`, GM 80 Lead 1 (square)) for the melody.
pub const MELODY_PROGRAM: u8 = 80;

/// Program per track id and the melody.
pub fn programs(song: &Song) -> BTreeMap<String, f64> {
    let mut out: BTreeMap<String, f64> = song
        .tracks
        .iter()
        .flatten()
        .map(|t| (t.id.clone(), f64::from(role_program(t.role))))
        .collect();
    out.insert(MELODY_TRACK_ID.into(), f64::from(MELODY_PROGRAM));
    out
}

/// A file name for the song title: path separators and control characters replaced.
pub fn file_name(title: &str) -> String {
    let clean: String = title
        .trim()
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_start_matches('.');
    if clean.is_empty() {
        "Untitled.mid".into()
    } else {
        format!("{clean}.mid")
    }
}

/// Write `<dir>/<title>.mid`; returns the path.
pub fn export(song: &Song, dir: &Path) -> Result<PathBuf, String> {
    let opts = MidiOptions {
        programs: programs(song),
        ..MidiOptions::default()
    };
    let bytes = song_to_midi(song, &opts).map_err(|e| e.to_string())?;
    let path = dir.join(file_name(&song.title));
    write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::saves::tests::temp_dir;
    use crate::testdata::song;

    #[test]
    fn writes_a_program_change_per_track() {
        let s = song();
        let dir = temp_dir("export");
        let path = export(&s, &dir).unwrap();
        assert_eq!(path.file_name().unwrap(), "Axis.mid");
        let bytes = std::fs::read(&path).unwrap();
        // Chords on channel 1 (piano), bass on channel 2 (acoustic bass); the arp is muted.
        let has = |pc: [u8; 2]| bytes.windows(3).any(|w| w == [0, pc[0], pc[1]]);
        assert!(has([0xc0, 0]));
        assert!(has([0xc1, 32]));
        assert!(!bytes.windows(2).any(|w| w == [0xc2, 4]));
        assert_eq!(
            bytes,
            song_to_midi(
                &s,
                &MidiOptions {
                    programs: programs(&s),
                    ..MidiOptions::default()
                }
            )
            .unwrap()
        );
        assert_eq!(file_name(" a/b\n"), "a_b.mid");
        assert_eq!(file_name(".."), "Untitled.mid");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
