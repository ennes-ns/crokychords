import type { Accidental, Alteration, AppliedTarget, Chord, Extension, Quality } from './chords';
import { ALTERATIONS, isDiminishedExtension } from './chords';
import type { Degree } from './theory';

/** Thrown for a malformed token (parse) or a chord that has no token spelling (format). */
export class TokenError extends Error {
  readonly token: string;

  constructor(token: string, reason: string) {
    super(`Invalid chord token "${token}": ${reason}`);
    this.name = 'TokenError';
    this.token = token;
  }
}

export const REST_TOKEN = 'rest';

export function isRestToken(token: string): boolean {
  return token === REST_TOKEN;
}

const UPPER_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const;
const DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];

const PREFIXES: readonly (readonly [string, Accidental])[] = [
  ['bb', -2],
  ['b', -1],
  ['##', 2],
  ['#', 1],
];

/** Longest first so that 'maj13' wins over 'maj1...' and '13' over '1...'. */
const EXTENSION_SPELLINGS: readonly Exclude<Extension, 'none'>[] = [
  'maj13',
  'maj11',
  'maj9',
  'maj7',
  'ø13',
  'ø11',
  'ø9',
  'ø7',
  '°13',
  '°11',
  '°9',
  '°7',
  '13',
  '11',
  '9',
  '7',
];

const ADD_SPELLINGS: readonly (readonly [string, 6 | 9 | 11])[] = [
  ['add11', 11],
  ['add6', 6],
  ['add9', 9],
];

interface Numeral {
  degree: Degree;
  upper: boolean;
}

class Scanner {
  pos = 0;

  constructor(readonly input: string) {}

  get done(): boolean {
    return this.pos >= this.input.length;
  }

  peek(offset = 0): string {
    return this.input.charAt(this.pos + offset);
  }

  /** Consume `text` if the input continues with it. */
  eat(text: string): boolean {
    if (!this.input.startsWith(text, this.pos)) return false;
    this.pos += text.length;
    return true;
  }

  fail(reason: string): never {
    throw new TokenError(this.input, `${reason} at position ${this.pos}`);
  }

  prefix(): Accidental {
    for (const [text, acc] of PREFIXES) if (this.eat(text)) return acc;
    return 0;
  }

  numeral(): Numeral {
    let best: Numeral | undefined;
    let bestLength = 0;
    UPPER_NUMERALS.forEach((upperText, i) => {
      const degree = DEGREES[i];
      if (degree === undefined) return;
      for (const [text, upper] of [
        [upperText, true],
        [upperText.toLowerCase(), false],
      ] as const) {
        if (text.length > bestLength && this.input.startsWith(text, this.pos)) {
          best = { degree, upper };
          bestLength = text.length;
        }
      }
    });
    if (best === undefined) return this.fail('expected a Roman numeral');
    this.pos += bestLength;
    return best;
  }

  /** '+' after an uppercase numeral, '°' after a lowercase one (not '°7', that is an extension). */
  triadSign(numeral: Numeral): Quality {
    if (numeral.upper) return this.eat('+') ? 'aug' : 'major';
    if (this.peek() === '°' && !/[0-9]/.test(this.peek(1)) && this.eat('°')) return 'dim';
    return 'minor';
  }
}

/** Parse a Roman-numeral token (`roman-numeral-v1`). Throws TokenError, also for 'rest'. */
export function parseToken(token: string): Chord {
  const s = new Scanner(token);
  if (isRestToken(token)) s.fail('"rest" is not a chord');
  if (token === '') s.fail('empty token');

  const accidental = s.prefix();
  const numeral = s.numeral();
  let quality = s.triadSign(numeral);
  const signed = quality === 'dim' || quality === 'aug';

  let extension: Extension = 'none';
  for (const ext of EXTENSION_SPELLINGS) {
    if (s.eat(ext)) {
      extension = ext;
      break;
    }
  }
  if (isDiminishedExtension(extension)) {
    if (numeral.upper || signed) s.fail(`"${extension}" needs a bare lowercase numeral`);
    quality = 'dim';
  }

  const sus: (2 | 4)[] = [];
  while (s.eat('sus')) {
    const n = s.eat('2') ? 2 : s.eat('4') ? 4 : s.fail('expected sus2 or sus4');
    const last = sus[sus.length - 1];
    if (last !== undefined && n <= last) s.fail('sus must be ascending without repeats');
    sus.push(n);
  }

  const adds: (6 | 9 | 11)[] = [];
  while (s.peek() === 'a') {
    const found = ADD_SPELLINGS.find(([text]) => s.eat(text));
    if (found === undefined) return s.fail('expected add6, add9 or add11');
    const last = adds[adds.length - 1];
    if (last !== undefined && found[1] <= last) s.fail('adds must be ascending without repeats');
    adds.push(found[1]);
  }

  const alterations: Alteration[] = [];
  while (s.peek() === '(') {
    const found = ALTERATIONS.find((a) => s.eat(`(${a})`));
    if (found === undefined) return s.fail('expected (b5), (#5), (b9), (#9), (#11) or (b13)');
    const last = alterations[alterations.length - 1];
    if (last !== undefined && ALTERATIONS.indexOf(found) <= ALTERATIONS.indexOf(last)) {
      s.fail('alterations must be in canonical order without repeats');
    }
    alterations.push(found);
  }

  let applied: AppliedTarget | undefined;
  if (s.peek() === '/' && !/[0-9]/.test(s.peek(1))) {
    s.eat('/');
    const targetAccidental = s.prefix();
    const target = s.numeral();
    applied = { target: target.degree, targetAccidental, targetQuality: s.triadSign(target) };
  }

  let inversion: Chord['inversion'] = 0;
  if (s.eat('/')) {
    inversion = s.eat('1') ? 1 : s.eat('2') ? 2 : s.eat('3') ? 3 : s.fail('expected /1, /2 or /3');
  }
  if (!s.done) s.fail(`unexpected "${s.peek()}"`);

  const chord: Chord = {
    degree: numeral.degree,
    accidental,
    quality,
    extension,
    sus,
    adds,
    alterations,
    inversion,
  };
  if (applied !== undefined) chord.applied = applied;
  return chord;
}

/** Like parseToken, but returns undefined instead of throwing (also for 'rest'). */
export function tryParseToken(token: string): Chord | undefined {
  try {
    return parseToken(token);
  } catch (e) {
    if (e instanceof TokenError) return undefined;
    throw e;
  }
}

const PREFIX_TEXT: Record<Accidental, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };

function numeralText(degree: Degree, quality: Quality): string {
  const upper = UPPER_NUMERALS[degree - 1];
  if (upper === undefined) throw new RangeError(`Invalid degree: ${degree}`);
  return quality === 'major' || quality === 'aug' ? upper : upper.toLowerCase();
}

function triadText(degree: Degree, quality: Quality): string {
  const sign = quality === 'dim' ? '°' : quality === 'aug' ? '+' : '';
  return numeralText(degree, quality) + sign;
}

function describe(chord: Chord): string {
  return JSON.stringify(chord);
}

/** Format a chord as its canonical token. Throws TokenError if it has no token spelling. */
export function formatToken(chord: Chord): string {
  let token = PREFIX_TEXT[chord.accidental];
  const { degree, quality, extension } = chord;
  if (extension === 'none') {
    token += triadText(degree, quality);
  } else if (isDiminishedExtension(extension)) {
    // 'vii°7', 'viiø7': the extension carries the diminished sign.
    if (quality !== 'dim') throw new TokenError(describe(chord), `${extension} requires dim`);
    token += numeralText(degree, quality) + extension;
  } else {
    if (quality === 'dim' && !extension.startsWith('maj')) {
      // 'vii°7' would read back as a diminished seventh; use 'ø7'/'°7' instead.
      throw new TokenError(describe(chord), 'dim with a minor seventh has no token spelling');
    }
    token += triadText(degree, quality) + extension;
  }
  for (const n of [...new Set(chord.sus)].sort((a, b) => a - b)) token += `sus${n}`;
  for (const n of [...new Set(chord.adds)].sort((a, b) => a - b)) token += `add${n}`;
  for (const a of ALTERATIONS) if (chord.alterations.includes(a)) token += `(${a})`;
  if (chord.applied !== undefined) {
    const { target, targetAccidental, targetQuality } = chord.applied;
    token += `/${PREFIX_TEXT[targetAccidental]}${triadText(target, targetQuality)}`;
  }
  if (chord.inversion !== 0) token += `/${chord.inversion}`;
  return token;
}
