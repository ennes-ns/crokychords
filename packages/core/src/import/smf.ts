/**
 * Standard MIDI File reader for the importer (docs/specs/import-v1.md §A2): formats 0, 1 and 2,
 * running status, meta and sysex events, note pairing first-in first-out. Every read is bounds
 * checked; a truncated track keeps what was read before the cut.
 */
import type { ImportScore, KeyHint, ScoreNote, ScorePart } from './score';
import { ImportError, MAX_IMPORT_NOTES, ReportLog } from './score';

/** UTF-8 text of meta events; invalid sequences fall back to one character per byte. */
export function decodeText(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i] ?? 0;
    const need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf8 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    let cp = need === 0 ? b : need === 1 ? b & 0x1f : need === 2 ? b & 0x0f : b & 0x07;
    let ok = need >= 0 && i + need < bytes.length;
    for (let k = 1; ok && k <= need; k++) {
      const c = bytes[i + k] ?? 0;
      if ((c & 0xc0) !== 0x80) ok = false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (ok && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      out += String.fromCodePoint(cp);
      i += need + 1;
    } else {
      out += String.fromCharCode(b);
      i += 1;
    }
  }
  return out;
}

/** Strip control characters and surrounding blanks from a name. */
export function cleanName(text: string): string {
  let out = '';
  for (const ch of text) out += (ch.codePointAt(0) ?? 0) < 0x20 ? ' ' : ch;
  return out.replace(/\s+/g, ' ').trim();
}

class Truncated extends Error {}

class Reader {
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  byte(): number {
    if (this.pos >= this.end) throw new Truncated();
    return this.bytes[this.pos++] ?? 0;
  }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new Truncated();
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.end) throw new Truncated();
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x1000000 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

interface RawNote {
  channel: number;
  startTick: number;
  endTick: number;
  pitch: number;
  velocity: number;
}

interface RawTrack {
  name: string | null;
  instrument: string | null;
  notes: RawNote[];
  endTick: number;
}

interface FileMeta {
  tempos: { tick: number; bpm: number }[];
  meters: { tick: number; beats: number; unit: number }[];
  keys: { tick: number; hint: KeyHint }[];
  noteCount: number;
  openNotes: number;
  truncated: number;
}

function readTrack(r: Reader, meta: FileMeta, log: ReportLog): RawTrack {
  const track: RawTrack = { name: null, instrument: null, notes: [], endTick: 0 };
  const open = new Map<number, { tick: number; velocity: number }[]>();
  let tick = 0;
  let status = 0;
  try {
    while (!r.done) {
      tick += r.vlq();
      let b = r.byte();
      if (b < 0x80) {
        // Running status: the byte is the first data byte of the previous status.
        if (status < 0x80 || status >= 0xf0) throw new Truncated();
        r.pos--;
        b = status;
      }
      if (b === 0xff) {
        const type = r.byte();
        const data = r.take(r.vlq());
        if (type === 0x2f) break;
        if (type === 0x03 && track.name === null) track.name = cleanName(decodeText(data));
        else if (type === 0x04 && track.instrument === null) {
          track.instrument = cleanName(decodeText(data));
        } else if (type === 0x51 && data.length >= 3) {
          const us = ((data[0] ?? 0) << 16) | ((data[1] ?? 0) << 8) | (data[2] ?? 0);
          if (us > 0) meta.tempos.push({ tick, bpm: 60_000_000 / us });
        } else if (type === 0x58 && data.length >= 2) {
          const beats = data[0] ?? 0;
          const power = data[1] ?? 0;
          if (beats > 0 && power <= 5) meta.meters.push({ tick, beats, unit: 2 ** power });
        } else if (type === 0x59 && data.length >= 2) {
          const sf = ((data[0] ?? 0) << 24) >> 24;
          if (sf >= -7 && sf <= 7) {
            meta.keys.push({ tick, hint: { fifths: sf, minor: data[1] === 1, mode: null } });
          }
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.take(r.vlq());
        status = 0;
        continue;
      }
      if (b >= 0xf0) {
        // System common/real-time bytes do not belong in a file; skip their data bytes.
        status = 0;
        const sizes: Record<number, number> = { 0xf1: 1, 0xf2: 2, 0xf3: 1 };
        r.take(sizes[b] ?? 0);
        continue;
      }
      status = b;
      const kind = b & 0xf0;
      const channel = b & 0x0f;
      const d1 = r.byte() & 0x7f;
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.byte() & 0x7f;
      if (kind !== 0x80 && kind !== 0x90) continue;
      const key = channel * 128 + d1;
      if (kind === 0x90 && d2 > 0) {
        const list = open.get(key) ?? [];
        list.push({ tick, velocity: d2 });
        open.set(key, list);
        continue;
      }
      const started = open.get(key)?.shift();
      if (started === undefined) continue;
      if (meta.noteCount >= MAX_IMPORT_NOTES) continue;
      meta.noteCount++;
      track.notes.push({
        channel,
        startTick: started.tick,
        endTick: tick,
        pitch: d1,
        velocity: started.velocity,
      });
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    meta.truncated++;
  }
  track.endTick = tick;
  for (const [key, list] of open) {
    for (const started of list) {
      meta.openNotes++;
      if (meta.noteCount >= MAX_IMPORT_NOTES) continue;
      meta.noteCount++;
      track.notes.push({
        channel: Math.floor(key / 128),
        startTick: started.tick,
        endTick: Math.max(tick, started.tick + 1),
        pitch: key % 128,
        velocity: started.velocity,
      });
    }
  }
  if (meta.noteCount >= MAX_IMPORT_NOTES) {
    log.warn(`Only the first ${MAX_IMPORT_NOTES.toLocaleString('en-US')} notes were read.`);
  }
  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return track;
}

/** Read a Standard MIDI File into the intermediate score. Throws ImportError when it is none. */
export function readSmf(bytes: Uint8Array): ImportScore {
  const log = new ReportLog();
  if (bytes.length < 14 || tag(bytes, 0) !== 'MThd') {
    throw new ImportError('not a Standard MIDI File (no "MThd" header)');
  }
  const headerLength = u32(bytes, 4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) {
    throw new ImportError('the MIDI header is cut off');
  }
  const format = u16(bytes, 8);
  if (format > 2) throw new ImportError(`unknown MIDI file format ${format}`);
  const division = u16(bytes, 12);
  if (division === 0) throw new ImportError('the MIDI file has a division of 0 ticks');

  const meta: FileMeta = {
    tempos: [],
    meters: [],
    keys: [],
    noteCount: 0,
    openNotes: 0,
    truncated: 0,
  };
  const tracks: RawTrack[] = [];
  let at = 8 + headerLength;
  while (at + 8 <= bytes.length) {
    const id = tag(bytes, at);
    const length = u32(bytes, at + 4);
    const start = at + 8;
    const end = Math.min(bytes.length, start + length);
    if (id === 'MTrk') tracks.push(readTrack(new Reader(bytes, start, end), meta, log));
    if (start + length > bytes.length) {
      if (id === 'MTrk') meta.truncated++;
      break;
    }
    at = start + length;
  }
  if (tracks.length === 0) throw new ImportError('the MIDI file has no tracks');
  if (meta.truncated > 0) log.warn('The file is cut off; the notes before the cut were read.');
  if (meta.openNotes > 0) {
    log.warn(`${meta.openNotes} note(s) had no note-off and were ended at the end of their track.`);
  }

  meta.tempos.sort((a, b) => a.tick - b.tick);
  const firstTempo = meta.tempos[0]?.bpm ?? null;
  if (meta.tempos.some((t) => Math.abs(t.bpm - (firstTempo ?? t.bpm)) > 0.01)) {
    log.warn('The tempo changes during the file; the first tempo is used.');
  }
  meta.meters.sort((a, b) => a.tick - b.tick);
  const meter = meta.meters[0];
  if (meta.meters.some((m) => m.beats !== meter?.beats || m.unit !== meter.unit)) {
    log.warn('The meter changes during the file; the first meter is used.');
  }
  meta.keys.sort((a, b) => a.tick - b.tick);
  const key = meta.keys[0]?.hint ?? null;
  if (meta.keys.some((k) => k.hint.fifths !== key?.fifths || k.hint.minor !== key.minor)) {
    log.warn('The key signature changes during the file; one key is used for the whole song.');
  }

  let ticksPerBeat: number;
  if ((division & 0x8000) !== 0) {
    const fps = 256 - (division >> 8);
    const perFrame = division & 0xff;
    const bpm = firstTempo ?? 120;
    ticksPerBeat = Math.max(1, (fps * perFrame * 60) / bpm);
    log.warn('The file counts time in SMPTE frames; it was converted with the first tempo.');
  } else {
    ticksPerBeat = division;
  }
  const beats = (tick: number): number => tick / ticksPerBeat;

  const parts: ScorePart[] = [];
  tracks.forEach((track, index) => {
    const channels = [...new Set(track.notes.map((n) => n.channel))].sort((a, b) => a - b);
    const base = track.name || track.instrument || `Track ${index + 1}`;
    for (const channel of channels) {
      const notes: ScoreNote[] = track.notes
        .filter((n) => n.channel === channel)
        .map((n) => ({
          start: beats(n.startTick),
          end: beats(Math.max(n.endTick, n.startTick + 1)),
          pitch: n.pitch,
          velocity: n.velocity,
        }));
      parts.push({
        name: channels.length > 1 ? `${base} (ch ${channel + 1})` : base,
        notes,
        drums: channel === 9,
        end: beats(track.endTick),
      });
    }
  });

  const first = tracks[0];
  // A conductor track (no notes) or a format-0 file names the song; a track with notes names
  // its instrument.
  const title = first?.name && (format === 0 || first.notes.length === 0) ? first.name : null;
  return {
    format: 'midi',
    title,
    tempo: firstTempo,
    meter: meter === undefined ? null : { beats: meter.beats, unit: meter.unit },
    key,
    parts,
    harmonies: [],
    length: null,
    log,
  };
}
