//! Standard MIDI File writer (port of `midi.ts`): format 0 for songs without tracks, format 1
//! (conductor, one track per band track, the melody) otherwise. Output is byte-identical to
//! `songToMidi`; errors carry the TS `RangeError` messages.

use std::collections::HashSet;

use crate::chords::voice_chord;
use crate::json::{is_integer, js_number, js_round};
use crate::render::{render_melody, render_track, NoteEvent, RenderOptions};
use crate::song::Song;
use crate::theory::{key_signature, Mode};
use crate::token::{is_rest_token, parse_token};
use crate::tracks::Track;

/// `channel`, `velocity`, `bass_octave`, `octave` and `gate` only apply to songs without
/// tracks (format 0); with tracks they come from each track.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MidiOptions {
    /// Ticks per quarter note, default 480.
    pub ppq: Option<f64>,
    /// 0-15, default 0.
    pub channel: Option<f64>,
    /// 1-127, default 96.
    pub velocity: Option<f64>,
    /// Passed to `voice_chord`, default 2.
    pub bass_octave: Option<i32>,
    /// Passed to `voice_chord`, default 4.
    pub octave: Option<i32>,
    /// 0 < gate <= 1: note length as a fraction of the chord's beats, default 0.98.
    pub gate: Option<f64>,
    /// Name of the (conductor) track. Default: the song title.
    pub track_name: Option<String>,
    /// Also write muted tracks (format 1), default false.
    pub include_muted: bool,
}

/// The `RangeError` of `songToMidi` (an option or song value outside what SMF can hold).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MidiError(pub String);

impl std::fmt::Display for MidiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MidiError {}

type Res<T> = Result<T, MidiError>;

/// Name of the melody track in the exported file.
pub const MELODY_TRACK_NAME: &str = "Melody";

const NOTE_OFF_VELOCITY: u8 = 64;

/// Modes written with the minor flag in the key signature meta event.
fn minor_flag(mode: Mode) -> bool {
    matches!(
        mode,
        Mode::Minor
            | Mode::Dorian
            | Mode::Phrygian
            | Mode::Locrian
            | Mode::HarmonicMinor
            | Mode::PhrygianDominant
    )
}

/// Variable-length quantity as used for delta times and meta lengths.
pub fn encode_vlq(value: f64) -> Result<Vec<u8>, MidiError> {
    if !is_integer(value) || !(0.0..=f64::from(0x0fff_ffff)).contains(&value) {
        return Err(MidiError(format!("VLQ out of range: {}", js_number(value))));
    }
    let value = value as u32;
    let mut bytes = vec![(value & 0x7f) as u8];
    let mut rest = value >> 7;
    while rest > 0 {
        bytes.insert(0, ((rest & 0x7f) | 0x80) as u8);
        rest >>= 7;
    }
    Ok(bytes)
}

fn vlq_len(n: usize) -> Res<Vec<u8>> {
    encode_vlq(n as f64)
}

fn check_int(name: &str, value: f64, min: i64, max: i64) -> Res<i64> {
    if !is_integer(value) || value < min as f64 || value > max as f64 {
        return Err(MidiError(format!(
            "{name} must be an integer in {min}..{max}, got {}",
            js_number(value)
        )));
    }
    Ok(value as i64)
}

struct TimedEvent {
    tick: f64,
    /// Sort key within a tick: 0 = note-off, 1 = note-on.
    order: u8,
    bytes: [u8; 3],
}

/// Track name, tempo, time signature and key signature at tick 0.
fn conductor_meta(song: &Song, track_name: &str) -> Res<Vec<u8>> {
    let key = song.key();
    let mut meta = Vec::new();
    let name = track_name.as_bytes();
    meta.extend([0, 0xff, 0x03]);
    meta.extend(vlq_len(name.len())?);
    meta.extend(name);
    let us = check_int(
        "microseconds per quarter",
        js_round(60_000_000.0 / song.tempo),
        1,
        0xff_ffff,
    )?;
    meta.extend([
        0,
        0xff,
        0x51,
        0x03,
        (us >> 16) as u8,
        (us >> 8) as u8,
        us as u8,
    ]);
    let numerator = check_int("meter.beats", f64::from(song.meter.beats), 1, 255)?;
    let power = check_int("log2(meter.unit)", f64::from(song.meter.unit).log2(), 0, 7)?;
    meta.extend([0, 0xff, 0x58, 0x04, numerator as u8, power as u8, 24, 8]);
    let sf = key_signature(key);
    meta.extend([
        0,
        0xff,
        0x59,
        0x02,
        sf as u8,
        u8::from(minor_flag(key.mode)),
    ]);
    Ok(meta)
}

/// Track chunk body: `head` (delta-timed bytes at tick 0), the events, end of track at >= `end`.
fn track_body(mut head: Vec<u8>, mut events: Vec<TimedEvent>, end: f64) -> Res<Vec<u8>> {
    // Stable sort: note-offs before note-ons at the same tick, otherwise insertion order.
    events.sort_by(|a, b| a.tick.total_cmp(&b.tick).then(a.order.cmp(&b.order)));
    let mut now = 0.0;
    for e in &events {
        head.extend(encode_vlq(e.tick - now)?);
        head.extend(e.bytes);
        now = e.tick;
    }
    head.extend(encode_vlq(now.max(end) - now)?);
    head.extend([0xff, 0x2f, 0x00]);
    Ok(head)
}

fn smf(format: u16, ppq: u16, tracks: &[Vec<u8>]) -> Vec<u8> {
    let mut out = b"MThd".to_vec();
    out.extend(6u32.to_be_bytes());
    out.extend(format.to_be_bytes());
    out.extend((tracks.len() as u16).to_be_bytes());
    out.extend(ppq.to_be_bytes());
    for body in tracks {
        out.extend(b"MTrk");
        out.extend((body.len() as u32).to_be_bytes());
        out.extend(body);
    }
    out
}

fn note_events(channel: u8, note: i64, velocity: u8, on: f64, off: f64) -> Res<[TimedEvent; 2]> {
    let note = check_int("note", note as f64, 0, 127)? as u8;
    Ok([
        TimedEvent {
            tick: on,
            order: 1,
            bytes: [0x90 | channel, note, velocity],
        },
        TimedEvent {
            tick: off,
            order: 0,
            bytes: [0x80 | channel, note, NOTE_OFF_VELOCITY],
        },
    ])
}

/// `songToMidi`. One beat of the song is one quarter note (`ppq` ticks); rests advance time
/// only. Running status is not used; note-offs come before note-ons at the same tick.
///
/// - Song with tracks: format 1. Track 0 is the conductor (name, tempo, time and key
///   signature); then one track per unmuted track (all with `include_muted`) in song order,
///   each with a track name, a MIDI channel prefix and the events of `render_track`; then, when
///   the melody has notes and is unmuted (or `include_muted`), a track named 'Melody'.
/// - Song without tracks: format 0, one track, every chord voiced with `voice_chord` and held
///   for `beats * gate`.
pub fn song_to_midi(song: &Song, opts: &MidiOptions) -> Result<Vec<u8>, MidiError> {
    let ppq = check_int("ppq", opts.ppq.unwrap_or(480.0), 1, 0x7fff)? as u16;
    if let Some(tracks) = &song.tracks {
        return multi_track_midi(song, tracks, ppq, opts);
    }

    let channel = check_int("channel", opts.channel.unwrap_or(0.0), 0, 15)? as u8;
    let velocity = check_int("velocity", opts.velocity.unwrap_or(96.0), 1, 127)? as u8;
    let gate = opts.gate.unwrap_or(0.98);
    if !(gate > 0.0 && gate <= 1.0) {
        return Err(MidiError(format!(
            "gate must be in (0, 1], got {}",
            js_number(gate)
        )));
    }
    let bass_octave = opts.bass_octave.unwrap_or(2);
    let octave = opts.octave.unwrap_or(4);
    let ppq_f = f64::from(ppq);

    let key = song.key();
    let mut events = Vec::new();
    let mut beat = 0.0;
    for chord in &song.chords {
        let start = js_round(beat * ppq_f);
        beat += chord.beats;
        if is_rest_token(&chord.token) {
            continue;
        }
        // Only a hand-built song can hold a token that does not parse; it writes nothing.
        let Ok(parsed) = parse_token(&chord.token) else {
            continue;
        };
        let length = js_round(chord.beats * gate * ppq_f).max(1.0);
        let mut seen = HashSet::new();
        for note in voice_chord(&parsed, key, bass_octave, octave) {
            if seen.insert(note) {
                events.extend(note_events(
                    channel,
                    i64::from(note),
                    velocity,
                    start,
                    start + length,
                )?);
            }
        }
    }
    let name = opts.track_name.as_deref().unwrap_or(&song.title);
    let head = conductor_meta(song, name)?;
    let body = track_body(head, events, js_round(beat * ppq_f))?;
    Ok(smf(0, ppq, &[body]))
}

fn multi_track_midi(
    song: &Song,
    tracks: &[Track],
    ppq: u16,
    opts: &MidiOptions,
) -> Result<Vec<u8>, MidiError> {
    let ppq_f = f64::from(ppq);
    let end = js_round(song.total_beats() * ppq_f);
    let name = opts.track_name.as_deref().unwrap_or(&song.title);
    let mut chunks = vec![track_body(conductor_meta(song, name)?, Vec::new(), end)?];
    let all = RenderOptions {
        include_muted: true,
    };
    for track in tracks {
        if track.muted && !opts.include_muted {
            continue;
        }
        let events = render_track(song, track, all);
        chunks.push(event_track(
            &track.name,
            track.channel,
            &events,
            ppq_f,
            end,
        )?);
    }
    if let Some(melody) = &song.melody {
        if !melody.notes.is_empty() && (!melody.muted || opts.include_muted) {
            let events = render_melody(song, all);
            chunks.push(event_track(
                MELODY_TRACK_NAME,
                melody.channel,
                &events,
                ppq_f,
                end,
            )?);
        }
    }
    Ok(smf(1, ppq, &chunks))
}

/// Track chunk body: name, channel prefix and the note events on `channel`.
fn event_track(
    track_name: &str,
    track_channel: i32,
    notes: &[NoteEvent],
    ppq: f64,
    end: f64,
) -> Res<Vec<u8>> {
    let channel = check_int("track.channel", f64::from(track_channel), 0, 15)? as u8;
    let name = track_name.as_bytes();
    let mut head = vec![0, 0xff, 0x03];
    head.extend(vlq_len(name.len())?);
    head.extend(name);
    head.extend([0, 0xff, 0x20, 0x01, channel]);
    let mut events = Vec::new();
    for e in notes {
        let velocity = check_int("track.velocity", f64::from(e.velocity), 1, 127)? as u8;
        let on = js_round(e.start * ppq);
        let off = (on + 1.0).max(js_round((e.start + e.duration) * ppq));
        events.extend(note_events(channel, i64::from(e.note), velocity, on, off)?);
    }
    track_body(head, events, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlq() {
        assert_eq!(encode_vlq(0.0).unwrap(), vec![0]);
        assert_eq!(encode_vlq(127.0).unwrap(), vec![0x7f]);
        assert_eq!(encode_vlq(128.0).unwrap(), vec![0x81, 0x00]);
        assert_eq!(
            encode_vlq(0x0fff_ffff as f64).unwrap(),
            vec![0xff, 0xff, 0xff, 0x7f]
        );
        assert_eq!(
            encode_vlq(-1.0).unwrap_err().to_string(),
            "VLQ out of range: -1"
        );
        assert!(encode_vlq(0.5).is_err());
    }
}
