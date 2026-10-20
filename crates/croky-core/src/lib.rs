//! Partial Rust port of `@crokychords/core` (`packages/core`), the base for the terminal app
//! and the planned nih-plug plugin (ADR 0002). Ported so far: theory, the token grammar,
//! chord tones / voicing / names, n-gram suggestions and the song record. Not yet: tracks and
//! patterns (`render.ts`), the SMF writer, `diatonic.ts`. The TypeScript code is the
//! reference; `tests/golden/*.jsonl` are generated from it by `scripts/gen-rust-golden.sh`.

pub mod chords;
pub mod song;
pub mod suggest;
pub mod theory;
pub mod token;

pub use chords::{chord_name, voice_chord};
pub use song::{Song, SongChord};
pub use suggest::{suggest_next, NgramTable, SuggestOptions, Suggestion};
pub use theory::{Key, Mode};
pub use token::{format_token, is_rest_token, parse_token, Chord, REST_TOKEN};
