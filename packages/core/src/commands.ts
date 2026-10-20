/**
 * The command contract (docs/specs/assistant-v1.md §A1–A3): JSON commands that read and change a
 * song and drive playback, shared by the web app (`window.croky`), the Worker (the assistant's
 * answers) and, through the fixture `test/fixtures/commands-v1.json`, the terminal app.
 */
import { z } from 'zod';
import { MAX_MELODY_NOTES, MELODY_OCTAVE_MAX, MELODY_OCTAVE_MIN } from './melody';
import { MAX_METER_BEATS } from './progression';
import { MODES, parseNoteName } from './theory';
import { isRestToken, tryParseToken } from './token';
import { TRACK_ROLES } from './tracks';

/** Version of the contract (the fixture's `schema_version`, `window.croky.version`). */
export const COMMANDS_SCHEMA_VERSION = 1;

/** Most commands in one `applyCommands` call. */
export const MAX_COMMANDS = 256;
/** Most chords `setChords` may set. */
export const MAX_COMMAND_CHORDS = 1024;
/** Longest chord or note a command may give, in beats. */
export const MAX_COMMAND_BEATS = 64;
/** Latest beat a melody note may start on. */
export const MAX_NOTE_BEAT = 4096;
/** Tempo range of the editors (the song model allows more). */
export const COMMAND_TEMPO_MIN = 20;
export const COMMAND_TEMPO_MAX = 300;
export const COMMAND_METER_UNITS = [1, 2, 4, 8, 16, 32] as const;
export const MAX_TITLE_LENGTH = 200;
export const MAX_TRACK_NAME_LENGTH = 64;
/** Longest file name `importFile` takes. */
export const MAX_IMPORT_NAME_LENGTH = 255;
/** Longest base64 text `importFile` takes (about 3 MB of file). */
export const MAX_IMPORT_DATA_LENGTH = 4 * 1024 * 1024;

const quarter = (max: number) =>
  z
    .number()
    .positive()
    .max(max)
    .refine((n) => Number.isInteger(n * 4), 'must be a multiple of 0.25');

const token = z
  .string()
  .max(64)
  .refine((t) => isRestToken(t) || tryParseToken(t) !== undefined, {
    message: 'not a valid chord token (roman-numeral-v1) or "rest"',
  });

const index = z.int().min(0);
const beats = quarter(MAX_COMMAND_BEATS);
const trackRef = z.union([z.string().min(1).max(64), z.int().min(0)]);
const channel = z.int().min(0).max(15);

const note = z.strictObject({
  beat: z
    .number()
    .min(0)
    .max(MAX_NOTE_BEAT)
    .refine((n) => Number.isInteger(n * 4), 'must be a multiple of 0.25'),
  length: beats,
  degree: z.int().min(1).max(7),
  octave: z.int().min(MELODY_OCTAVE_MIN).max(MELODY_OCTAVE_MAX).optional(),
  accidental: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
});

const tonic = z
  .string()
  .max(3)
  .refine((t) => {
    try {
      parseNoteName(t);
      return true;
    } catch {
      return false;
    }
  }, 'not a note name (C, F#, Bb, ...)');

const loopRange = z
  .strictObject({ start: z.number().min(0), end: z.number().positive() })
  .refine((r) => r.end > r.start, { message: 'end must be after start', path: ['end'] });

const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.strictObject({ op: z.literal(name), ...shape });

/** One schema per op. */
export const COMMAND_SCHEMAS = {
  appendChord: op('appendChord', { token, beats: beats.optional() }),
  insertChord: op('insertChord', { at: index, token, beats: beats.optional() }),
  replaceChord: op('replaceChord', { index, token, beats: beats.optional() }),
  deleteChord: op('deleteChord', { index }),
  setChordBeats: op('setChordBeats', { index, beats }),
  setChords: op('setChords', {
    chords: z.array(z.strictObject({ token, beats })).max(MAX_COMMAND_CHORDS),
  }),
  pick: op('pick', { token, insert: z.boolean().optional() }),
  setKey: op('setKey', { tonic: tonic.optional(), mode: z.enum(MODES).optional() }).refine(
    (c) => c.tonic !== undefined || c.mode !== undefined,
    'give a tonic, a mode or both',
  ),
  setTempo: op('setTempo', { bpm: z.int().min(COMMAND_TEMPO_MIN).max(COMMAND_TEMPO_MAX) }),
  setMeter: op('setMeter', {
    beats: z.int().min(1).max(MAX_METER_BEATS),
    unit: z.literal(COMMAND_METER_UNITS),
  }),
  setTitle: op('setTitle', { title: z.string().max(MAX_TITLE_LENGTH) }),
  addNote: op('addNote', note.shape),
  deleteNote: op('deleteNote', { index }),
  setNotes: op('setNotes', { notes: z.array(note).max(MAX_MELODY_NOTES) }),
  setMelody: op('setMelody', { channel: channel.optional(), muted: z.boolean().optional() }),
  addTrack: op('addTrack', { role: z.enum(TRACK_ROLES) }),
  removeTrack: op('removeTrack', { track: trackRef }),
  setTrack: op('setTrack', {
    track: trackRef,
    name: z.string().min(1).max(MAX_TRACK_NAME_LENGTH).optional(),
    role: z.enum(TRACK_ROLES).optional(),
    channel: channel.optional(),
    octave: z.int().min(-1).max(9).optional(),
    voicing: z.enum(['close', 'root-only']).optional(),
    velocity: z.int().min(1).max(127).optional(),
    gate: z.number().positive().max(1).optional(),
    muted: z.boolean().optional(),
    transpose: z.int().min(-24).max(24).optional(),
  }),
  setTrackPattern: op('setTrackPattern', { track: trackRef, preset: z.string().min(1).max(64) }),
  newSong: op('newSong', {}),
  undo: op('undo', {}),
  redo: op('redo', {}),
  select: op('select', { index: index.nullable() }),
  setLoop: op('setLoop', {
    enabled: z.boolean().optional(),
    range: loopRange.nullable().optional(),
  }),
  setInstrument: op('setInstrument', {
    track: z.union([trackRef, z.literal('melody')]),
    instrument: z.string().min(1).max(64),
  }),
  play: op('play', { from: z.number().min(0).optional() }),
  stop: op('stop', {}),
  audition: op('audition', { token }),
  exportMidi: op('exportMidi', {}),
  save: op('save', {}),
  importFile: op('importFile', {
    name: z.string().min(1).max(MAX_IMPORT_NAME_LENGTH),
    data: z.string().min(1).max(MAX_IMPORT_DATA_LENGTH),
    tonic: tonic.optional(),
    mode: z.enum(MODES).optional(),
  }).refine((c) => (c.tonic === undefined) === (c.mode === undefined), {
    message: 'give both tonic and mode to choose the key, or neither to detect it',
    path: ['tonic'],
  }),
} as const;

export type CommandOp = keyof typeof COMMAND_SCHEMAS;
export type Command = {
  [K in CommandOp]: z.output<(typeof COMMAND_SCHEMAS)[K]>;
}[CommandOp];
export type CommandOf<K extends CommandOp> = Extract<Command, { op: K }>;
export type MelodyNoteInput = z.output<typeof note>;
export type TrackRef = z.output<typeof trackRef>;

/** Every op, in the order of the spec (and of the fixture's `ops`). */
export const COMMAND_OPS = Object.keys(COMMAND_SCHEMAS) as CommandOp[];

export function isCommandOp(value: unknown): value is CommandOp {
  return typeof value === 'string' && Object.hasOwn(COMMAND_SCHEMAS, value);
}

/** What a command touches: decides undo, the assistant's subset and the dry run. */
export type CommandKind = 'song' | 'history' | 'view' | 'sound' | 'transport' | 'file';

export interface CommandInfo {
  kind: CommandKind;
  /** One line for `commands()`, the docs and the assistant's prompt. */
  summary: string;
  example: Command;
}

export const COMMAND_INFO: { readonly [K in CommandOp]: CommandInfo & { example: CommandOf<K> } } =
  {
    appendChord: {
      kind: 'song',
      summary:
        'Add a chord at the end; length `beats`, else the previous chord’s, else 4 or the rest of the bar.',
      example: { op: 'appendChord', token: 'IV' },
    },
    insertChord: {
      kind: 'song',
      summary:
        'Insert a chord so it gets index `at` (0..length); default length: the chord before it.',
      example: { op: 'insertChord', at: 1, token: 'vi', beats: 2 },
    },
    replaceChord: {
      kind: 'song',
      summary: 'Replace the token of chord `index` (and its length when `beats` is given).',
      example: { op: 'replaceChord', index: 2, token: 'bVII' },
    },
    deleteChord: {
      kind: 'song',
      summary: 'Remove chord `index`.',
      example: { op: 'deleteChord', index: 0 },
    },
    setChordBeats: {
      kind: 'song',
      summary: 'Set the length of chord `index` in beats (multiple of 0.25).',
      example: { op: 'setChordBeats', index: 0, beats: 2 },
    },
    setChords: {
      kind: 'song',
      summary: 'Replace the whole progression.',
      example: {
        op: 'setChords',
        chords: [
          { token: 'I', beats: 4 },
          { token: 'V', beats: 4 },
        ],
      },
    },
    pick: {
      kind: 'song',
      summary:
        'Like a click on a Next chord suggestion: replace the selected chord, append on the "+" slot, or insert after the selection (`insert`).',
      example: { op: 'pick', token: 'V7' },
    },
    setKey: {
      kind: 'song',
      summary: 'Set the tonic (note name) and/or the mode.',
      example: { op: 'setKey', tonic: 'A', mode: 'minor' },
    },
    setTempo: {
      kind: 'song',
      summary: 'Set the tempo, 20–300 BPM.',
      example: { op: 'setTempo', bpm: 96 },
    },
    setMeter: {
      kind: 'song',
      summary: 'Set the meter (beats per bar 1–32, unit 1/2/4/8/16/32).',
      example: { op: 'setMeter', beats: 3, unit: 4 },
    },
    setTitle: {
      kind: 'song',
      summary: 'Set the song title.',
      example: { op: 'setTitle', title: 'Night drive' },
    },
    addNote: {
      kind: 'song',
      summary:
        'Place a melody note (scale degree 1–7, octave −3..3, accidental −1/0/1); the lane stays monophonic.',
      example: { op: 'addNote', beat: 0, length: 1, degree: 3 },
    },
    deleteNote: {
      kind: 'song',
      summary: 'Remove melody note `index`.',
      example: { op: 'deleteNote', index: 0 },
    },
    setNotes: {
      kind: 'song',
      summary: 'Replace the whole melody (notes must not overlap).',
      example: {
        op: 'setNotes',
        notes: [
          { beat: 0, length: 2, degree: 1 },
          { beat: 2, length: 2, degree: 5, octave: -1 },
        ],
      },
    },
    setMelody: {
      kind: 'song',
      summary: 'Set the melody lane’s MIDI channel (0–15) and/or mute it.',
      example: { op: 'setMelody', muted: false },
    },
    addTrack: {
      kind: 'song',
      summary: 'Add a band track with the role’s defaults on the next free channel.',
      example: { op: 'addTrack', role: 'pad' },
    },
    removeTrack: {
      kind: 'song',
      summary: 'Remove a track (id or index).',
      example: { op: 'removeTrack', track: 2 },
    },
    setTrack: {
      kind: 'song',
      summary:
        'Change a track: name, role, channel 0–15, octave −1..9, voicing, velocity 1–127, gate (0,1], muted, transpose ±24.',
      example: { op: 'setTrack', track: 1, octave: 2, muted: false },
    },
    setTrackPattern: {
      kind: 'song',
      summary:
        'Give a track a pattern preset (built-in id such as `bass-root-fifth`, or a song preset id).',
      example: { op: 'setTrackPattern', track: 1, preset: 'bass-root-fifth' },
    },
    newSong: {
      kind: 'song',
      summary: 'A new song with the same key, tempo, meter and band; no chords, no melody.',
      example: { op: 'newSong' },
    },
    undo: { kind: 'history', summary: 'Undo the last song edit.', example: { op: 'undo' } },
    redo: { kind: 'history', summary: 'Redo the last undone edit.', example: { op: 'redo' } },
    select: {
      kind: 'view',
      summary: 'Select chord `index`, or the "+" slot after the last chord (`null`).',
      example: { op: 'select', index: null },
    },
    setLoop: {
      kind: 'view',
      summary:
        'Turn looping on/off and/or set the loop range in beats (`null` clears it; a range turns looping on).',
      example: { op: 'setLoop', range: { start: 0, end: 8 } },
    },
    setInstrument: {
      kind: 'sound',
      summary:
        'Choose the browser instrument of a track or the melody (web only, not in the song).',
      example: { op: 'setInstrument', track: 'melody', instrument: 'lead' },
    },
    play: {
      kind: 'transport',
      summary: 'Play from beat `from` (default: the loop start when looping, else 0).',
      example: { op: 'play' },
    },
    stop: { kind: 'transport', summary: 'Stop playback.', example: { op: 'stop' } },
    audition: {
      kind: 'transport',
      summary: 'Sound one chord through the selected track.',
      example: { op: 'audition', token: 'ii7' },
    },
    exportMidi: {
      kind: 'file',
      summary: 'The song as a .mid file (result: fileName, bytes, base64).',
      example: { op: 'exportMidi' },
    },
    save: { kind: 'file', summary: 'Save pending edits now.', example: { op: 'save' } },
    importFile: {
      kind: 'file',
      summary:
        'Replace the song with a MIDI/MusicXML file (`data` in base64, `name` picks the format; `tonic` + `mode` set the key instead of detecting it). Result: the import report.',
      example: { op: 'importFile', name: 'song.mid', data: 'TVRoZAAAAAYAAAABAGA=' },
    },
  };

/** Ops the assistant may answer with: song edits that do not depend on the selection. */
export const ASSISTANT_OPS: readonly CommandOp[] = COMMAND_OPS.filter(
  (o) => COMMAND_INFO[o].kind === 'song' && o !== 'pick' && o !== 'newSong',
);

export type CommandErrorCode = 'invalid' | 'not_found' | 'unsupported' | 'failed';

export interface CommandError {
  code: CommandErrorCode;
  /** Position of the command in the batch. */
  index: number;
  op: string | null;
  /** Inside the command: 'beats', 'notes[2].degree'; '' for the whole command. */
  path: string;
  message: string;
}

export type ParseResult = { ok: true; commands: Command[] } | { ok: false; error: CommandError };

/** 'notes[2].degree' from a zod issue path. */
function issuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

function opOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o: unknown = Reflect.get(value, 'op');
  return typeof o === 'string' ? o : null;
}

/** Validate one command; `index` is its position in the batch (for the error). */
export function parseCommand(
  value: unknown,
  index = 0,
  allowed: readonly CommandOp[] = COMMAND_OPS,
): { ok: true; command: Command } | { ok: false; error: CommandError } {
  const fail = (path: string, message: string, op: string | null = opOf(value)) => ({
    ok: false as const,
    error: { code: 'invalid' as const, index, op, path, message },
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('', 'a command is a JSON object with an "op"');
  }
  const name = opOf(value);
  if (name === null) return fail('op', 'missing "op"');
  if (!isCommandOp(name)) return fail('op', `unknown op "${name}"`);
  if (!allowed.includes(name)) return fail('op', `"${name}" is not allowed here`);
  const result = COMMAND_SCHEMAS[name].safeParse(value);
  if (result.success) return { ok: true, command: result.data };
  const issue = result.error.issues[0];
  if (issue === undefined) return fail('', 'invalid command');
  if (issue.code === 'unrecognized_keys') {
    return fail(issue.keys[0] ?? '', `unknown field "${issue.keys.join('", "')}"`);
  }
  return fail(issuePath(issue.path), issue.message);
}

/** Validate one command or an array of at most MAX_COMMANDS; the first error wins. */
export function parseCommands(
  value: unknown,
  allowed: readonly CommandOp[] = COMMAND_OPS,
): ParseResult {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length > MAX_COMMANDS) {
    return {
      ok: false,
      error: {
        code: 'invalid',
        index: MAX_COMMANDS,
        op: null,
        path: '',
        message: `at most ${MAX_COMMANDS} commands per call`,
      },
    };
  }
  const commands: Command[] = [];
  for (const [i, item] of list.entries()) {
    const parsed = parseCommand(item, i, allowed);
    if (!parsed.ok) return parsed;
    commands.push(parsed.command);
  }
  return { ok: true, commands };
}

type JsonSchema = { [key: string]: unknown };

/** Keywords the structured-output API does not accept; they are checked by zod instead. */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'default',
  'format',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (typeof node !== 'object' || node === null) return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key === 'oneOf' ? 'anyOf' : key] = sanitize(value);
  }
  if (out['type'] === 'object') out['additionalProperties'] = false;
  return out;
}

/**
 * JSON schema of one command of `ops`, restricted to the keywords structured outputs accept
 * (numeric and length bounds are left to the zod check).
 */
export function commandJsonSchema(ops: readonly CommandOp[] = COMMAND_OPS): JsonSchema {
  const variants = ops.map((o) => sanitize(z.toJSONSchema(COMMAND_SCHEMAS[o], { io: 'input' })));
  return { anyOf: variants };
}

/** The assistant's answer: one sentence and the commands (docs/specs/assistant-v1.md §B3). */
export const MAX_ASSISTANT_COMMANDS = 64;
export const MAX_EXPLANATION_LENGTH = 500;

export interface AssistantReply {
  explanation: string;
  commands: Command[];
}

/** JSON schema of an assistant answer, for `output_config.format`. */
export function assistantReplyJsonSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      explanation: { type: 'string' },
      commands: { type: 'array', items: commandJsonSchema(ASSISTANT_OPS) },
    },
    required: ['explanation', 'commands'],
    additionalProperties: false,
  };
}

/** Check an assistant answer (already JSON-parsed). */
export function parseAssistantReply(
  value: unknown,
): { ok: true; reply: AssistantReply } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'the answer is not a JSON object' };
  }
  const explanation: unknown = Reflect.get(value, 'explanation');
  const commands: unknown = Reflect.get(value, 'commands');
  if (typeof explanation !== 'string' || explanation.trim() === '') {
    return { ok: false, message: 'the answer has no explanation' };
  }
  if (explanation.length > MAX_EXPLANATION_LENGTH) {
    return { ok: false, message: 'the explanation is too long' };
  }
  if (!Array.isArray(commands)) return { ok: false, message: 'the answer has no command list' };
  if (commands.length > MAX_ASSISTANT_COMMANDS) {
    return { ok: false, message: `more than ${MAX_ASSISTANT_COMMANDS} commands` };
  }
  const parsed = parseCommands(commands, ASSISTANT_OPS);
  if (!parsed.ok) {
    const { index, path, message } = parsed.error;
    return { ok: false, message: `command ${index}${path === '' ? '' : ` ${path}`}: ${message}` };
  }
  return { ok: true, reply: { explanation: explanation.trim(), commands: parsed.commands } };
}
