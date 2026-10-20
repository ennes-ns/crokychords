/**
 * MIDI/MusicXML import (docs/specs/import-v1.md): a file becomes a schema-4 song plus a report of
 * what was recognised and what was dropped.
 */
import type { Melody, MelodyNote } from '../melody';
import { MAX_MELODY_NOTES, defaultMelody } from '../melody';
import type { Song, SongChord } from '../progression';
import { SongError, createSong, validateSong } from '../progression';
import type { Key, Mode } from '../theory';
import { isMode, keyPrefersFlats, keySignature, noteName, parseNoteName } from '../theory';
import { REST_TOKEN, parseToken } from '../token';
import { readMusicXml } from './musicxml';
import type { Segment } from './recognize';
import {
  chordiness,
  detectKey,
  harmonySegments,
  histogram,
  isMelodyName,
  isRegularLine,
  meanPitch,
  melodyDegree,
  melodyLine,
  overlapShare,
  placeChord,
  segmentChords,
} from './recognize';
import type { ImportDrop, ImportScore, ScoreNote, ScorePart } from './score';
import { IMPORT_STEP, ImportError, MAX_IMPORT_BEATS, MAX_IMPORT_CHORDS, quantize } from './score';
import { decodeText, readSmf } from './smf';

export { ImportError, barPosition } from './score';
export type { ImportDrop } from './score';

export interface ImportOptions {
  /** Fallback title (the file name without extension) when the file names none. */
  title?: string;
  /** Use this key instead of detecting one. */
  key?: { tonic: string; mode: Mode };
}

export type PartRole = 'chords' | 'melody' | 'unused' | 'drums';

export interface ImportReport {
  format: 'midi' | 'musicxml';
  title: string;
  key: {
    tonic: string;
    mode: Mode;
    source: 'detected' | 'given';
    /** 0..1: how far ahead of the runner-up the detected key is. 1 for a given key. */
    confidence: number;
    runnerUp: { tonic: string; mode: Mode } | null;
  };
  tempo: number;
  meter: { beats: number; unit: number };
  parts: { name: string; notes: number; role: PartRole }[];
  chordSource: 'notes' | 'symbols' | 'none';
  chords: { total: number; diatonic: number; borrowed: number; secondary: number; rests: number };
  melody: { notes: number };
  dropped: ImportDrop[];
  droppedMore: number;
  warnings: string[];
}

export interface ImportResult {
  song: Song;
  report: ImportReport;
}

/** Longest title (the command contract's and the save store's limit). */
const MAX_IMPORT_TITLE = 200;
const TEMPO_MIN = 20;
const TEMPO_MAX = 300;
const METER_UNITS = [1, 2, 4, 8, 16, 32];

function tonicName(key: Key, hintFifths: number | null): string {
  // Six sharps or six flats: follow the file's spelling (F# or Gb major).
  if (hintFifths !== null && Math.abs(keySignature(key)) === 6 && hintFifths === 6) {
    return noteName(key.tonic, false);
  }
  return noteName(key.tonic, keyPrefersFlats(key));
}

function roundTempo(bpm: number): number {
  const rounded = Math.round(bpm);
  return Math.abs(bpm - rounded) < 0.01 ? rounded : Math.round(bpm * 100) / 100;
}

/** The import of an intermediate score (both readers end here). */
export function scoreToSong(score: ImportScore, options: ImportOptions = {}): ImportResult {
  const log = score.log;
  let tempo = score.tempo === null ? 120 : roundTempo(score.tempo);
  if (tempo < TEMPO_MIN || tempo > TEMPO_MAX) {
    const clamped = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, tempo));
    log.warn(`The tempo ${tempo} BPM is outside ${TEMPO_MIN}–${TEMPO_MAX}; ${clamped} is used.`);
    tempo = clamped;
  }
  let meter = score.meter ?? { beats: 4, unit: 4 };
  if (meter.beats < 1 || meter.beats > 32 || !METER_UNITS.includes(meter.unit)) {
    log.warn(`The meter ${meter.beats}/${meter.unit} is not supported; 4/4 is used.`);
    meter = { beats: 4, unit: 4 };
  }
  const barBeats = (meter.beats * 4) / meter.unit;

  // Parts and their roles.
  const roles = new Map<ScorePart, PartRole>();
  for (const part of score.parts) {
    if (part.drums && part.notes.length > 0) {
      roles.set(part, 'drums');
      log.drop('part', null, `${part.name}: drum part (${part.notes.length} notes) ignored`);
    } else {
      roles.set(part, 'unused');
    }
  }
  const pitched = score.parts.filter((p) => !p.drums && p.notes.length > 0);
  const useSymbols = score.harmonies.length > 0;
  let chordPart: ScorePart | null = null;
  if (!useSymbols) {
    let bestBeats = 0;
    for (const part of pitched) {
      const beats = chordiness(part.notes);
      if (
        beats > bestBeats ||
        (beats === bestBeats && beats > 0 && part.notes.length > (chordPart?.notes.length ?? 0))
      ) {
        bestBeats = beats;
        chordPart = part;
      }
    }
    if (chordPart !== null) roles.set(chordPart, 'chords');
  }
  const melodyCandidates = pitched.filter(
    (p) => p !== chordPart && overlapShare(p.notes) <= 0.1 && meanPitch(p.notes) >= 48,
  );
  // A part named like a melody wins; machine-regular lines (arpeggios) only when nothing else is
  // left; then the highest.
  const rank = (p: ScorePart): number =>
    (isMelodyName(p.name) ? 2 : 0) + (isRegularLine(p.notes) ? 0 : 1);
  let melodyPart: ScorePart | null = null;
  for (const part of melodyCandidates) {
    if (
      melodyPart === null ||
      rank(part) > rank(melodyPart) ||
      (rank(part) === rank(melodyPart) && meanPitch(part.notes) > meanPitch(melodyPart.notes))
    ) {
      melodyPart = part;
    }
  }
  if (melodyPart !== null) roles.set(melodyPart, 'melody');

  // Where the song ends.
  const lastEnd = (notes: readonly ScoreNote[]): number =>
    notes.reduce((a, n) => Math.max(a, n.end), 0);
  let end: number;
  if (useSymbols) {
    const allNotes = pitched.reduce((a, p) => Math.max(a, lastEnd(p.notes)), 0);
    const lastSymbol = score.harmonies.at(-1)?.start ?? 0;
    end = score.length ?? Math.max(allNotes, lastSymbol + barBeats);
  } else if (chordPart !== null) {
    const notesEnd = lastEnd(chordPart.notes);
    const declared = score.length ?? chordPart.end;
    end =
      declared !== null && declared >= notesEnd - 1e-9 && declared <= notesEnd + barBeats
        ? declared
        : Math.ceil(notesEnd - 1e-9);
  } else {
    end = 0;
  }
  end = quantize(end);
  if (end > MAX_IMPORT_BEATS) {
    log.warn(`Only the first ${MAX_IMPORT_BEATS} beats were imported.`);
    end = MAX_IMPORT_BEATS;
  }

  // Chords.
  let segments: Segment[] = [];
  if (useSymbols) segments = harmonySegments(score.harmonies, end);
  else if (chordPart !== null) segments = segmentChords(chordPart, barBeats, end, log);
  if (useSymbols) {
    for (const s of segments) {
      if (!s.silent && s.match === null) {
        log.drop('chord', s.start, `chord symbol ${s.notes} not recognised`);
      }
    }
  }

  // Key.
  const usedNotes = [...(chordPart?.notes ?? []), ...(melodyPart?.notes ?? [])];
  const guess = detectKey(histogram(usedNotes), segments, score.key);
  let key: Key = guess.key;
  let keySource: 'detected' | 'given' = 'detected';
  if (options.key !== undefined) {
    try {
      key = { tonic: parseNoteName(options.key.tonic), mode: options.key.mode };
      if (!isMode(key.mode)) throw new RangeError('mode');
      keySource = 'given';
    } catch {
      log.warn(`The key ${options.key.tonic} ${options.key.mode} is not valid; it was detected.`);
      key = guess.key;
    }
  }
  const tonic =
    keySource === 'given' && options.key !== undefined
      ? options.key.tonic
      : tonicName(key, score.key?.fifths ?? null);

  // Roman numerals.
  const chords: SongChord[] = [];
  const counts = { total: 0, diatonic: 0, borrowed: 0, secondary: 0, rests: 0 };
  segments.forEach((seg, i) => {
    const beats = quantize(seg.end - seg.start);
    if (beats < IMPORT_STEP) return;
    let token = REST_TOKEN;
    if (seg.match !== null) {
      // A secondary dominant needs its target right after it (no rest between).
      const placed = placeChord(seg.match, key, segments[i + 1]?.match ?? null);
      if (placed === null) {
        log.drop('chord', seg.start, `no token for ${seg.notes}`);
      } else {
        token = placed.token;
        counts[placed.kind]++;
        if (placed.bassIgnored) {
          log.drop('note', seg.start, `bass note under ${placed.token} is no chord tone`);
        }
      }
    }
    if (token === REST_TOKEN) counts.rests++;
    const prev = chords.at(-1);
    if (token === REST_TOKEN && prev !== undefined && prev.token === REST_TOKEN) {
      prev.beats += beats;
    } else {
      chords.push({ token, beats });
    }
  });
  if (chords.length > MAX_IMPORT_CHORDS) {
    log.warn(`Only the first ${MAX_IMPORT_CHORDS} chords were imported.`);
    chords.length = MAX_IMPORT_CHORDS;
  }
  counts.total = chords.filter((c) => c.token !== REST_TOKEN).length;
  // A trailing rest carries no information unless the melody needs it (added back below).
  while (chords.at(-1)?.token === REST_TOKEN) chords.pop();
  counts.rests = chords.filter((c) => c.token === REST_TOKEN).length;
  if (chordPart === null && !useSymbols) {
    log.warn('No part with chords was found: the song has a melody only.');
  }

  // Melody.
  const notes: MelodyNote[] = [];
  if (melodyPart !== null) {
    const chordEnd = chords.reduce((a, c) => a + c.beats, 0);
    const melodyEnd = Math.min(
      MAX_IMPORT_BEATS,
      Math.max(chordEnd, Math.ceil(lastEnd(melodyPart.notes) - 1e-9)),
    );
    const parsed = new Map<string, ReturnType<typeof parseToken>>();
    const chordAt = (beat: number): ReturnType<typeof parseToken> | null => {
      let start = 0;
      for (const c of chords) {
        if (beat < start + c.beats) {
          if (c.token === REST_TOKEN) return null;
          let p = parsed.get(c.token);
          if (p === undefined) {
            p = parseToken(c.token);
            parsed.set(c.token, p);
          }
          return p;
        }
        start += c.beats;
      }
      return null;
    };
    for (const line of melodyLine(melodyPart.notes, melodyEnd)) {
      if (line.start >= MAX_IMPORT_BEATS) {
        log.drop('note', line.start, 'melody note after the import limit');
        continue;
      }
      if (notes.length >= MAX_MELODY_NOTES) {
        log.drop('note', line.start, 'melody note over the note limit');
        continue;
      }
      const spelled = melodyDegree(line.pitch, key, chordAt(line.start));
      if (spelled === null) {
        log.drop('note', line.start, `melody note ${line.pitch} out of range`);
        continue;
      }
      notes.push({
        beat: line.start,
        length: Math.min(line.end, MAX_IMPORT_BEATS) - line.start,
        ...spelled,
      });
    }
    const melodyLast = notes.reduce((a, n) => Math.max(a, n.beat + n.length), 0);
    if (melodyLast > chordEnd && chords.length > 0) {
      const extra = Math.ceil((melodyLast - chordEnd) / IMPORT_STEP) * IMPORT_STEP;
      const prev = chords.at(-1);
      if (prev?.token === REST_TOKEN) prev.beats += extra;
      else chords.push({ token: REST_TOKEN, beats: extra });
      log.warn('The melody runs past the last chord; a rest was added so it plays to its end.');
    }
  }
  if (melodyPart === null) {
    const others = pitched.filter((p) => p !== chordPart);
    if (others.length > 0)
      log.warn('No single-voice part above the bass was found for the melody.');
  }

  const title = (score.title || options.title || 'Imported').slice(0, MAX_IMPORT_TITLE);
  const melody: Melody = { ...defaultMelody(), notes };
  let song: Song;
  try {
    song = validateSong(
      JSON.parse(
        JSON.stringify(
          createSong({ title, key: { tonic, mode: key.mode }, tempo, meter, chords, melody }),
        ),
      ),
    );
  } catch (e) {
    if (e instanceof SongError)
      throw new ImportError(`the import is not a valid song: ${e.message}`);
    throw e;
  }

  const report: ImportReport = {
    format: score.format,
    title,
    key: {
      tonic,
      mode: key.mode,
      source: keySource,
      confidence: keySource === 'given' ? 1 : Math.round(guess.confidence * 100) / 100,
      runnerUp:
        guess.runnerUp === null || keySource === 'given'
          ? null
          : { tonic: tonicName(guess.runnerUp, null), mode: guess.runnerUp.mode },
    },
    tempo,
    meter,
    parts: score.parts.map((p) => ({
      name: p.name,
      notes: p.notes.length,
      role: roles.get(p) ?? 'unused',
    })),
    chordSource: useSymbols ? 'symbols' : chordPart !== null ? 'notes' : 'none',
    chords: counts,
    melody: { notes: notes.length },
    dropped: log.dropped,
    droppedMore: log.droppedMore,
    warnings: log.warnings,
  };
  return { song, report };
}

/** Import a Standard MIDI File. */
export function importMidi(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  return scoreToSong(readSmf(bytes), options);
}

/** Import an uncompressed MusicXML score (`score-partwise`). */
export function importMusicXml(text: string, options: ImportOptions = {}): ImportResult {
  return scoreToSong(readMusicXml(text), options);
}

const MIDI_EXTENSIONS = ['.mid', '.midi', '.smf', '.kar'];
const XML_EXTENSIONS = ['.musicxml', '.xml'];

/** True for file names the importer reads (.mid, .midi, .musicxml, .xml). */
export function isImportFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return [...MIDI_EXTENSIONS, ...XML_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

/** The file name without directory and extension (the fallback title). */
export function importTitle(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

/** UTF-8 (or UTF-16 with a byte-order mark) bytes as text, without TextDecoder. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    const little = bytes[0] === 0xff;
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const unit = little
        ? (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
        : ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
      out += String.fromCharCode(unit);
    }
    return out;
  }
  return decodeText(bytes);
}

/**
 * Import a file by its name (.mid/.midi → MIDI, .musicxml/.xml → MusicXML), else by its content.
 * The title falls back to the file name.
 */
export function importFile(
  name: string,
  bytes: Uint8Array,
  options: ImportOptions = {},
): ImportResult {
  const opts: ImportOptions = { title: importTitle(name) || 'Imported', ...options };
  const lower = name.toLowerCase();
  const isMidi =
    MIDI_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    (!XML_EXTENSIONS.some((ext) => lower.endsWith(ext)) &&
      bytes[0] === 0x4d &&
      bytes[1] === 0x54 &&
      bytes[2] === 0x68 &&
      bytes[3] === 0x64);
  if (lower.endsWith('.mxl')) {
    throw new ImportError(
      'compressed MusicXML (.mxl) is not supported; export uncompressed .musicxml',
    );
  }
  return isMidi ? importMidi(bytes, opts) : importMusicXml(decodeXmlBytes(bytes), opts);
}
