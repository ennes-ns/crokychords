/**
 * SoundFont instruments (docs/specs/soundfonts-v1.md): which shipped sample plays a note, where
 * the samples are served, the loader (`SoundfontBank`: fetch on demand through the Cache API,
 * decode once the AudioContext exists) and the sample voice. The catalogue itself (names,
 * programs, gains) is data in `instruments.ts`.
 */
import type { BufferLike, NodeLike, SynthContext, VoiceNodes } from './graph';
import { ROOM } from './graph';
import type { SoundfontId, SoundfontInstrument } from './instruments';
import { SOUNDFONTS } from './instruments';

/** The shipped note grid: every third semitone from A0 (tools/soundfonts/manifest.json `notes`). */
export const SAMPLE_GRID = { low: 21, high: 108, step: 3 } as const;
/** First 12 hex digits of the pinned source commit; part of every sample URL and the cache name. */
export const SOUNDFONT_VERSION = '044fab8e1456';
export const SOUNDFONT_CACHE_PREFIX = 'crokychords-soundfonts-';
export const SOUNDFONT_CACHE = `${SOUNDFONT_CACHE_PREFIX}${SOUNDFONT_VERSION}`;

/** Rise to the peak, so a sample never starts with a click (seconds). */
export const SAMPLE_ATTACK = 0.002;
/** Fade at the note end instead of a cut (seconds; time constant release / 4). */
export const SAMPLE_RELEASE = 0.05;
/** Send into the shared room, as a fraction of `ROOM.maxWet` (the samples carry some room). */
export const SAMPLE_ROOM = 0.4;
/** At most this many sample voices sound at once; the oldest is stolen. */
export const SAMPLE_VOICES = 32;

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** MIDI note → the file name the MIDI.js soundfonts use (60 → "C4", 70 → "Bb4"). */
export function sampleNoteName(note: number): string {
  return `${NOTE_NAMES[((note % 12) + 12) % 12] ?? 'C'}${Math.floor(note / 12) - 1}`;
}

/** The shipped notes of an instrument whose highest audible sample is `top`. */
export function sampleNotes(top: number): number[] {
  const notes: number[] = [];
  for (let n = SAMPLE_GRID.low; n <= Math.min(SAMPLE_GRID.high, top); n += SAMPLE_GRID.step) {
    notes.push(n);
  }
  return notes;
}

export interface SampleChoice {
  /** The sample's note. */
  sample: number;
  /** `playbackRate` that tunes the sample to the requested note. */
  rate: number;
}

/** The nearest sample to `note` (ties go to the lower one) and its playback rate. */
export function nearestSample(note: number, notes: readonly number[]): SampleChoice {
  let best = notes[0];
  if (best === undefined) throw new RangeError('no samples');
  for (const n of notes) {
    if (Math.abs(n - note) < Math.abs(best - note)) best = n;
  }
  return { sample: best, rate: 2 ** ((note - best) / 12) };
}

/** URL of one sample: `<base><id>/<Note>.ogg?v=<version>`. */
export function sampleUrl(base: string, id: string, note: number, version = SOUNDFONT_VERSION) {
  return `${base}${id}/${sampleNoteName(note)}.ogg?v=${version}`;
}

/** Linear gain of a sample note at `velocity` (1–127). */
export function sampleGain(instrument: SoundfontInstrument, velocity: number): number {
  return (instrument.gain * Math.min(127, Math.max(0, velocity))) / 127;
}

/** Upper bound of a sample note's amplitude: its gain times the loudest sample, plus the room. */
export function sampleAmplitude(instrument: SoundfontInstrument, velocity: number): number {
  return sampleGain(instrument, velocity) * instrument.peak * (1 + ROOM.maxWet * SAMPLE_ROOM);
}

// ---------------------------------------------------------------------------------------------
// Loading

/** A decoded sample (a real `AudioBuffer` satisfies it). */
export interface SampleBuffer extends BufferLike {
  readonly duration: number;
}

/** The decoded notes of one instrument. */
export interface SampleSet {
  notes: readonly number[];
  buffers: ReadonlyMap<number, SampleBuffer>;
}

export type SampleState = 'idle' | 'loading' | 'fetched' | 'ready' | 'error';

/** What the synth needs: the decoded set when ready, and a way to ask for it. */
export interface SampleSource {
  samples(id: SoundfontId): SampleSet | null;
  load(id: SoundfontId): void;
}

/** Loading states for the Band panel. */
export interface SampleStatus {
  state(id: SoundfontId): SampleState;
  load(id: SoundfontId): void;
  subscribe(listener: (id: SoundfontId, state: SampleState) => void): () => void;
}

export type SampleDecoder = (bytes: ArrayBuffer) => Promise<SampleBuffer>;
export type SampleFetch = (url: string) => Promise<Response>;

/** The parts of the Cache API the bank uses (`window.caches` satisfies it). */
export interface SampleCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}
export interface SampleCacheStorage {
  open(name: string): Promise<SampleCache>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface BankOptions {
  fetch: SampleFetch;
  /** The Cache API, or null without it (insecure origin, tests). */
  caches?: SampleCacheStorage | null;
  /** URL prefix of the sample folders (the app passes `<BASE_URL>soundfonts/`). */
  base?: string;
  /** Shipped notes per instrument (default: the catalogue's `top` on the shipped grid). */
  notes?: (id: SoundfontId) => readonly number[];
}

interface Entry {
  state: SampleState;
  bytes: Map<number, ArrayBuffer> | null;
  set: SampleSet | null;
}

function catalogueNotes(id: SoundfontId): readonly number[] {
  const top = SOUNDFONTS.find((s) => s.id === id)?.top ?? SAMPLE_GRID.high;
  return sampleNotes(top);
}

/**
 * Loads SoundFont instruments on demand: fetches every shipped note of an instrument (through
 * the Cache API when there is one), keeps the bytes until `attach` provides a decoder (the
 * AudioContext only exists after a user gesture), then keeps the decoded buffers.
 */
export class SoundfontBank implements SampleSource, SampleStatus {
  readonly #fetch: SampleFetch;
  readonly #caches: SampleCacheStorage | null;
  readonly #base: string;
  readonly #notes: (id: SoundfontId) => readonly number[];
  readonly #entries = new Map<SoundfontId, Entry>();
  readonly #listeners = new Set<(id: SoundfontId, state: SampleState) => void>();
  #decode: SampleDecoder | null = null;
  #cache: Promise<SampleCache | null> | null = null;

  constructor(options: BankOptions) {
    this.#fetch = options.fetch;
    this.#caches = options.caches ?? null;
    this.#base = options.base ?? 'soundfonts/';
    this.#notes = options.notes ?? catalogueNotes;
  }

  state(id: SoundfontId): SampleState {
    return this.#entries.get(id)?.state ?? 'idle';
  }

  samples(id: SoundfontId): SampleSet | null {
    return this.#entries.get(id)?.set ?? null;
  }

  subscribe(listener: (id: SoundfontId, state: SampleState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Start loading `id` unless it is loading or loaded; a failed load is retried. */
  load(id: SoundfontId): void {
    void this.ensure(id);
  }

  /** Load `id`; resolves when it is ready, fetched (no decoder yet) or failed. */
  async ensure(id: SoundfontId): Promise<SampleState> {
    const current = this.#entries.get(id);
    if (current !== undefined && current.state !== 'error') return this.#settled(id);
    const entry: Entry = { state: 'loading', bytes: null, set: null };
    this.#entries.set(id, entry);
    this.#emit(id, entry);
    // A retry replaces the entry; a stale attempt must not touch the new one.
    const stale = (): boolean => this.#entries.get(id) !== entry;
    try {
      const notes = this.#notes(id);
      const cache = await this.#openCache();
      const bytes = await Promise.all(
        notes.map((n) => this.#fetchNote(cache, sampleUrl(this.#base, id, n))),
      );
      if (stale()) return entry.state;
      entry.bytes = new Map(notes.map((n, i) => [n, bytes[i] ?? new ArrayBuffer(0)] as const));
      if (this.#decode === null) {
        entry.state = 'fetched';
        this.#emit(id, entry);
        return entry.state;
      }
      await this.#decodeEntry(id, entry, this.#decode);
    } catch {
      if (!stale()) {
        entry.state = 'error';
        entry.bytes = null;
        this.#emit(id, entry);
      }
    }
    return entry.state;
  }

  /** Provide the decoder (the AudioContext exists now) and decode what was fetched before. */
  attach(decode: SampleDecoder): Promise<void> {
    this.#decode = decode;
    const pending = [...this.#entries].filter(([, e]) => e.state === 'fetched');
    return Promise.all(pending.map(([id, e]) => this.#decodeEntry(id, e, decode))).then(
      () => undefined,
    );
  }

  /** Resolves once the current load of `id` has settled. */
  async #settled(id: SoundfontId): Promise<SampleState> {
    const busy = (): boolean => this.#entries.get(id)?.state === 'loading';
    if (!busy()) return this.state(id);
    await new Promise<void>((resolve) => {
      const stop = this.subscribe((changed) => {
        if (changed === id && !busy()) {
          stop();
          resolve();
        }
      });
    });
    return this.state(id);
  }

  async #decodeEntry(id: SoundfontId, entry: Entry, decode: SampleDecoder): Promise<void> {
    const bytes = entry.bytes;
    if (bytes === null) return;
    entry.state = 'loading';
    entry.bytes = null;
    this.#emit(id, entry);
    try {
      const decoded = await Promise.all(
        [...bytes].map(async ([n, data]) => [n, await decode(data)] as const),
      );
      entry.set = { notes: decoded.map(([n]) => n), buffers: new Map(decoded) };
      entry.state = 'ready';
    } catch {
      entry.state = 'error';
    }
    this.#emit(id, entry);
  }

  #openCache(): Promise<SampleCache | null> {
    const caches = this.#caches;
    if (caches === null) return Promise.resolve(null);
    this.#cache ??= (async () => {
      try {
        const cache = await caches.open(SOUNDFONT_CACHE);
        // Samples of an older source commit are never used again.
        for (const name of await caches.keys()) {
          if (name.startsWith(SOUNDFONT_CACHE_PREFIX) && name !== SOUNDFONT_CACHE) {
            await caches.delete(name);
          }
        }
        return cache;
      } catch {
        return null;
      }
    })();
    return this.#cache;
  }

  async #fetchNote(cache: SampleCache | null, url: string): Promise<ArrayBuffer> {
    const hit = await cache?.match(url).catch(() => undefined);
    if (hit !== undefined) return hit.arrayBuffer();
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    if (cache !== null) await cache.put(url, response.clone()).catch(() => undefined);
    return response.arrayBuffer();
  }

  #emit(id: SoundfontId, entry: Entry): void {
    for (const listener of [...this.#listeners]) listener(id, entry.state);
  }
}

// ---------------------------------------------------------------------------------------------
// Playback

export interface SampleVoice extends VoiceNodes {
  /** How long the sample lasts at its playback rate (seconds). */
  length: number;
}

/**
 * One sample note from `start`: buffer source (nearest sample, tuned by playbackRate) →
 * envelope gain (2 ms rise to the velocity gain, then the sample's own decay) → `out`, plus a
 * send into `room`. The caller schedules the release (a SAMPLE_RELEASE fade) and the stop.
 */
export function buildSampleVoice(
  ctx: SynthContext,
  instrument: SoundfontInstrument,
  set: SampleSet,
  note: number,
  velocity: number,
  start: number,
  out: NodeLike,
  room: NodeLike | null,
): SampleVoice {
  const { sample, rate } = nearestSample(note, set.notes);
  const buffer = set.buffers.get(sample) ?? null;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const gain = ctx.createGain();
  const g = gain.gain;
  g.value = 0;
  g.setValueAtTime(0, start);
  g.linearRampToValueAtTime(sampleGain(instrument, velocity), start + SAMPLE_ATTACK);
  source.connect(gain);
  gain.connect(out);
  if (room !== null) {
    const send = ctx.createGain();
    send.gain.value = ROOM.maxWet * SAMPLE_ROOM;
    gain.connect(send);
    send.connect(room);
  }
  source.start(start);
  const length = buffer === null ? 0 : buffer.duration / rate;
  return { gain, sources: [source], release: SAMPLE_RELEASE, length };
}
