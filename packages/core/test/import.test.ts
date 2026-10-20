import { describe, expect, it } from 'vitest';
import type { Melody, MelodyNote, Mode, Song } from '../src';
import {
  ImportError,
  createSong,
  encodeVlq,
  formatToken,
  importFile,
  importMidi,
  importMusicXml,
  importTitle,
  isImportFileName,
  parseToken,
  songToMidi,
  toPitchClass,
  tryParseToken,
  validateSong,
} from '../src';
import { decodeText, readSmf } from '../src/import/smf';
import { parseXml, XmlError } from '../src/import/xml';
import {
  SHAPES,
  detectKey,
  estimateGate,
  matchChord,
  melodyDegree,
  melodyLine,
  placeChord,
} from '../src/import/recognize';
import type { ChordMatch } from '../src/import/recognize';
import { HARMONY_KINDS } from '../src/import/musicxml';
import leadSheet from './fixtures/import/lead-sheet.musicxml?raw';
import pianoScore from './fixtures/import/piano-two-staves.musicxml?raw';

function n(
  beat: number,
  length: number,
  degree: MelodyNote['degree'],
  octave = 0,
  accidental: MelodyNote['accidental'] = 0,
): MelodyNote {
  return { beat, length, degree, octave, accidental };
}

function melody(notes: MelodyNote[]): Melody {
  return { channel: 3, muted: false, notes };
}

function song(
  tonic: string,
  mode: Mode,
  chords: [string, number][],
  notes: MelodyNote[] = [],
  extra: Partial<Song> = {},
): Song {
  return createSong({
    title: 'Round trip',
    key: { tonic, mode },
    tempo: 104,
    chords: chords.map(([token, beats]) => ({ token, beats })),
    melody: melody(notes),
    ...extra,
  });
}

/** Export with our own writer, re-import, compare what the importer promises to recover. */
function roundTrip(original: Song, includeMuted = false): void {
  const { song: back, report } = importMidi(songToMidi(original, { includeMuted }));
  expect(back.chords).toEqual(original.chords);
  expect(back.key).toEqual(original.key);
  expect(back.tempo).toBe(original.tempo);
  expect(back.meter).toEqual(original.meter);
  expect(back.title).toBe(original.title);
  expect(back.melody?.notes).toEqual(original.melody?.notes);
  expect(report.dropped).toEqual([]);
  expect(validateSong(back)).toEqual(back);
}

describe('round trip through our own MIDI writer', () => {
  it('a major-key song with inversions, sevenths, a rest, borrowed and secondary chords', () => {
    roundTrip(
      song(
        'G',
        'major',
        [
          ['I', 4],
          ['V/1', 4],
          ['vi', 2],
          ['IV7', 2],
          ['rest', 4],
          ['V/vi', 4],
          ['vi7', 4],
          ['bVII', 4],
          ['ii7/3', 4],
          ['Vsus4', 2],
          ['V7', 2],
          ['I', 4],
        ],
        [n(0, 1, 1), n(1, 0.5, 3), n(1.5, 0.25, 4, 0, 1), n(2, 4, 5), n(8, 1, 7, -1), n(10, 2, 6)],
      ),
    );
  });

  it('a minor-key song with a major V, a borrowed bVI and a repeated chord', () => {
    roundTrip(
      song(
        'C',
        'minor',
        [
          ['i', 4],
          ['i', 4],
          ['iv/2', 4],
          ['V7', 4],
          ['VI', 2],
          ['III', 2],
          ['iiø7', 4],
          ['V', 4],
          ['i', 8],
        ],
        [n(0, 2, 5, -1), n(2, 2, 3), n(4, 4, 1), n(12, 1, 7, -1, 1), n(13, 3, 1)],
      ),
    );
  });

  it('mixolydian and dorian tonics come back from the chords and the key signature', () => {
    roundTrip(
      song('D', 'mixolydian', [
        ['I', 4],
        ['VII', 4],
        ['IV', 4],
        ['I', 4],
      ]),
    );
    roundTrip(
      song('E', 'dorian', [
        ['i7', 4],
        ['IV7', 4],
        ['i7', 4],
        ['IV', 2],
        ['i', 2],
      ]),
    );
  });

  it('3/4, a slow tempo, flat keys and the muted arp track exported too', () => {
    roundTrip(
      song(
        'Eb',
        'major',
        [
          ['I', 3],
          ['vi', 3],
          ['ii', 3],
          ['V7', 3],
          ['Imaj7', 6],
        ],
        [n(0, 3, 3), n(3, 1.5, 1), n(4.5, 1.5, 7, -1), n(6, 6, 2)],
        { meter: { beats: 3, unit: 4 }, tempo: 63 },
      ),
      true,
    );
  });

  it('an empty song and a song with only a melody', () => {
    const empty = importMidi(songToMidi(song('C', 'major', [])));
    expect(empty.song.chords).toEqual([]);
    expect(empty.report.chordSource).toBe('none');
    const onlyMelody = createSong({
      melody: melody([n(0, 1, 1)]),
      chords: [{ token: 'rest', beats: 4 }],
    });
    const back = importMidi(songToMidi(onlyMelody)).song;
    expect(back.melody?.notes).toEqual([n(0, 1, 1)]);
  });
});

describe('chord matching', () => {
  const weights = (pcs: number[]): number[] => {
    const w = Array.from({ length: 12 }, () => 0);
    for (const pc of pcs) w[pc % 12] = (w[pc % 12] ?? 0) + 1;
    return w;
  };

  it('every shape formats to a token that parses back', () => {
    for (const s of SHAPES) {
      const token = formatToken({ ...s.chord, degree: 2, accidental: -1, inversion: 0 });
      expect(tryParseToken(token), token).toBeDefined();
    }
  });

  it('recognises triads, sevenths and their inversions from the bass', () => {
    const c = matchChord(weights([0, 4, 7]), 0);
    expect(c?.root).toBe(0);
    expect(c?.shape.chord.quality).toBe('major');
    const am7 = matchChord(weights([9, 0, 4, 7]), 9);
    expect(am7?.root).toBe(9);
    expect(am7?.shape.chord.extension).toBe('7');
    const c6 = matchChord(weights([9, 0, 4, 7]), 0);
    expect(c6?.root).toBe(0);
    expect(c6?.shape.chord.adds).toEqual([6]);
    const dim7 = matchChord(weights([11, 2, 5, 8]), 5);
    expect(dim7?.root).toBe(5);
    expect(dim7?.shape.chord.extension).toBe('°7');
    const g7 = matchChord(weights([7, 11, 2, 5]), 11);
    expect(g7?.root).toBe(7);
    expect(g7?.bass).toBe(11);
  });

  it('allows a missing fifth but not single notes or clusters', () => {
    expect(matchChord(weights([0, 4]), 0)?.shape.chord.quality).toBe('major');
    expect(matchChord(weights([0]), 0)).toBeNull();
    expect(matchChord(weights([0, 1, 2, 3, 4, 5, 6]), 0)).toBeNull();
    expect(
      matchChord(
        Array.from({ length: 12 }, () => 0),
        null,
      ),
    ).toBeNull();
  });

  it('places matches in a key: diatonic, borrowed, secondary, sharp diminished', () => {
    const key = { tonic: toPitchClass(0), mode: 'major' as const };
    const m = (pcs: number[], bass: number): ChordMatch => {
      const match = matchChord(weights(pcs), toPitchClass(bass));
      if (match === null) throw new Error('no match');
      return match;
    };
    expect(placeChord(m([0, 4, 7], 4), key, null)?.token).toBe('I/1');
    expect(placeChord(m([10, 2, 5], 10), key, null)).toEqual({
      token: 'bVII',
      kind: 'borrowed',
      bassIgnored: false,
    });
    expect(placeChord(m([4, 8, 11, 2], 4), key, m([9, 0, 4], 9))?.token).toBe('V7/vi');
    expect(placeChord(m([4, 8, 11], 4), key, m([5, 9, 0], 5))?.token).toBe('III');
    expect(placeChord(m([6, 9, 0], 6), key, null)?.token).toBe('#iv°');
    expect(placeChord(m([8, 0, 3], 8), key, null)?.token).toBe('bVI');
  });
});

describe('key detection', () => {
  it('uses the tonic chords and the key-signature hint to tell relative modes apart', () => {
    const hist = [3, 0, 2, 0, 2, 2, 0, 3, 0, 2, 0, 1];
    const c = matchChord([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], 0);
    const a = matchChord([1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0], 9);
    if (c === null || a === null) throw new Error('no match');
    const seg = (start: number, match: ChordMatch) => ({
      start,
      end: start + 4,
      match,
      silent: false,
      notes: '',
    });
    expect(detectKey(hist, [seg(0, c), seg(4, a), seg(8, c)], null).key).toEqual({
      tonic: 0,
      mode: 'major',
    });
    expect(
      detectKey(hist, [seg(0, a), seg(4, c), seg(8, a)], { fifths: 0, minor: true, mode: null })
        .key,
    ).toEqual({ tonic: 9, mode: 'minor' });
    expect(
      detectKey(
        Array.from({ length: 12 }, () => 0),
        [],
        null,
      ).key.mode,
    ).toBe('major');
  });
});

describe('melody', () => {
  it('spells off-scale pitches as chord tones, else flat, except the raised fourth', () => {
    const key = { tonic: toPitchClass(0), mode: 'major' as const };
    expect(melodyDegree(60, key, null)).toEqual({ degree: 1, octave: 0, accidental: 0 });
    expect(melodyDegree(59, key, null)).toEqual({ degree: 7, octave: -1, accidental: 0 });
    expect(melodyDegree(66, key, null)).toEqual({ degree: 4, octave: 0, accidental: 1 });
    expect(melodyDegree(70, key, null)).toEqual({ degree: 7, octave: 0, accidental: -1 });
    expect(melodyDegree(68, key, parseToken('V/vi'))).toEqual({
      degree: 5,
      octave: 0,
      accidental: 1,
    });
    expect(melodyDegree(68, key, null)).toEqual({ degree: 6, octave: 0, accidental: -1 });
    expect(melodyDegree(10, key, null)).toBeNull();
  });

  it('keeps the highest note per start and undoes the gate', () => {
    const notes = [
      { start: 0, end: 0.9, pitch: 60, velocity: 90 },
      { start: 0, end: 0.9, pitch: 64, velocity: 90 },
      { start: 1, end: 1.9, pitch: 62, velocity: 90 },
      { start: 2, end: 2.45, pitch: 64, velocity: 90 },
    ];
    expect(estimateGate(notes)).toBeCloseTo(0.9);
    expect(melodyLine(notes, 4)).toEqual([
      { start: 0, end: 1, pitch: 64 },
      { start: 1, end: 2, pitch: 62 },
      { start: 2, end: 2.5, pitch: 64 },
    ]);
  });
});

describe('MusicXML', () => {
  it('reads a lead sheet: chord symbols, ties, tempo, the key and the title', () => {
    const { song: s, report } = importMusicXml(leadSheet);
    expect(s.title).toBe('Lead sheet example');
    expect(s.key).toEqual({ tonic: 'F', mode: 'major' });
    expect(s.tempo).toBe(88);
    expect(s.chords).toEqual([
      { token: 'I', beats: 2 },
      { token: 'vi7', beats: 2 },
      { token: 'IV', beats: 2 },
      { token: 'V7', beats: 2 },
      { token: 'I/1', beats: 4 },
      { token: 'ii7', beats: 2 },
      { token: 'V7', beats: 2 },
      { token: 'I', beats: 4 },
    ]);
    expect(s.melody?.notes).toEqual([
      n(0, 1, 3),
      n(1, 1, 5),
      n(2, 2, 6),
      n(4, 0.5, 6),
      n(4.5, 0.5, 5),
      n(5, 1, 4),
      n(6, 2, 2),
      n(8, 3, 3),
      n(12, 1, 2),
      n(13, 1, 4),
      n(14, 1, 3),
      n(15, 1, 2),
      n(16, 4, 1),
    ]);
    expect(report.chordSource).toBe('symbols');
    expect(report.parts).toEqual([{ name: 'Voice', notes: 13, role: 'melody' }]);
    expect(report.dropped).toEqual([]);
  });

  it('reads a two-staff piano score: block chords on staff 2, melody on staff 1', () => {
    const { song: s, report } = importMusicXml(pianoScore);
    expect(s.title).toBe('Piano sketch');
    expect(s.key).toEqual({ tonic: 'A', mode: 'minor' });
    expect(s.meter).toEqual({ beats: 3, unit: 4 });
    expect(s.tempo).toBe(72);
    expect(s.chords).toEqual([
      { token: 'i', beats: 3 },
      { token: 'iv/1', beats: 3 },
      { token: 'V7', beats: 3 },
      { token: 'i', beats: 3 },
    ]);
    expect(s.melody?.notes).toEqual([
      n(0, 1, 5),
      n(1, 1, 3),
      n(2, 1, 1),
      n(3, 2, 4),
      n(5, 1, 6),
      n(6, 4, 5),
      n(10, 1, 7, -1, 1),
      n(11, 1, 1),
    ]);
    expect(report.parts.map((p) => [p.name, p.role])).toEqual([
      ['Piano (staff 1)', 'melody'],
      ['Piano (staff 2)', 'chords'],
    ]);
    expect(report.dropped).toEqual([{ kind: 'note', beat: 3, detail: 'grace note' }]);
    expect(report.chords).toMatchObject({ total: 4, diatonic: 3, borrowed: 1 });
  });

  it('knows every chord-symbol kind it lists', () => {
    for (const [kind, intervals] of Object.entries(HARMONY_KINDS)) {
      expect(intervals[0], kind).toBe(0);
    }
  });

  it('rejects what is not a partwise score', () => {
    expect(() => importMusicXml('<score-timewise/>')).toThrow(ImportError);
    expect(() => importMusicXml('<html></html>')).toThrow(/not a MusicXML score/);
    expect(() => importMusicXml('<score-partwise><part-list></score-partwise>')).toThrow(
      ImportError,
    );
    expect(() => importMusicXml('<score-partwise></score-partwise>')).toThrow(/no parts/);
  });

  it('the XML reader handles entities, CDATA, comments and declarations', () => {
    const root = parseXml(
      '﻿<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a k=\'&lt;1&gt;\'><!-- c --><b>&amp;&#65;&#x42;<![CDATA[<i>]]></b><c/></a>',
    );
    expect(root.attrs['k']).toBe('<1>');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(root.children[0]?.text).toBe('&AB<i>');
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('text')).toThrow(XmlError);
    expect(() => parseXml('<a/><b/>')).toThrow(XmlError);
  });
});

/** A format-0 MIDI file from raw track bytes. */
function smf(track: number[], division = 96, format = 0, extraTracks: number[][] = []): Uint8Array {
  const chunk = (body: number[]) => [
    0x4d,
    0x54,
    0x72,
    0x6b,
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    ...body,
  ];
  const tracks = [track, ...extraTracks];
  return Uint8Array.from([
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    format,
    0,
    tracks.length,
    (division >> 8) & 0xff,
    division & 0xff,
    ...tracks.flatMap(chunk),
  ]);
}

describe('MIDI reader', () => {
  it('reads running status, velocity-0 note-offs and splits format 0 by channel', () => {
    // C major triad on channel 1 (running status, note-on velocity 0 as note-off), a melody note
    // on channel 2 and a drum hit on channel 10.
    const track = [
      0,
      0xff,
      0x03,
      4,
      ...'Demo'.split('').map((c) => c.charCodeAt(0)),
      0,
      0x90,
      60,
      90,
      0,
      64,
      90,
      0,
      67,
      90,
      0,
      0x91,
      72,
      100,
      0,
      0x99,
      36,
      100,
      ...encodeVlq(96),
      0x99,
      36,
      0,
      ...encodeVlq(288),
      0x90,
      60,
      0,
      0,
      64,
      0,
      0,
      67,
      0,
      0,
      0x81,
      72,
      0,
      0,
      0xff,
      0x2f,
      0,
    ];
    const score = readSmf(smf(track));
    expect(score.title).toBe('Demo');
    expect(score.parts.map((p) => [p.name, p.notes.length, p.drums])).toEqual([
      ['Demo (ch 1)', 3, false],
      ['Demo (ch 2)', 1, false],
      ['Demo (ch 10)', 1, true],
    ]);
    expect(score.parts[0]?.notes[0]).toEqual({ start: 0, end: 4, pitch: 60, velocity: 90 });
    const { song: s, report } = importMidi(smf(track), { title: 'fallback' });
    expect(s.chords).toEqual([{ token: 'I', beats: 4 }]);
    expect(s.melody?.notes).toEqual([n(0, 4, 1, 1)]);
    expect(report.parts.map((p) => p.role)).toEqual(['chords', 'melody', 'drums']);
    expect(report.dropped[0]?.kind).toBe('part');
  });

  it('closes notes without a note-off, survives a cut-off file and warns', () => {
    const track = [
      0,
      0x90,
      60,
      90,
      0,
      0x90,
      64,
      90,
      0,
      0x90,
      67,
      90,
      ...encodeVlq(192),
      0xff,
      0x2f,
      0,
    ];
    const { song: s, report } = importMidi(smf(track));
    expect(s.chords).toEqual([{ token: 'I', beats: 2 }]);
    expect(report.warnings.join(' ')).toMatch(/no note-off/);
    const bytes = smf(track);
    const cut = importMidi(bytes.subarray(0, bytes.length - 6));
    expect(cut.report.warnings.join(' ')).toMatch(/cut off/);
  });

  it('converts SMPTE time with the first tempo and reads tempo and meter changes', () => {
    const tempo = (us: number) => [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
    const track = [
      0,
      ...tempo(500000),
      0,
      0xff,
      0x58,
      4,
      3,
      2,
      24,
      8,
      0,
      0x90,
      60,
      90,
      0,
      0x90,
      64,
      90,
      0,
      0x90,
      67,
      90,
      ...encodeVlq(75),
      ...tempo(400000),
      ...encodeVlq(0),
      0x80,
      60,
      0,
      0,
      0x80,
      64,
      0,
      0,
      0x80,
      67,
      0,
      0,
      0xff,
      0x2f,
      0,
    ];
    // 25 frames × 40 ticks = 1000 ticks per second; at 120 BPM a beat is 500 ticks.
    const division = ((256 - 25) << 8) | 40;
    const { song: s, report } = importMidi(smf(track, division));
    expect(s.tempo).toBe(120);
    expect(s.meter).toEqual({ beats: 3, unit: 4 });
    expect(report.warnings.join(' ')).toMatch(/SMPTE/);
    expect(report.warnings.join(' ')).toMatch(/tempo changes/);
  });

  it('rejects files that are not MIDI', () => {
    expect(() => importMidi(new Uint8Array([1, 2, 3]))).toThrow(ImportError);
    expect(() => importMidi(smf([], 0))).toThrow(/division/);
    const noTracks = smf([]).subarray(0, 14);
    expect(() => importMidi(noTracks)).toThrow(/no tracks/);
  });

  it('decodes UTF-8 names and falls back to bytes', () => {
    expect(decodeText(Uint8Array.from([0x43, 0xc3, 0xa9]))).toBe('Cé');
    expect(decodeText(Uint8Array.from([0xe9, 0x41]))).toBe('éA');
  });
});

describe('importFile', () => {
  it('picks the reader by extension or content and names the song after the file', () => {
    const bytes = songToMidi(song('A', 'minor', [['i', 4]]), {});
    expect(importFile('folder/My song.mid', bytes).report.format).toBe('midi');
    expect(importFile('unknown.bin', bytes).report.format).toBe('midi');
    const untitled = createSong({ title: '', chords: [{ token: 'I', beats: 4 }] });
    expect(importFile('Night drive.midi', songToMidi(untitled)).song.title).toBe('Night drive');
    const xml = Uint8Array.from(leadSheet, (c) => c.charCodeAt(0) & 0xff);
    expect(importFile('sheet.musicxml', xml).song.title).toBe('Lead sheet example');
    expect(() => importFile('score.mxl', xml)).toThrow(/compressed/);
    expect(importFile('x.mid', bytes, { key: { tonic: 'C', mode: 'major' } }).song.chords).toEqual([
      { token: 'vi', beats: 4 },
    ]);
  });

  it('file names and titles', () => {
    expect(isImportFileName('a.MID')).toBe(true);
    expect(isImportFileName('a.musicxml')).toBe(true);
    expect(isImportFileName('a.mxl')).toBe(false);
    expect(isImportFileName('a.wav')).toBe(false);
    expect(importTitle('dir/sub/Song one.mid')).toBe('Song one');
    expect(importTitle('.hidden')).toBe('.hidden');
  });
});

describe('robustness', () => {
  /** Deterministic pseudo-random numbers (mulberry32). */
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const expectSafe = (run: () => { song: Song }): void => {
    try {
      const { song: s } = run();
      expect(validateSong(s)).toEqual(s);
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
    }
  };

  it('random bytes and mutated MIDI files never throw anything but ImportError', () => {
    const random = rng(98);
    const base = songToMidi(
      song(
        'F',
        'major',
        [
          ['I', 4],
          ['IV/2', 2],
          ['V7', 2],
          ['vi', 4],
        ],
        [n(0, 1, 1), n(1, 1, 3), n(2, 2, 5)],
      ),
    );
    for (let i = 0; i < 300; i++) {
      const bytes = Uint8Array.from(base);
      const flips = 1 + Math.floor(random() * 8);
      for (let k = 0; k < flips; k++) {
        bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      }
      const cut = random() < 0.3 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
      expectSafe(() => importMidi(cut));
    }
    for (let i = 0; i < 100; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 400) }, () =>
        Math.floor(random() * 256),
      );
      if (bytes.length >= 8 && random() < 0.5) bytes.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6], 0);
      expectSafe(() => importMidi(bytes));
    }
  });

  it('random notes in many parts give a valid song', () => {
    const random = rng(7);
    for (let i = 0; i < 40; i++) {
      const tracks: number[][] = [];
      for (let t = 0; t < 1 + Math.floor(random() * 4); t++) {
        const body: number[] = [];
        for (let e = 0; e < 60; e++) {
          const channel = Math.floor(random() * 16);
          body.push(
            ...encodeVlq(Math.floor(random() * 200)),
            0x90 | channel,
            Math.floor(random() * 128),
            1 + Math.floor(random() * 126),
          );
          body.push(
            ...encodeVlq(Math.floor(random() * 200)),
            0x80 | channel,
            Math.floor(random() * 128),
            0,
          );
        }
        body.push(0, 0xff, 0x2f, 0);
        tracks.push(body);
      }
      const [first = [], ...rest] = tracks;
      expectSafe(() => importMidi(smf(first, 96, 1, rest)));
    }
  });

  it('mutated MusicXML never throws anything but ImportError', () => {
    const random = rng(3);
    for (let i = 0; i < 200; i++) {
      const chars = [...pianoScore];
      for (let k = 0; k < 5; k++) {
        const at = Math.floor(random() * chars.length);
        chars[at] = '<>/="a1 '.charAt(Math.floor(random() * 8));
      }
      expectSafe(() => importMusicXml(chars.join('')));
    }
  });
});
