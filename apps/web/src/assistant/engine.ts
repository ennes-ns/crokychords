/**
 * The command engine (docs/specs/assistant-v1.md §A2–A3): one validated command applied to a
 * copy of the editor state, with no side effects. `window.croky` runs it twice per batch (a dry
 * run, then for real), the assistant panel runs it to show a proposal as a diff, and the
 * fixture tests run it against the terminal app's implementation.
 */
import type {
  Command,
  CommandErrorCode,
  CommandOf,
  Song,
  Track,
  TrackRole,
} from '@crokychords/core';
import {
  ImportError,
  MELODY_TRACK_ID,
  PATTERN_PRESETS,
  SongError,
  createSong,
  importFile,
  serializeSong,
  validateSong,
} from '@crokychords/core';
import {
  addTrack,
  removeTrack,
  setTrackPattern,
  songPatterns,
  songTracks,
  updateTrack,
} from '../band';
import type { TrackPatch } from '../band';
import { clampSelection, insertAfter, insertChordAt, removeChord, setChordBeats } from '../edit';
import type { LoopRange } from '../loop';
import { placeNote, removeNote, songMelody } from '../melody';
import { HISTORY_LIMIT } from '../state';

/** What the engine reads and writes: the song, the view state and the undo history. */
export interface EngineState {
  song: Song;
  selected: number | null;
  loop: boolean;
  loopRange: LoopRange | null;
  past: readonly Song[];
  future: readonly Song[];
}

/** Side effects the caller carries out after the state change (none in a dry run). */
export type Effect =
  | { type: 'play'; from?: number }
  | { type: 'stop' }
  | { type: 'audition'; token: string }
  | { type: 'setInstrument'; track: string; role: TrackRole | null; instrument: string }
  | { type: 'exportMidi' }
  | { type: 'save' };

/** What a command reports back (`window.croky`'s `results`). */
export interface CommandResult {
  op: Command['op'];
  /** Song edits and history: whether the song changed. */
  changed?: boolean;
  /** The chord or note a command created. */
  index?: number;
  /** The track a command created. */
  track?: string;
  [extra: string]: unknown;
}

export interface StepError {
  code: CommandErrorCode;
  path: string;
  message: string;
}

export type StepResult =
  | { ok: true; state: EngineState; result: CommandResult; effects: Effect[] }
  | { ok: false; error: StepError };

export interface EngineEnv {
  /** Whether `id` is an instrument this app knows (web: INSTRUMENT_IDS). */
  isInstrument(id: string): boolean;
  /** Random source for new track ids. */
  random?: () => number;
}

class Failure extends Error {
  readonly code: CommandErrorCode;
  readonly path: string;
  constructor(code: CommandErrorCode, path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

const notFound = (path: string, message: string) => new Failure('not_found', path, message);

function chordAt(song: Song, index: number, path = 'index'): void {
  if (song.chords[index] === undefined) {
    throw notFound(path, `there is no chord ${index} (the song has ${song.chords.length})`);
  }
}

/** The track `ref` points at (an id or an index). */
function resolveTrack(song: Song, ref: string | number): Track {
  const tracks = songTracks(song);
  const track = typeof ref === 'number' ? tracks[ref] : tracks.find((t) => t.id === ref);
  if (track === undefined) {
    throw notFound(
      'track',
      typeof ref === 'number'
        ? `there is no track ${ref} (the song has ${tracks.length})`
        : `no track with id "${ref}"`,
    );
  }
  return track;
}

function definedPatch(command: CommandOf<'setTrack'>): TrackPatch {
  const patch: TrackPatch = {};
  if (command.name !== undefined) patch.name = command.name;
  if (command.role !== undefined) patch.role = command.role;
  if (command.channel !== undefined) patch.channel = command.channel;
  if (command.octave !== undefined) patch.octave = command.octave;
  if (command.voicing !== undefined) patch.voicing = command.voicing;
  if (command.velocity !== undefined) patch.velocity = command.velocity;
  if (command.gate !== undefined) patch.gate = command.gate;
  if (command.muted !== undefined) patch.muted = command.muted;
  if (command.transpose !== undefined) patch.transpose = command.transpose;
  return patch;
}

interface Edit {
  song: Song;
  selected?: number | null;
  result?: Partial<CommandResult>;
  effects?: Effect[];
}

/** The bytes of base64 text, or a Failure on `path` when it is not base64. */
export function fromBase64(text: string, path = 'data'): Uint8Array {
  let binary: string;
  try {
    binary = atob(text.replace(/\s+/g, ''));
  } catch {
    throw new Failure('invalid', path, 'not valid base64');
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** `importFile`: the song from a MIDI/MusicXML file (docs/specs/import-v1.md §C). */
function importEdit(command: CommandOf<'importFile'>): Edit {
  const bytes = fromBase64(command.data);
  const key =
    command.tonic !== undefined && command.mode !== undefined
      ? { tonic: command.tonic, mode: command.mode }
      : undefined;
  try {
    const { song, report } = importFile(command.name, bytes, key === undefined ? {} : { key });
    return {
      song,
      selected: null,
      effects: [{ type: 'stop' }],
      result: {
        title: report.title,
        key: `${report.key.tonic} ${report.key.mode}`,
        chords: report.chords.total,
        notes: report.melody.notes,
        dropped: report.dropped.length + report.droppedMore,
        report,
      },
    };
  } catch (e) {
    if (e instanceof ImportError) throw new Failure('invalid', 'data', e.message);
    throw e;
  }
}

/** The song edits: a new song (and maybe a new selection). */
function editSong(state: EngineState, command: Command, env: EngineEnv): Edit | null {
  const { song, selected } = state;
  switch (command.op) {
    case 'appendChord': {
      const result =
        command.beats === undefined
          ? insertAfter(song, null, command.token)
          : insertChordAt(song, song.chords.length, command.token, command.beats);
      return { song: result.song, result: { index: song.chords.length } };
    }
    case 'insertChord': {
      if (command.at > song.chords.length) {
        throw notFound('at', `at must be 0..${song.chords.length}`);
      }
      const beats = command.beats ?? song.chords[command.at - 1]?.beats;
      const result = insertChordAt(song, command.at, command.token, beats);
      const shifted = selected !== null && selected >= command.at ? selected + 1 : selected;
      return { song: result.song, selected: shifted, result: { index: command.at } };
    }
    case 'replaceChord': {
      chordAt(song, command.index);
      const chords = [...song.chords];
      const old = chords[command.index];
      if (old === undefined) return null;
      chords[command.index] = { token: command.token, beats: command.beats ?? old.beats };
      return { song: { ...song, chords } };
    }
    case 'deleteChord': {
      chordAt(song, command.index);
      const result = removeChord(song, command.index);
      let next = selected;
      if (selected === command.index) next = result.selected;
      else if (selected !== null && selected > command.index) next = selected - 1;
      return { song: result.song, selected: next };
    }
    case 'setChordBeats':
      chordAt(song, command.index);
      return { song: setChordBeats(song, command.index, command.beats) };
    case 'setChords':
      return { song: { ...song, chords: command.chords.map((c) => ({ ...c })) } };
    case 'pick': {
      const at = selected !== null && song.chords[selected] !== undefined ? selected : null;
      if (at === null) return { song: insertAfter(song, null, command.token).song, selected: null };
      if (command.insert === true) {
        const result = insertAfter(song, at, command.token);
        return { song: result.song, selected: result.selected };
      }
      const chords = [...song.chords];
      const old = chords[at];
      if (old === undefined) return null;
      chords[at] = { ...old, token: command.token };
      return { song: { ...song, chords }, selected: at };
    }
    case 'setKey':
      return {
        song: {
          ...song,
          key: { tonic: command.tonic ?? song.key.tonic, mode: command.mode ?? song.key.mode },
        },
      };
    case 'setTempo':
      return { song: { ...song, tempo: command.bpm } };
    case 'setMeter':
      return { song: { ...song, meter: { beats: command.beats, unit: command.unit } } };
    case 'setTitle':
      return { song: { ...song, title: command.title } };
    case 'addNote': {
      const placed = placeNote(song, {
        beat: command.beat,
        length: command.length,
        degree: command.degree as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        octave: command.octave ?? 0,
        accidental: command.accidental ?? 0,
      });
      return { song: placed.song, result: { index: placed.index } };
    }
    case 'deleteNote': {
      const notes = songMelody(song).notes;
      if (notes[command.index] === undefined) {
        throw notFound(
          'index',
          `there is no note ${command.index} (the melody has ${notes.length})`,
        );
      }
      return { song: removeNote(song, command.index) };
    }
    case 'setNotes': {
      const notes = command.notes
        .map((n) => ({
          beat: n.beat,
          length: n.length,
          degree: n.degree as 1 | 2 | 3 | 4 | 5 | 6 | 7,
          octave: n.octave ?? 0,
          accidental: n.accidental ?? 0,
        }))
        .sort((a, b) => a.beat - b.beat);
      let end = 0;
      for (const n of notes) {
        if (n.beat < end) throw new Failure('invalid', 'notes', `notes overlap at beat ${n.beat}`);
        end = n.beat + n.length;
      }
      return { song: { ...song, melody: { ...songMelody(song), notes } } };
    }
    case 'setMelody': {
      const melody = songMelody(song);
      return {
        song: {
          ...song,
          melody: {
            ...melody,
            channel: command.channel ?? melody.channel,
            muted: command.muted ?? melody.muted,
          },
        },
      };
    }
    case 'addTrack': {
      const result = addTrack(song, command.role, env.random);
      return { song: result.song, result: { track: result.trackId } };
    }
    case 'removeTrack':
      return { song: removeTrack(song, resolveTrack(song, command.track).id) };
    case 'setTrack':
      return {
        song: updateTrack(song, resolveTrack(song, command.track).id, definedPatch(command)),
      };
    case 'setTrackPattern': {
      const track = resolveTrack(song, command.track);
      const known = [...PATTERN_PRESETS, ...songPatterns(song)].some(
        (p) => p.id === command.preset,
      );
      if (!known) throw notFound('preset', `no pattern preset "${command.preset}"`);
      return { song: setTrackPattern(song, track.id, command.preset) };
    }
    case 'newSong': {
      const melody = songMelody(song);
      const next = createSong({
        key: { ...song.key },
        tempo: song.tempo,
        meter: { ...song.meter },
        ...(song.tracks === undefined ? {} : { tracks: song.tracks }),
        melody: { ...melody, notes: [] },
        patterns: [...songPatterns(song)],
      });
      return { song: next, selected: null, effects: [{ type: 'stop' }] };
    }
    case 'importFile':
      return importEdit(command);
    default:
      return null;
  }
}

/** The song edit must leave a valid song (the commands' schemas make this nearly certain). */
function checkSong(song: Song): void {
  try {
    validateSong(JSON.parse(serializeSong(song)));
  } catch (e) {
    if (e instanceof SongError) {
      throw new Failure('invalid', '', `the song would be invalid: ${e.message}`);
    }
    throw e;
  }
}

/** Apply one (already validated) command to `state`. Never touches the store, audio or MIDI. */
export function step(state: EngineState, command: Command, env: EngineEnv): StepResult {
  try {
    return { ok: true, ...run(state, command, env) };
  } catch (e) {
    if (e instanceof Failure)
      return { ok: false, error: { code: e.code, path: e.path, message: e.message } };
    throw e;
  }
}

function run(
  state: EngineState,
  command: Command,
  env: EngineEnv,
): { state: EngineState; result: CommandResult; effects: Effect[] } {
  const op = command.op;
  const edit = editSong(state, command, env);
  if (edit !== null) {
    const changed = serializeSong(edit.song) !== serializeSong(state.song);
    if (changed) checkSong(edit.song);
    const song = changed ? edit.song : state.song;
    const selected = clampSelection(
      edit.selected === undefined ? state.selected : edit.selected,
      song.chords.length,
    );
    const past = changed ? [...state.past, state.song].slice(-HISTORY_LIMIT) : state.past;
    return {
      state: { ...state, song, selected, past, future: changed ? [] : state.future },
      result: { op, changed, ...edit.result },
      effects: edit.effects ?? [],
    };
  }
  switch (command.op) {
    case 'undo':
    case 'redo': {
      const from = command.op === 'undo' ? state.past : state.future;
      const song = from.at(-1);
      if (song === undefined) return { state, result: { op, changed: false }, effects: [] };
      const rest = from.slice(0, -1);
      const other = [...(command.op === 'undo' ? state.future : state.past), state.song];
      const selected = clampSelection(state.selected, song.chords.length);
      const next =
        command.op === 'undo'
          ? { ...state, song, selected, past: rest, future: other }
          : { ...state, song, selected, past: other, future: rest };
      return { state: next, result: { op, changed: true }, effects: [] };
    }
    case 'select':
      if (command.index !== null) chordAt(state.song, command.index);
      return { state: { ...state, selected: command.index }, result: { op }, effects: [] };
    case 'setLoop': {
      let { loop, loopRange } = state;
      if (command.range !== undefined) {
        loopRange = command.range === null ? null : { ...command.range };
        if (command.range !== null) loop = true;
      }
      if (command.enabled !== undefined) loop = command.enabled;
      return { state: { ...state, loop, loopRange }, result: { op }, effects: [] };
    }
    case 'setInstrument': {
      const melody = command.track === MELODY_TRACK_ID;
      const track = melody ? null : resolveTrack(state.song, command.track);
      if (!env.isInstrument(command.instrument)) {
        throw new Failure('invalid', 'instrument', `unknown instrument "${command.instrument}"`);
      }
      return {
        state,
        result: { op },
        effects: [
          {
            type: 'setInstrument',
            track: track?.id ?? MELODY_TRACK_ID,
            role: track?.role ?? null,
            instrument: command.instrument,
          },
        ],
      };
    }
    case 'play':
      if (state.song.chords.length === 0) throw new Failure('failed', '', 'nothing to play yet');
      return {
        state,
        result: { op },
        effects: [
          command.from === undefined ? { type: 'play' } : { type: 'play', from: command.from },
        ],
      };
    case 'stop':
      return { state, result: { op }, effects: [{ type: 'stop' }] };
    case 'audition':
      return { state, result: { op }, effects: [{ type: 'audition', token: command.token }] };
    case 'exportMidi':
      return { state, result: { op }, effects: [{ type: 'exportMidi' }] };
    case 'save':
      return { state, result: { op }, effects: [{ type: 'save' }] };
    default:
      throw new Failure('unsupported', 'op', `"${op}" is not supported here`);
  }
}
