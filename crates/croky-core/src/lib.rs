//! Rust port of `@crokychords/core` (`packages/core`), the base for the terminal app and the
//! planned plugin (ADR 0002): theory, the token grammar, chord tones / voicing / names,
//! diatonic triads, n-gram suggestions, tracks and pattern presets, the song record (schema 3
//! with the melody lane, `validateSong`), rendering to note events and the SMF writer. The
//! TypeScript code is the reference; `tests/golden/*` are generated from it by
//! `scripts/gen-rust-golden.sh` and `tests/parity.rs` checks the port against them.

pub mod chords;
pub mod diatonic;
pub mod json;
pub mod melody;
pub mod midi;
pub mod patterns;
pub mod render;
pub mod song;
pub mod suggest;
pub mod theory;
pub mod token;
pub mod tracks;

pub use chords::{chord_name, voice_chord};
pub use diatonic::{diatonic_quality, diatonic_triad_token, is_diatonic, is_diatonic_token};
pub use melody::{default_melody, melody_note_pitch, Melody, MelodyNote};
pub use midi::{song_to_midi, MidiError, MidiOptions};
pub use patterns::{
    create_track, default_tracks, pattern_preset, pattern_presets, pattern_roles, role_defaults,
    TrackOverrides,
};
pub use render::{
    layout_pattern, melody_note_harmony, render_melody, render_song, render_track, MelodyHarmony,
    NoteEvent, RenderOptions,
};
pub use song::{
    create_song, deserialize_song, serialize_song, validate_song, Song, SongChord, SongError,
};
pub use suggest::{
    popular_chords, seed_table, suggest_next, NgramTable, PopularOptions, SuggestOptions,
    Suggestion,
};
pub use theory::{Key, Mode};
pub use token::{format_token, is_rest_token, parse_token, Chord, REST_TOKEN};
pub use tracks::{
    new_track_id, NoteSelector, Pattern, PatternStep, PatternTail, Track, TrackRole, TrackVoicing,
};
