/**
 * Breakcore mode wiring (docs/specs/breakcore-v1.md): the settings in the store and their
 * persistence, loading the bundled or the user's own break, and the player the scheduler's synth
 * sink plays slices through.
 */
import type { BreakPlan } from './audio/scheduler';
import type { BreakEvent, BreakSpeed } from './audio/breaks';
import {
  DEFAULT_INTENSITY,
  clampIntensity,
  isBreakSpeed,
  nextIntensity,
  prepareBreak,
} from './audio/breaks';
import { BreakPlayer } from './audio/breakPlayer';
import type { NodeLike, SynthContext } from './audio/graph';
import type { SongStorage } from './persist';
import type { Store } from './state';
import type { SampleStore, StoredSample } from './store/samples';
import { BREAK_SAMPLE_ID, MAX_SAMPLE_BYTES, SAMPLE_SCHEMA_VERSION } from './store/samples';

/** The bundled CC0 break (docs/DATA.md, "Samples"). */
export const BUNDLED_BREAK_URL = '/samples/pseudoamen-141.flac';
export const BREAKCORE_KEY = 'crokychords.breakcore';
export const BREAKCORE_SCHEMA_VERSION = 1;

export type BreakSource = 'bundled' | 'own';
export type BreakStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BreakcoreState {
  enabled: boolean;
  /** 0–100. */
  intensity: number;
  speed: BreakSpeed;
  source: BreakSource;
  status: BreakStatus;
  /** Why the break could not be loaded (status 'error'). */
  error: string | null;
  /** File name of the stored own break, or null when there is none. */
  ownName: string | null;
}

export function defaultBreakcore(): BreakcoreState {
  return {
    enabled: false,
    intensity: DEFAULT_INTENSITY,
    speed: 1,
    source: 'bundled',
    status: 'idle',
    error: null,
    ownName: null,
  };
}

/** The persisted part of the settings. */
export type BreakcorePrefs = Pick<BreakcoreState, 'intensity' | 'speed' | 'source'>;

/** Parse saved settings; invalid fields fall back to the defaults one by one. */
export function parseBreakcorePrefs(json: string | null): BreakcorePrefs {
  const fallback = defaultBreakcore();
  const prefs: BreakcorePrefs = {
    intensity: fallback.intensity,
    speed: fallback.speed,
    source: fallback.source,
  };
  if (json === null) return prefs;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return prefs;
  }
  if (typeof raw !== 'object' || raw === null) return prefs;
  const intensity: unknown = Reflect.get(raw, 'intensity');
  const speed: unknown = Reflect.get(raw, 'speed');
  const source: unknown = Reflect.get(raw, 'source');
  if (typeof intensity === 'number' && Number.isFinite(intensity)) {
    prefs.intensity = clampIntensity(intensity);
  }
  if (isBreakSpeed(speed)) prefs.speed = speed;
  if (source === 'bundled' || source === 'own') prefs.source = source;
  return prefs;
}

export function loadBreakcorePrefs(storage: SongStorage | null): BreakcorePrefs {
  try {
    return parseBreakcorePrefs(storage?.getItem(BREAKCORE_KEY) ?? null);
  } catch {
    return parseBreakcorePrefs(null);
  }
}

export function saveBreakcorePrefs(storage: SongStorage | null, prefs: BreakcorePrefs): void {
  try {
    storage?.setItem(
      BREAKCORE_KEY,
      JSON.stringify({ schema_version: BREAKCORE_SCHEMA_VERSION, ...prefs }),
    );
  } catch {
    // Storage full or blocked: the settings still apply for this session.
  }
}

/** A decoded AudioBuffer as far as loading a break needs it. */
export interface DecodedAudio {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** An AudioContext as Breakcore needs it: the synth subset plus decoding. */
export interface BreakContext extends SynthContext {
  decodeAudioData(bytes: ArrayBuffer): Promise<DecodedAudio>;
}

/** The synth hooks Breakcore uses. */
export interface BreakSynth {
  breakBus(): NodeLike;
  setBreakGuard(on: boolean): void;
}

export interface BreakcoreDeps {
  store: Store;
  /** Create/resume the AudioContext; resolves to whether audio runs. */
  startAudio: () => Promise<boolean>;
  context: () => BreakContext | null;
  synth: () => BreakSynth | null;
  samples: SampleStore;
  /** Fetch a URL's bytes (the bundled break). */
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
  storage?: SongStorage | null;
  /** ISO timestamp for a new own break (tests pin it). */
  now?: () => string;
}

/** The bytes of a picked file (FileReader where Blob.arrayBuffer is missing). */
export function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('the file could not be read'));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsArrayBuffer(file);
  });
}

/** A short, user-facing reason for a failed load. */
function reason(e: unknown): string {
  if (e instanceof RangeError) return e.message;
  if (e instanceof Error && e.name === 'EncodingError') return 'the file could not be decoded';
  return e instanceof Error ? e.message : String(e);
}

export class BreakcoreController {
  readonly #deps: BreakcoreDeps;
  #player: BreakPlayer | null = null;
  #playerCtx: BreakContext | null = null;
  /** Prepared breaks by source key (`bundled`, `own:<saved_at>`). */
  readonly #cache = new Map<string, { mono: Float32Array; sampleRate: number }>();
  #ownKey: string | null = null;
  #loaded: string | null = null;
  #loading: Promise<void> | null = null;

  constructor(deps: BreakcoreDeps) {
    this.#deps = deps;
  }

  get state(): BreakcoreState {
    return this.#deps.store.state.breakcore;
  }

  /** Read whether an own break is stored (call once at start-up). */
  async init(): Promise<void> {
    let own: StoredSample | null = null;
    try {
      own = await this.#deps.samples.get(BREAK_SAMPLE_ID);
    } catch (e) {
      console.warn('Could not read the own break:', e);
    }
    this.#ownKey = own === null ? null : `own:${own.saved_at}`;
    const source = own === null ? 'bundled' : this.state.source;
    this.#set({ ownName: own?.name ?? null, source });
  }

  /** What the scheduler places, or null while Breakcore is off or no break is loaded. */
  plan(): BreakPlan | null {
    const { enabled, intensity, speed } = this.state;
    const native = this.#player?.nativeTempo ?? null;
    if (!enabled || native === null || this.#loaded !== this.#wanted()) return null;
    return { intensity, speed, nativeTempo: native };
  }

  play(event: BreakEvent, time: number, seconds: number): void {
    if (!this.state.enabled) return;
    this.#player?.play(event, time, seconds);
  }

  stopAll(): void {
    this.#player?.stopAll();
  }

  toggle(): void {
    this.setEnabled(!this.state.enabled);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    this.#set({ enabled });
    this.#deps.synth()?.setBreakGuard(enabled);
    if (enabled) void this.load();
    else this.stopAll();
  }

  setIntensity(intensity: number): void {
    this.#set({ intensity: clampIntensity(intensity) });
  }

  /** Shift+K: 25 → 50 → 75 → 100 → 25. */
  cycleIntensity(): void {
    this.setIntensity(nextIntensity(this.state.intensity));
  }

  setSpeed(speed: BreakSpeed): void {
    this.#set({ speed });
  }

  setSource(source: BreakSource): void {
    const next = source === 'own' && this.#ownKey === null ? 'bundled' : source;
    if (next === this.state.source) return;
    this.#set({ source: next });
    if (this.state.enabled) void this.load();
  }

  /**
   * "Use my own break": check and decode `file`, store it and switch to it. Rejects (and keeps the
   * current break) when the file is too large or does not decode to a usable break.
   */
  async useOwn(file: Blob & { name: string }): Promise<void> {
    if (file.size > MAX_SAMPLE_BYTES) {
      const mb = MAX_SAMPLE_BYTES / 1024 / 1024;
      this.#set({ status: 'error', error: `the file is larger than ${mb} MB` });
      throw new RangeError(`the file is larger than ${mb} MB`);
    }
    const bytes = await readBytes(file);
    const savedAt = (this.#deps.now ?? (() => new Date().toISOString()))();
    const key = `own:${savedAt}`;
    try {
      // Decode a copy: decodeAudioData detaches the buffer it is given.
      await this.#prepare(key, () => Promise.resolve(bytes.slice(0)));
    } catch (e) {
      this.#set({ status: 'error', error: reason(e) });
      throw e;
    }
    await this.#deps.samples.put({
      schema_version: SAMPLE_SCHEMA_VERSION,
      id: BREAK_SAMPLE_ID,
      name: file.name,
      type: file.type,
      bytes,
      saved_at: savedAt,
    });
    if (this.#ownKey !== null && this.#ownKey !== key) this.#cache.delete(this.#ownKey);
    this.#ownKey = key;
    this.#set({ ownName: file.name, source: 'own' });
    await this.load();
  }

  /** Delete the stored own break and go back to the bundled one. */
  async removeOwn(): Promise<void> {
    await this.#deps.samples.delete(BREAK_SAMPLE_ID);
    if (this.#ownKey !== null) this.#cache.delete(this.#ownKey);
    this.#ownKey = null;
    this.#set({ ownName: null, source: 'bundled' });
    if (this.state.enabled) await this.load();
  }

  /** Load the selected break into the player (when audio can run). */
  load(): Promise<void> {
    const run = async (): Promise<void> => {
      const key = this.#wanted();
      if (this.#current() !== null && key === this.#loaded) {
        this.#set({ status: 'ready', error: null });
        return;
      }
      this.#set({ status: 'loading', error: null });
      try {
        if (!(await this.#deps.startAudio())) throw new Error('audio is not available');
        const prepared = await this.#prepare(key, () => this.#bytes(key));
        const player = this.#current();
        if (player === null) throw new Error('audio is not available');
        player.load(prepared.mono, prepared.sampleRate);
        this.#loaded = key;
        // The wanted break may have changed while this one loaded: load again.
        if (key !== this.#wanted()) return run();
        this.#deps.synth()?.setBreakGuard(this.state.enabled);
        this.#set({ status: 'ready', error: null });
      } catch (e) {
        console.warn('Could not load the break:', e);
        this.#set({ status: 'error', error: reason(e) });
      }
    };
    this.#set({ status: 'loading', error: null });
    const previous = this.#loading ?? Promise.resolve();
    const next = previous.then(run);
    this.#loading = next;
    return next;
  }

  #wanted(): string {
    return this.state.source === 'own' && this.#ownKey !== null ? this.#ownKey : 'bundled';
  }

  /** The player on the current context and synth (rebuilt if the context changed). */
  #current(): BreakPlayer | null {
    const ctx = this.#deps.context();
    const synth = this.#deps.synth();
    if (ctx === null || synth === null) return null;
    if (this.#player === null || this.#playerCtx !== ctx) {
      this.#player = new BreakPlayer(ctx, () => synth.breakBus());
      this.#playerCtx = ctx;
      this.#loaded = null;
    }
    return this.#player;
  }

  async #bytes(key: string): Promise<ArrayBuffer> {
    if (key === 'bundled') return this.#deps.fetchBytes(BUNDLED_BREAK_URL);
    const own = await this.#deps.samples.get(BREAK_SAMPLE_ID);
    if (own === null) throw new Error('the own break is gone');
    return own.bytes.slice(0);
  }

  async #prepare(
    key: string,
    bytes: () => Promise<ArrayBuffer>,
  ): Promise<{ mono: Float32Array; sampleRate: number }> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    if (!(await this.#deps.startAudio())) throw new Error('audio is not available');
    const ctx = this.#deps.context();
    if (ctx === null) throw new Error('audio is not available');
    const decoded = await ctx.decodeAudioData(await bytes());
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    const prepared = {
      mono: prepareBreak(channels, decoded.sampleRate),
      sampleRate: decoded.sampleRate,
    };
    this.#cache.set(key, prepared);
    return prepared;
  }

  #set(patch: Partial<BreakcoreState>): void {
    const { store, storage } = this.#deps;
    const before = store.state.breakcore;
    const next = { ...before, ...patch };
    store.set({ breakcore: next });
    if (
      next.intensity !== before.intensity ||
      next.speed !== before.speed ||
      next.source !== before.source
    ) {
      saveBreakcorePrefs(storage ?? null, {
        intensity: next.intensity,
        speed: next.speed,
        source: next.source,
      });
    }
  }
}
