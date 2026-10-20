/**
 * MusicXML (`score-partwise`, uncompressed) to the intermediate score (docs/specs/import-v1.md
 * §A2): notes per (part, staff) in sounding pitch, chord symbols from `<harmony>`, the first tempo,
 * meter and key.
 */
import type { Mode, PitchClass } from '../theory';
import { isMode, noteName, toPitchClass } from '../theory';
import type { ImportScore, KeyHint, ScoreHarmony, ScoreNote, ScorePart } from './score';
import { ImportError, MAX_IMPORT_NOTES, ReportLog } from './score';
import type { XmlElement } from './xml';
import { XmlError, child, childNumber, childText, children, parseXml } from './xml';

const STEP_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Chord-symbol kinds (MusicXML `<kind>`) as pitch-class intervals above the root. */
export const HARMONY_KINDS: Readonly<Record<string, readonly number[]>> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  augmented: [0, 4, 8],
  diminished: [0, 3, 6],
  dominant: [0, 4, 7, 10],
  'major-seventh': [0, 4, 7, 11],
  'minor-seventh': [0, 3, 7, 10],
  'diminished-seventh': [0, 3, 6, 9],
  'augmented-seventh': [0, 4, 8, 10],
  'half-diminished': [0, 3, 6, 10],
  'major-minor': [0, 3, 7, 11],
  'major-sixth': [0, 4, 7, 9],
  'minor-sixth': [0, 3, 7, 9],
  'dominant-ninth': [0, 4, 7, 10, 2],
  'major-ninth': [0, 4, 7, 11, 2],
  'minor-ninth': [0, 3, 7, 10, 2],
  'dominant-11th': [0, 4, 7, 10, 2, 5],
  'major-11th': [0, 4, 7, 11, 2, 5],
  'minor-11th': [0, 3, 7, 10, 2, 5],
  'dominant-13th': [0, 4, 7, 10, 2, 9],
  'major-13th': [0, 4, 7, 11, 2, 9],
  'minor-13th': [0, 3, 7, 10, 2, 9],
  'suspended-second': [0, 2, 7],
  'suspended-fourth': [0, 5, 7],
  power: [0, 7],
};

const XML_MODES: Readonly<Record<string, Mode>> = { ionian: 'major', aeolian: 'minor' };

function xmlMode(text: string | undefined): Mode | null {
  if (text === undefined) return null;
  const name = text.toLowerCase();
  const mapped = XML_MODES[name];
  if (mapped !== undefined) return mapped;
  return isMode(name) ? name : null;
}

function stepPitch(step: string | undefined, alter: number | undefined): PitchClass | null {
  const base = step === undefined ? undefined : STEP_PITCH[step.toUpperCase()];
  if (base === undefined) return null;
  return toPitchClass(base + Math.round(alter ?? 0));
}

/** Beats of a `<time>` signature's `beats` text such as '4' or '3+2'. */
function timeBeats(text: string | undefined): number | null {
  if (text === undefined) return null;
  const sum = text.split('+').reduce((acc, p) => acc + Number(p.trim()), 0);
  return Number.isInteger(sum) && sum > 0 ? sum : null;
}

const BEAT_UNITS: Readonly<Record<string, number>> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
};

interface OpenTie {
  note: ScoreNote;
}

interface PartState {
  name: string;
  /** Notes by staff number. */
  staves: Map<number, ScoreNote[]>;
}

/** Read a MusicXML document into the intermediate score. Throws ImportError when it is none. */
export function readMusicXml(source: string): ImportScore {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (e) {
    if (e instanceof XmlError) throw new ImportError(`not readable as XML: ${e.message}`);
    throw e;
  }
  if (root.name === 'score-timewise') {
    throw new ImportError('score-timewise MusicXML is not supported (save as partwise)');
  }
  if (root.name !== 'score-partwise') {
    throw new ImportError(`not a MusicXML score (the root element is <${root.name}>)`);
  }
  const log = new ReportLog();
  const names = new Map<string, string>();
  for (const sp of children(child(root, 'part-list'), 'score-part')) {
    const id = sp.attrs['id'];
    if (id !== undefined) names.set(id, childText(sp, 'part-name') ?? id);
  }
  const title = childText(root, 'work/work-title') || childText(root, 'movement-title') || null;

  const tempos: number[] = [];
  const meters: { beats: number; unit: number }[] = [];
  const keys: KeyHint[] = [];
  const harmonies: ScoreHarmony[] = [];
  let harmonyPart: string | null = null;
  let noteCount = 0;
  let degreesIgnored = false;
  const states: PartState[] = [];
  let length = 0;

  for (const [index, part] of children(root, 'part').entries()) {
    const id = part.attrs['id'] ?? `P${index + 1}`;
    const state: PartState = { name: names.get(id) ?? id, staves: new Map() };
    states.push(state);
    let divisions = 1;
    let transpose = 0;
    let measureStart = 0;
    const ties = new Map<string, OpenTie>();
    const partHarmonies: ScoreHarmony[] = [];
    for (const measure of children(part, 'measure')) {
      let t = measureStart;
      let maxT = measureStart;
      let lastStart = measureStart;
      const beatsOf = (el: XmlElement | undefined): number =>
        Math.max(0, (childNumber(el, 'duration') ?? 0) / divisions);
      const readSound = (el: XmlElement | undefined): void => {
        const tempo = Number(el?.attrs['tempo']);
        if (el?.attrs['tempo'] !== undefined && Number.isFinite(tempo) && tempo > 0) {
          tempos.push(tempo);
        }
      };
      for (const el of measure.children) {
        switch (el.name) {
          case 'attributes': {
            const d = childNumber(el, 'divisions');
            if (d !== undefined && d > 0) divisions = d;
            const key = child(el, 'key');
            const fifths = childNumber(key, 'fifths');
            if (fifths !== undefined && Number.isInteger(fifths) && Math.abs(fifths) <= 7) {
              const mode = xmlMode(childText(key, 'mode'));
              keys.push({ fifths, minor: mode !== null && mode !== 'major', mode });
            }
            const time = child(el, 'time');
            const beats = timeBeats(childText(time, 'beats'));
            const unit = childNumber(time, 'beat-type');
            if (beats !== null && unit !== undefined && [1, 2, 4, 8, 16, 32].includes(unit)) {
              meters.push({ beats, unit });
            }
            const tr = child(el, 'transpose');
            if (tr !== undefined) {
              transpose =
                Math.round(childNumber(tr, 'chromatic') ?? 0) +
                12 * Math.round(childNumber(tr, 'octave-change') ?? 0);
            }
            break;
          }
          case 'sound':
            readSound(el);
            break;
          case 'direction': {
            readSound(child(el, 'sound'));
            for (const dt of children(el, 'direction-type')) {
              const metronome = child(dt, 'metronome');
              const perMinute = childNumber(metronome, 'per-minute');
              if (metronome === undefined || perMinute === undefined || perMinute <= 0) continue;
              const unit = BEAT_UNITS[childText(metronome, 'beat-unit') ?? 'quarter'] ?? 1;
              const dotted = child(metronome, 'beat-unit-dot') !== undefined ? 1.5 : 1;
              tempos.push(perMinute * unit * dotted);
            }
            break;
          }
          case 'backup':
            t = Math.max(measureStart, t - beatsOf(el));
            break;
          case 'forward':
            t += beatsOf(el);
            maxT = Math.max(maxT, t);
            break;
          case 'harmony': {
            const h = readHarmony(el, t + (childNumber(el, 'offset') ?? 0) / divisions);
            if (h === 'unknown') log.drop('chord', t, 'chord symbol of an unknown kind');
            else if (h !== null) {
              partHarmonies.push(h.harmony);
              if (h.degrees) degreesIgnored = true;
            }
            break;
          }
          case 'note': {
            if (child(el, 'grace') !== undefined) {
              log.drop('note', t, 'grace note');
              break;
            }
            const isChord = child(el, 'chord') !== undefined;
            const start = isChord ? lastStart : t;
            const length = beatsOf(el);
            if (!isChord) {
              lastStart = t;
              t += length;
              maxT = Math.max(maxT, t);
            }
            if (child(el, 'rest') !== undefined || child(el, 'cue') !== undefined) break;
            const pitchEl = child(el, 'pitch');
            const pc = stepPitch(childText(pitchEl, 'step'), childNumber(pitchEl, 'alter'));
            const octave = childNumber(pitchEl, 'octave');
            if (pc === null || octave === undefined || length <= 0) break;
            const pitch = (Math.round(octave) + 1) * 12 + pc + transpose;
            if (pitch < 0 || pitch > 127) {
              log.drop('note', start, `note outside the MIDI range (${pitch})`);
              break;
            }
            const staff = Math.max(1, Math.round(childNumber(el, 'staff') ?? 1));
            const tieTypes = children(el, 'tie').map((tie) => tie.attrs['type']);
            const tieKey = `${staff}:${pitch}`;
            const open = ties.get(tieKey);
            if (tieTypes.includes('stop') && open !== undefined) {
              open.note.end = Math.max(open.note.end, start + length);
              if (!tieTypes.includes('start')) ties.delete(tieKey);
              break;
            }
            if (noteCount >= MAX_IMPORT_NOTES) break;
            noteCount++;
            const note: ScoreNote = { start, end: start + length, pitch, velocity: 80 };
            const list = state.staves.get(staff) ?? [];
            list.push(note);
            state.staves.set(staff, list);
            if (tieTypes.includes('start')) ties.set(tieKey, { note });
            break;
          }
          default:
            break;
        }
      }
      measureStart = Math.max(maxT, t);
    }
    length = Math.max(length, measureStart);
    if (partHarmonies.length > 0 && harmonyPart === null) {
      harmonyPart = state.name;
      harmonies.push(...partHarmonies);
    }
  }
  if (states.length === 0) throw new ImportError('the MusicXML score has no parts');
  if (noteCount >= MAX_IMPORT_NOTES) {
    log.warn(`Only the first ${MAX_IMPORT_NOTES.toLocaleString('en-US')} notes were read.`);
  }
  if (degreesIgnored) {
    log.warn('Added or altered chord-symbol degrees were ignored; the basic chord kind is used.');
  }
  const firstTempo = tempos[0] ?? null;
  if (tempos.some((t) => Math.abs(t - (firstTempo ?? t)) > 0.01)) {
    log.warn('The tempo changes during the score; the first tempo is used.');
  }
  const meter = meters[0] ?? null;
  if (meters.some((m) => m.beats !== meter?.beats || m.unit !== meter.unit)) {
    log.warn('The meter changes during the score; the first meter is used.');
  }
  const key = keys[0] ?? null;
  if (keys.some((k) => k.fifths !== key?.fifths || k.mode !== key.mode)) {
    log.warn('The key changes during the score; one key is used for the whole song.');
  }

  const parts: ScorePart[] = [];
  for (const state of states) {
    const staves = [...state.staves.keys()].sort((a, b) => a - b);
    if (staves.length === 0) parts.push({ name: state.name, notes: [], drums: false, end: null });
    for (const staff of staves) {
      const notes = (state.staves.get(staff) ?? []).sort(
        (a, b) => a.start - b.start || a.pitch - b.pitch,
      );
      const name = staves.length > 1 ? `${state.name} (staff ${staff})` : state.name;
      parts.push({ name, notes, drums: false, end: null });
    }
  }
  harmonies.sort((a, b) => a.start - b.start);
  return {
    format: 'musicxml',
    title,
    tempo: firstTempo,
    meter,
    key,
    parts,
    harmonies,
    length: length > 0 ? length : null,
    log,
  };
}

type HarmonyRead = { harmony: ScoreHarmony; degrees: boolean } | 'unknown' | null;

function readHarmony(el: XmlElement, start: number): HarmonyRead {
  const rootEl = child(el, 'root');
  const root = stepPitch(childText(rootEl, 'root-step'), childNumber(rootEl, 'root-alter'));
  const kindEl = child(el, 'kind');
  const kind = kindEl?.text.trim() ?? '';
  if (kind === 'none') return null;
  if (root === null) return 'unknown';
  const intervals = HARMONY_KINDS[kind];
  if (intervals === undefined) return 'unknown';
  const bassEl = child(el, 'bass');
  let bass = root;
  const bassPc = stepPitch(childText(bassEl, 'bass-step'), childNumber(bassEl, 'bass-alter'));
  if (bassPc !== null) {
    bass = bassPc;
  } else {
    const inversion = childNumber(el, 'inversion');
    const tone = inversion === undefined ? 0 : (intervals[Math.round(inversion)] ?? 0);
    bass = toPitchClass(root + tone);
  }
  const text = kindEl?.attrs['text'];
  const label = `${noteName(root)}${text ?? (kind === 'major' ? '' : ` ${kind}`)}`;
  return {
    harmony: { start, root, intervals: [...intervals], bass, label },
    degrees: children(el, 'degree').length > 0,
  };
}
