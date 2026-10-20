/**
 * Pure helpers of the SoundFont fetch script (docs/specs/soundfonts-v1.md §2–3): note names,
 * the shipped note grid and a strict reader for the MIDI.js `<name>-ogg.js` format. No I/O, so
 * the web tests can import it (types in lib.d.mts).
 */

/** Note names as the MIDI.js soundfonts spell them (flats only). */
export const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI note number → MIDI.js note name (60 → "C4", 21 → "A0"). */
export function noteName(midi) {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`note must be an integer in 0..127, got ${midi}`);
  }
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** MIDI.js note name → MIDI note number ("C4" → 60), or null when it is not a note name. */
export function noteNumber(name) {
  const match = /^([A-G]b?)(-?\d)$/.exec(name);
  if (match === null) return null;
  const index = NOTE_NAMES.indexOf(match[1] ?? '');
  if (index < 0) return null;
  const midi = index + 12 * (Number(match[2]) + 1);
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** The shipped notes: `low + step × k` up to and including `top`. */
export function noteGrid(rule, top) {
  const notes = [];
  for (let n = rule.low; n <= Math.min(rule.high, top); n += rule.step) notes.push(n);
  return notes;
}

const HEADER = [
  "if (typeof(MIDI) === 'undefined') var MIDI = {};",
  "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};",
];
const NOTE_LINE = /^"([A-G]b?-?\d)": "data:audio\/ogg;base64,([A-Za-z0-9+/]+={0,2})",?$/;
/** Every Ogg file starts with the capture pattern "OggS". */
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53];

/**
 * Read a MIDI.js `<name>-ogg.js` file without evaluating it: the two guard lines, the
 * `MIDI.Soundfont.<name> = {` line, one `"<Note>": "data:audio/ogg;base64,…"` line per note and
 * the closing brace, blank lines anywhere. Anything else throws. Returns note name → Ogg bytes.
 */
export function parseSoundfontJs(text, name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid instrument name: ${name}`);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const expected = [...HEADER, `MIDI.Soundfont.${name} = {`];
  expected.forEach((line, i) => {
    if (lines[i] !== line) throw new Error(`${name}: unexpected line ${i + 1}`);
  });
  if (lines.at(-1) !== '}') throw new Error(`${name}: missing closing brace`);
  const notes = new Map();
  for (const line of lines.slice(expected.length, -1)) {
    const match = NOTE_LINE.exec(line);
    if (match === null) throw new Error(`${name}: unexpected content`);
    const [, note = '', data = ''] = match;
    if (noteNumber(note) === null) throw new Error(`${name}: invalid note ${note}`);
    if (notes.has(note)) throw new Error(`${name}: duplicate note ${note}`);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (!OGG_MAGIC.every((b, i) => bytes[i] === b)) throw new Error(`${name}: ${note} is not Ogg`);
    notes.set(note, bytes);
  }
  if (notes.size === 0) throw new Error(`${name}: no notes`);
  return notes;
}

/** Text of NOTICE.txt, shipped next to the samples. */
export function noticeText(manifest) {
  const { source } = manifest;
  return [
    'Croky Chords SoundFont samples',
    '',
    `Instrument samples rendered from the Fluid R3 General MIDI SoundFont (FluidR3_GM.sf2,`,
    'by Frank Wen and contributors, distributed under the MIT licence), as published by the',
    `MIDI.js soundfonts project: ${source.repository}`,
    `(folder ${source.folder}, commit ${source.commit}).`,
    '',
    "That project's LICENSE.txt (MIT, copyright 2012 Benjamin Gleitzman) is shipped next to",
    'this file. Its README states that the rendered Fluid soundfont is released under the',
    'Creative Commons Attribution 3.0 licence (https://creativecommons.org/licenses/by/3.0/).',
    '',
    'The .ogg files are the per-note Ogg Vorbis files of that rendering, unpacked from the',
    'base64 data in <instrument>-ogg.js without re-encoding. Only every third note is shipped.',
    '',
  ].join('\n');
}
