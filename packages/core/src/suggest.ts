import seedJson from './data/seed-ngrams.json';
import type { Mode } from './theory';
import { isMode } from './theory';

export interface NgramSource {
  name: string;
  description?: string;
  license?: string;
  exportedAt?: string;
}

export type NgramChordInfo = { count: number; songCount?: number } & Record<string, unknown>;

export interface NgramMode {
  sections: number;
  chords: Record<string, NgramChordInfo>;
  /** context ("" | "I" | "IV,I") -> next token -> count */
  ngrams: Record<string, Record<string, number>>;
}

export interface NgramTable {
  schema: 1;
  source: NgramSource;
  generatedAt: string;
  maxContext: number;
  tokenFormat: 'roman-numeral-v1';
  modes: Partial<Record<Mode, NgramMode>>;
}

/** Thrown by parseNgramTable; `path` points at the offending value, e.g. 'modes.major.ngrams.I'. */
export class NgramTableError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(path === '' ? reason : `${path}: ${reason}`);
    this.name = 'NgramTableError';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new NgramTableError(path, 'expected an object');
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new NgramTableError(path, 'expected a non-negative number');
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new NgramTableError(path, 'expected a string');
  return value;
}

function parseSource(value: unknown): NgramSource {
  const obj = record(value, 'source');
  const source: NgramSource = { name: string(obj['name'], 'source.name') };
  for (const field of ['description', 'license', 'exportedAt'] as const) {
    if (obj[field] !== undefined) source[field] = string(obj[field], `source.${field}`);
  }
  return source;
}

function parseMode(value: unknown, path: string): NgramMode {
  const obj = record(value, path);
  const sections = count(obj['sections'], `${path}.sections`);

  const chordsObj = record(obj['chords'], `${path}.chords`);
  const chords = Object.fromEntries(
    Object.entries(chordsObj).map(([token, raw]): [string, NgramChordInfo] => {
      const p = `${path}.chords.${token}`;
      const info = record(raw, p);
      const entry: NgramChordInfo = { ...info, count: count(info['count'], `${p}.count`) };
      if (info['songCount'] !== undefined) {
        entry.songCount = count(info['songCount'], `${p}.songCount`);
      }
      return [token, entry];
    }),
  );

  const ngramsObj = record(obj['ngrams'], `${path}.ngrams`);
  const ngrams = Object.fromEntries(
    Object.entries(ngramsObj).map(([context, raw]): [string, Record<string, number>] => {
      const p = `${path}.ngrams.${context === '' ? '""' : context}`;
      const row = record(raw, p);
      return [
        context,
        Object.fromEntries(
          Object.entries(row).map(([next, c]) => [next, count(c, `${p}.${next}`)]),
        ),
      ];
    }),
  );

  return { sections, chords, ngrams };
}

/** Validate an `ngrams.json` (schema v1) value, e.g. from `await response.json()`. */
export function parseNgramTable(value: unknown): NgramTable {
  const obj = record(value, '');
  if (obj['schema'] !== 1) throw new NgramTableError('schema', 'expected 1');
  if (obj['tokenFormat'] !== 'roman-numeral-v1') {
    throw new NgramTableError('tokenFormat', 'expected "roman-numeral-v1"');
  }
  const maxContext = count(obj['maxContext'], 'maxContext');
  if (!Number.isInteger(maxContext)) throw new NgramTableError('maxContext', 'expected an integer');

  const modesObj = record(obj['modes'], 'modes');
  const modes: Partial<Record<Mode, NgramMode>> = {};
  for (const [name, raw] of Object.entries(modesObj)) {
    if (!isMode(name)) throw new NgramTableError(`modes.${name}`, 'unknown mode');
    modes[name] = parseMode(raw, `modes.${name}`);
  }

  return {
    schema: 1,
    source: parseSource(obj['source']),
    generatedAt: string(obj['generatedAt'], 'generatedAt'),
    maxContext,
    tokenFormat: 'roman-numeral-v1',
    modes,
  };
}

export interface Suggestion {
  token: string;
  /** count / total of the whole context row (before filter and limit). */
  probability: number;
  count: number;
  /** The context tokens actually matched, e.g. ['IV', 'I']; [] for the unigram row. */
  contextUsed: string[];
}

export interface SuggestOptions {
  /** default: table.maxContext */
  maxContext?: number;
  /** default 20: back off if the matched context has fewer total observations */
  minContextCount?: number;
  /** default 12 */
  limit?: number;
  filter?: (token: string) => boolean;
}

export const DEFAULT_MIN_CONTEXT_COUNT = 20;
export const DEFAULT_SUGGESTION_LIMIT = 12;

function rowTotal(row: Record<string, number>): number {
  return Object.values(row).reduce((sum, c) => sum + c, 0);
}

function rankRow(
  row: Record<string, number>,
  contextUsed: string[],
  filter: ((token: string) => boolean) | undefined,
  limit: number,
): Suggestion[] {
  const total = rowTotal(row);
  if (total <= 0) return [];
  return Object.entries(row)
    .sort(([ta, ca], [tb, cb]) => cb - ca || (ta < tb ? -1 : ta > tb ? 1 : 0))
    .filter(([token]) => filter === undefined || filter(token))
    .slice(0, Math.max(0, limit))
    .map(([token, c]) => ({
      token,
      probability: c / total,
      count: c,
      contextUsed: [...contextUsed],
    }));
}

function lookup(mode: NgramMode, key: string): Record<string, number> | undefined {
  return Object.hasOwn(mode.ngrams, key) ? mode.ngrams[key] : undefined;
}

/**
 * Most likely next chords after `context` (rests already removed), with stupid backoff:
 * the longest context suffix (up to maxContext) whose row has >= minContextCount
 * observations is used. The unigram row is the last resort and is used whatever its total.
 */
export function suggestNext(
  table: NgramTable,
  mode: Mode,
  context: readonly string[],
  opts: SuggestOptions = {},
): Suggestion[] {
  const modeTable = table.modes[mode];
  if (modeTable === undefined) return [];
  const maxContext = Math.max(0, Math.floor(opts.maxContext ?? table.maxContext));
  const minCount = opts.minContextCount ?? DEFAULT_MIN_CONTEXT_COUNT;
  const limit = opts.limit ?? DEFAULT_SUGGESTION_LIMIT;

  const recent = maxContext === 0 ? [] : context.slice(-maxContext);
  for (let n = recent.length; n >= 0; n--) {
    const used = recent.slice(recent.length - n);
    const row = lookup(modeTable, used.join(','));
    if (row === undefined) continue;
    const total = rowTotal(row);
    if (total >= minCount || (n === 0 && total > 0)) {
      return rankRow(row, used, opts.filter, limit);
    }
  }
  return [];
}

/** The unigram row: the most common chords of the mode. */
export function popularChords(
  table: NgramTable,
  mode: Mode,
  limit = DEFAULT_SUGGESTION_LIMIT,
): Suggestion[] {
  const modeTable = table.modes[mode];
  const row = modeTable === undefined ? undefined : lookup(modeTable, '');
  return row === undefined ? [] : rankRow(row, [], undefined, limit);
}

/** Hand-seeded starter table (major and minor) so the app works without a data build. */
export const seedTable: NgramTable = parseNgramTable(seedJson);
