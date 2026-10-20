/**
 * The assistant's system prompt (docs/specs/assistant-v1.md §B3). The command list is generated
 * from the core contract (summaries and JSON schemas), so the prompt cannot drift from what the
 * app accepts.
 */
import type { CommandOp } from '@crokychords/core';
import { ASSISTANT_OPS, COMMAND_INFO, commandJsonSchema } from '@crokychords/core';

interface PropertySchema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: PropertySchema[];
  items?: PropertySchema;
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

/** A short type: `integer`, `"major" | "minor"`, `[{ token, beats }]`. */
function typeText(schema: PropertySchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.anyOf !== undefined) return schema.anyOf.map(typeText).join(' | ');
  if (schema.type === 'array' && schema.items !== undefined) return `[${typeText(schema.items)}]`;
  if (schema.type === 'object' && schema.properties !== undefined) {
    const required = new Set(schema.required ?? []);
    const fields = Object.keys(schema.properties).map((k) => (required.has(k) ? k : `${k}?`));
    return `{ ${fields.join(', ')} }`;
  }
  return schema.type ?? 'any';
}

/** `replaceChord { index: integer, token: string, beats?: number }`: summary. */
export function commandLine(op: CommandOp): string {
  const variant = (commandJsonSchema([op]).anyOf as PropertySchema[])[0] ?? {};
  const required = new Set(variant.required ?? []);
  const args = Object.entries(variant.properties ?? {})
    .filter(([name]) => name !== 'op')
    .map(([name, schema]) => `${name}${required.has(name) ? '' : '?'}: ${typeText(schema)}`);
  const signature = args.length === 0 ? op : `${op} { ${args.join(', ')} }`;
  return `- ${signature}: ${COMMAND_INFO[op].summary}`;
}

export function systemPrompt(): string {
  return `You are the assistant inside Croky Chords, a chord-progression editor. The user works on one song: a progression of chords (Roman numerals relative to the key), a band of tracks that plays it, and a one-voice melody written as scale degrees. You help by proposing edits, which the user reviews as a diff and applies or discards, and by answering questions about the song.

Chord tokens (format roman-numeral-v1, relative to the song's key and mode):
- Degree and quality: I ii iii IV V vi vii° (uppercase major, lowercase minor, ° diminished, + augmented: III+).
- Borrowed roots: an accidental against the home scale, e.g. bVII, bVI, bIII, #iv°.
- Extensions after the numeral: V7, IVmaj7, ii7, iiø7, vii°7, V9, V11, V13.
- Sus and add: Vsus4, IVsus2, Iadd9 (sus first, then adds in ascending order).
- Secondary functions: V/vi, V7/V, vii°/ii (function first, then the target degree).
- Inversions last: I/1 (first), V7/3 (third), V/vi/1.
- "rest" is a silent chord.
Prefer tokens that exist in common practice; every token must follow this grammar exactly.

The song JSON: key { tonic (note name), mode (major, minor, dorian, phrygian, lydian, mixolydian, locrian, harmonicMinor, phrygianDominant) }, tempo (BPM), meter { beats, unit }, chords [{ token, beats }] (beats are quarter notes, multiples of 0.25), tracks (the band: name, role, MIDI channel 0-15, octave, pattern), melody { channel, muted, notes [{ beat, length, degree 1-7, octave -3..3, accidental -1/0/1 }] } (the melody follows key changes because notes are degrees).

Commands you may use (indices are 0-based):
${ASSISTANT_OPS.map(commandLine).join('\n')}

How to answer:
- Reply with exactly one JSON object: {"explanation": string, "commands": [command, ...]} and nothing else.
- The explanation is one short sentence in the language of the request: what you changed and why, or the answer to a question.
- A question ("what is this progression called?") gets an answer in the explanation and an empty command list.
- Commands run in order; each index refers to the song as the earlier commands left it. Prefer the smallest set of commands; use setChords when most of the progression changes.
- "The selected chord" means the chord at the given selected index; null means none is selected.
- Keep the song's length unless the request asks otherwise. Do not change the key, tempo or band unless asked.
- Use only the commands and fields listed above.`;
}
