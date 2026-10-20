import { describe, expect, it } from 'vitest';
import fixture from './fixtures/commands-v1.json';
import {
  ASSISTANT_OPS,
  COMMANDS_SCHEMA_VERSION,
  COMMAND_INFO,
  COMMAND_OPS,
  MAX_COMMANDS,
  assistantReplyJsonSchema,
  commandJsonSchema,
  parseAssistantReply,
  parseCommand,
  parseCommands,
} from '../src/commands';

/** Every key used anywhere in a JSON schema. */
function keywords(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keywords(n, out));
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'properties') out.add(key);
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        Object.values(value).forEach((v) => keywords(v, out));
      } else keywords(value, out);
    }
  }
  return out;
}

/** Every object schema in a JSON schema. */
function objects(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => objects(n, out));
  else if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (record['type'] === 'object') out.push(record);
    Object.values(record).forEach((v) => objects(v, out));
  }
  return out;
}

describe('the command contract', () => {
  it('matches the fixture: version, ops and the assistant subset', () => {
    expect(fixture.schema_version).toBe(COMMANDS_SCHEMA_VERSION);
    expect(COMMAND_OPS).toEqual(fixture.ops);
    expect(ASSISTANT_OPS).toEqual(fixture.assistant_ops);
  });

  it('every op has an example that passes its own schema', () => {
    for (const op of COMMAND_OPS) {
      const parsed = parseCommand(COMMAND_INFO[op].example);
      expect(parsed, op).toMatchObject({ ok: true, command: { op } });
      expect(COMMAND_INFO[op].summary.length).toBeGreaterThan(10);
    }
  });

  it.each([
    [{ op: 'appendChord', token: 'V7/vi' }],
    [{ op: 'appendChord', token: 'rest', beats: 0.25 }],
    [{ op: 'insertChord', at: 0, token: 'bVII', beats: 64 }],
    [{ op: 'setKey', tonic: 'F#', mode: 'phrygianDominant' }],
    [{ op: 'setMeter', beats: 7, unit: 8 }],
    [{ op: 'addNote', beat: 4095, length: 0.25, degree: 7, octave: -3, accidental: 1 }],
    [{ op: 'setTrack', track: 'trk-abc', gate: 1, transpose: -24 }],
    [{ op: 'setLoop', range: null }],
    [{ op: 'select', index: null }],
    [{ op: 'setInstrument', track: 'melody', instrument: 'lead' }],
    [{ op: 'play', from: 2.5 }],
  ])('accepts %j', (command) => {
    expect(parseCommand(command)).toMatchObject({ ok: true, command });
  });

  it.each([
    [null, ''],
    [[], ''],
    [{}, 'op'],
    [{ op: 5 }, 'op'],
    [{ op: 'transpose' }, 'op'],
    [{ op: 'appendChord' }, 'token'],
    [{ op: 'appendChord', token: 'I', beats: 0 }, 'beats'],
    [{ op: 'appendChord', token: 'I', beats: 65 }, 'beats'],
    [{ op: 'appendChord', token: 'I', beats: 1.1 }, 'beats'],
    [{ op: 'appendChord', token: 'Q' }, 'token'],
    [{ op: 'appendChord', token: 'I', extra: true }, 'extra'],
    [{ op: 'replaceChord', index: -1, token: 'I' }, 'index'],
    [{ op: 'replaceChord', index: 1.5, token: 'I' }, 'index'],
    [{ op: 'setKey', tonic: 'H' }, 'tonic'],
    [{ op: 'setKey', mode: 'ionian' }, 'mode'],
    [{ op: 'setKey' }, ''],
    [{ op: 'setTempo', bpm: 19 }, 'bpm'],
    [{ op: 'setTempo', bpm: 90.5 }, 'bpm'],
    [{ op: 'setMeter', beats: 33, unit: 4 }, 'beats'],
    [{ op: 'setMeter', beats: 4, unit: 3 }, 'unit'],
    [{ op: 'setTitle', title: 'x'.repeat(201) }, 'title'],
    [{ op: 'addNote', beat: 0, length: 1, degree: 8 }, 'degree'],
    [{ op: 'addNote', beat: 0, length: 1, degree: 1, octave: 4 }, 'octave'],
    [{ op: 'addNote', beat: 0, length: 1, degree: 1, accidental: 2 }, 'accidental'],
    [{ op: 'addNote', beat: 0.1, length: 1, degree: 1 }, 'beat'],
    [{ op: 'setNotes', notes: [{ beat: 0, length: 1, degree: 0 }] }, 'notes[0].degree'],
    [{ op: 'setChords', chords: [{ token: 'I', beats: 4 }, { token: 'I' }] }, 'chords[1].beats'],
    [{ op: 'setMelody', channel: 16 }, 'channel'],
    [{ op: 'addTrack', role: 'drums' }, 'role'],
    [{ op: 'setTrack', track: -1 }, 'track'],
    [{ op: 'setTrack', track: 0, gate: 0 }, 'gate'],
    [{ op: 'setTrack', track: 0, velocity: 128 }, 'velocity'],
    [{ op: 'setTrack', track: 0, voicing: 'open' }, 'voicing'],
    [{ op: 'setLoop', range: { start: 4, end: 4 } }, 'range.end'],
    [{ op: 'play', from: -1 }, 'from'],
  ])('refuses %j at path "%s"', (command, path) => {
    const parsed = parseCommand(command, 3);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({ code: 'invalid', index: 3, path });
    expect(parsed.error.message).not.toBe('');
  });

  it('parseCommands takes one command or a list and reports the first bad one', () => {
    expect(parseCommands({ op: 'undo' })).toEqual({ ok: true, commands: [{ op: 'undo' }] });
    expect(parseCommands([])).toEqual({ ok: true, commands: [] });
    const bad = parseCommands([{ op: 'undo' }, { op: 'redo' }, { op: 'setTempo' }]);
    expect(bad).toMatchObject({ ok: false, error: { index: 2, op: 'setTempo', path: 'bpm' } });
    const many = parseCommands(new Array(MAX_COMMANDS + 1).fill({ op: 'undo' }));
    expect(many).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('can restrict the ops (the assistant may not play or undo)', () => {
    const parsed = parseCommands([{ op: 'play' }], ASSISTANT_OPS);
    expect(parsed).toMatchObject({ ok: false, error: { path: 'op' } });
    expect(ASSISTANT_OPS).not.toContain('pick');
    expect(ASSISTANT_OPS).toContain('setChords');
  });
});

describe('JSON schemas for structured outputs', () => {
  const supported = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'anyOf',
    'allOf',
    'enum',
    'const',
    'description',
    '$ref',
    '$defs',
  ]);

  it('use only keywords the structured-output API accepts', () => {
    for (const schema of [commandJsonSchema(), assistantReplyJsonSchema()]) {
      for (const key of keywords(schema)) expect(supported, key).toContain(key);
      for (const object of objects(schema)) expect(object['additionalProperties']).toBe(false);
    }
  });

  it('has one variant per op, each pinning its op', () => {
    const schema = commandJsonSchema(ASSISTANT_OPS) as { anyOf: { properties: { op: unknown } }[] };
    expect(schema.anyOf).toHaveLength(ASSISTANT_OPS.length);
    expect(schema.anyOf.map((v) => v.properties.op)).toEqual(
      ASSISTANT_OPS.map((op) => ({ type: 'string', const: op })),
    );
  });
});

describe('parseAssistantReply', () => {
  it('accepts an explanation with commands, or a question answered without commands', () => {
    const reply = {
      explanation: ' Darker: the last two chords borrowed from minor. ',
      commands: [{ op: 'replaceChord', index: 2, token: 'bVI' }],
    };
    expect(parseAssistantReply(reply)).toEqual({
      ok: true,
      reply: {
        explanation: 'Darker: the last two chords borrowed from minor.',
        commands: reply.commands,
      },
    });
    expect(
      parseAssistantReply({ explanation: 'An axis progression.', commands: [] }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['text', 'not a JSON object'],
    [{ commands: [] }, 'no explanation'],
    [{ explanation: 'x'.repeat(501), commands: [] }, 'too long'],
    [{ explanation: 'ok' }, 'no command list'],
    [{ explanation: 'ok', commands: [{ op: 'play' }] }, 'command 0 op'],
    [{ explanation: 'ok', commands: [{ op: 'setTempo', bpm: 1 }] }, 'command 0 bpm'],
    [{ explanation: 'ok', commands: new Array(65).fill({ op: 'setTempo', bpm: 90 }) }, 'more than'],
  ])('refuses %j', (value, message) => {
    const parsed = parseAssistantReply(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});
