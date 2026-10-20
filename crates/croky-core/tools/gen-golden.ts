// Generates the cross-language golden files for crates/croky-core from packages/core.
// Run through scripts/gen-rust-golden.sh (bundles this file with esbuild and runs it in Node).
import { readFileSync, writeFileSync } from 'node:fs';
import {
  chordName,
  parseNoteName,
  parseNgramTable,
  parseToken,
  suggestNext,
  voiceChord,
} from '../../../packages/core/src/index';
import type { Mode } from '../../../packages/core/src/index';

const root = new URL('../../../', import.meta.url);
const out = new URL('../tests/golden/', import.meta.url);

const fixture = JSON.parse(
  readFileSync(new URL('packages/core/test/fixtures/tokens-roman-v1.json', root), 'utf8'),
) as Record<Mode, string[]>;

const TONICS = ['C', 'G', 'Eb', 'F#', 'Bb', 'A', 'Db', 'E', 'Ab', 'D', 'B', 'F'];

// One line per token: the chord name and the default voicing in a rotating key.
const chordLines: string[] = [];
let i = 0;
for (const [mode, tokens] of Object.entries(fixture) as [Mode, string[]][]) {
  for (const token of tokens) {
    const tonicName = TONICS[i % TONICS.length] ?? 'C';
    i++;
    const key = { tonic: parseNoteName(tonicName), mode };
    const chord = parseToken(token);
    chordLines.push(
      JSON.stringify({
        mode,
        tonic: tonicName,
        token,
        name: chordName(chord, key),
        notes: voiceChord(chord, key),
      }),
    );
  }
}
writeFileSync(new URL('chords.jsonl', out), chordLines.join('\n') + '\n');

// Suggestions for a sample of contexts in the default table plus a few that need backoff.
const table = parseNgramTable(
  JSON.parse(readFileSync(new URL('apps/web/public/data/default.json', root), 'utf8')),
);
const suggestLines: string[] = [];
for (const mode of ['major', 'minor'] as const) {
  const rows = Object.keys(table.modes[mode]?.ngrams ?? {});
  const contexts: string[][] = rows
    .filter((_, n) => n % 60 === 0)
    .map((row) => (row === '' ? [] : row.split(',')));
  contexts.push(['I', 'V', 'vi', 'IV'], ['bII7', 'I'], ['nope'], ['i', 'nope', 'iv']);
  for (const context of contexts) {
    const suggestions = suggestNext(table, mode, context, { limit: 8 }).map((s) => ({
      token: s.token,
      count: s.count,
      probability: s.probability,
      contextUsed: s.contextUsed,
    }));
    suggestLines.push(JSON.stringify({ mode, context, suggestions }));
  }
}
writeFileSync(new URL('suggest.jsonl', out), suggestLines.join('\n') + '\n');
console.log(`wrote ${chordLines.length} chord lines, ${suggestLines.length} suggestion lines`);
