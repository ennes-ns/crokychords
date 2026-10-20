// @vitest-environment node
/**
 * The SoundFont fetch script's helpers and manifest (tools/soundfonts/, docs/specs/
 * soundfonts-v1.md §1–3): the strict reader of the MIDI.js format, the note grid, and the
 * agreement between the committed manifest and the app's catalogue, within the size budget.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../../tools/soundfonts/lib.mjs';
import {
  noteGrid,
  noteName,
  noteNumber,
  noticeText,
  parseSoundfontJs,
} from '../../../tools/soundfonts/lib.mjs';
import { SOUNDFONTS } from '../src/audio/instruments';
import { SAMPLE_GRID, SOUNDFONT_VERSION } from '../src/audio/soundfont';

const manifestPath = fileURLToPath(
  new URL('../../../tools/soundfonts/manifest.json', import.meta.url),
);
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** Base64 of a tiny byte string that starts like an Ogg file. */
const OGG = Buffer.from('OggS fake payload').toString('base64');
const HEAD = [
  "if (typeof(MIDI) === 'undefined') var MIDI = {};",
  "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};",
  'MIDI.Soundfont.flute = {',
];

describe('note names', () => {
  it('maps MIDI notes to the MIDI.js names and back', () => {
    expect(noteName(21)).toBe('A0');
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('Db4');
    expect(noteName(108)).toBe('C8');
    for (let n = 0; n <= 127; n++) expect(noteNumber(noteName(n))).toBe(n);
    expect(noteNumber('C#4')).toBeNull();
    expect(noteNumber('H2')).toBeNull();
    expect(() => noteName(128)).toThrow(RangeError);
  });

  it('builds the grid of shipped notes', () => {
    expect(noteGrid({ low: 21, high: 108, step: 3 }, 30)).toEqual([21, 24, 27, 30]);
    expect(noteGrid({ low: 60, high: 66, step: 3 }, 127)).toEqual([60, 63, 66]);
  });
});

describe('parseSoundfontJs', () => {
  it('reads the note lines without evaluating anything', () => {
    const text = [
      '',
      ...HEAD,
      `"A0": "data:audio/ogg;base64,${OGG}",`,
      '',
      `"Bb0": "data:audio/ogg;base64,${OGG}",`,
      '',
      '}',
      '',
    ].join('\n');
    const notes = parseSoundfontJs(text, 'flute');
    expect([...notes.keys()]).toEqual(['A0', 'Bb0']);
    expect(Buffer.from(notes.get('A0') ?? []).toString()).toBe('OggS fake payload');
  });

  it('rejects anything else', () => {
    const note = `"A0": "data:audio/ogg;base64,${OGG}",`;
    const bad = [
      [...HEAD, note, 'alert(1);', '}'],
      [...HEAD.slice(0, 2), 'MIDI.Soundfont.piano = {', note, '}'],
      [...HEAD, note],
      [...HEAD, '}'],
      [...HEAD, note, note, '}'],
      [...HEAD, `"A0": "data:audio/mp3;base64,${OGG}",`, '}'],
      [...HEAD, `"A0": "data:audio/ogg;base64,${Buffer.from('ID3 mp3').toString('base64')}",`, '}'],
      [...HEAD, `"X9": "data:audio/ogg;base64,${OGG}",`, '}'],
      ['var x = 1;', ...HEAD, note, '}'],
    ];
    for (const lines of bad) expect(() => parseSoundfontJs(lines.join('\n'), 'flute')).toThrow();
    expect(() => parseSoundfontJs('', '../evil')).toThrow();
  });
});

describe('manifest.json', () => {
  it('pins a commit of the MIDI.js soundfonts and its MIT licence file', () => {
    expect(manifest.schema_version).toBe(1);
    expect(manifest.source.repository).toBe('https://github.com/gleitz/midi-js-soundfonts');
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.source.commit.slice(0, 12)).toBe(SOUNDFONT_VERSION);
    expect(manifest.source.folder).toBe('FluidR3_GM');
    expect(manifest.source.licence).toMatchObject({ file: 'LICENSE.txt', spdx: 'MIT' });
    expect(manifest.source.licence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.notes).toEqual(SAMPLE_GRID);
    const notice = noticeText(manifest);
    expect(notice).toContain(manifest.source.commit);
    expect(notice).toContain('Creative Commons Attribution 3.0');
    expect(notice).toContain('MIT');
  });

  it('lists exactly the catalogue instruments, programs and top notes', () => {
    expect(
      manifest.instruments.map((i) => ({ id: i.name, program: i.program, top: i.top })),
    ).toEqual(SOUNDFONTS.map((s) => ({ id: s.id, program: s.program, top: s.top })));
  });

  it('checksums every shipped note on the grid', () => {
    for (const instrument of manifest.instruments) {
      expect(instrument.source.file).toBe(`${instrument.name}-ogg.js`);
      expect(instrument.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(instrument.notes)).toEqual(
        noteGrid(manifest.notes, instrument.top).map(noteName),
      );
      for (const entry of Object.values(instrument.notes)) {
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.bytes).toBeGreaterThan(0);
      }
    }
  });

  it('stays within the budget: 1 MB per instrument, 12 MB in total', () => {
    const sizes = manifest.instruments.map((i) =>
      Object.values(i.notes).reduce((sum, n) => sum + n.bytes, 0),
    );
    for (const size of sizes) expect(size).toBeLessThanOrEqual(1_000_000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12_000_000);
  });
});
