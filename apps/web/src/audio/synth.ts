/**
 * Web Audio poly synth for the built-in instruments (piano, pad, bass, lead) and the drum kit. The
 * current sound preset picks the instrument per track role; every track gets its own gain bus
 * into the master bus (mix → gentle compressor → master gain → limiter / soft clip / bypass →
 * volume); piano voices also send into a shared room. Graph construction lives in `graph.ts`
 * and `piano.ts` and works on an injected `SynthContext`. Instruments with a voice budget steal
 * their oldest voice when it is full.
 */
import type { TrackRole } from '@crokychords/core';
import type { MasterState } from '../persist';
import { MasterSettings, defaultMaster } from '../persist';
import type {
  BufferLike,
  GainLike,
  MasterBus,
  MasterMode,
  SourceLike,
  SynthContext,
  VoiceNodes,
} from './graph';
import {
  buildDrum,
  buildMasterBus,
  buildRoom,
  buildVoice,
  noiseBuffer,
  setMasterMode,
  setMasterVolume,
} from './graph';
import type { Drum, Instrument, InstrumentId, SoundPresetId } from './instruments';
import { DEFAULT_SOUND_PRESET, instrumentFor, leadFor } from './instruments';
import type { SoundStorage } from './sound';
import { SoundSettings } from './sound';
import { buildPianoVoice } from './piano';

export { midiToFrequency } from './instruments';
export { MASTER_GAIN, MIX_GAIN } from './graph';

/** Release time used by Stop (seconds). */
const STOP_RELEASE = 0.03;
/** Release time of a voice stolen to stay within an instrument's voice budget (seconds). */
export const STEAL_RELEASE = 0.02;
/** Bus id of the drum kit. */
export const DRUM_BUS = 'drums';

/** Sounding notes that can be released early. */
export interface NoteHandle {
  release(time?: number): void;
}

export interface NoteOptions {
  /** Track role; the current sound preset maps it to an instrument. Default 'chords'. */
  role?: TrackRole;
  /** Play this instrument instead of the preset's choice for the role. */
  instrument?: Instrument;
  /** MIDI velocity 1-127, default 96. */
  velocity?: number;
  /** Track id: the gain bus the note goes through (default 'default'). */
  track?: string;
}

interface Voice {
  sources: SourceLike[];
  gain: GainLike;
  start: number;
  /** Time the release starts. */
  end: number;
  release: number;
  track: string;
  /** Instrument of an instrument voice (absent for drums). */
  instrument?: InstrumentId;
}

export class Synth {
  readonly #ctx: SynthContext;
  readonly #master: MasterBus;
  readonly #preset: () => SoundPresetId;
  readonly #buses = new Map<string, GainLike>();
  #voices = new Set<Voice>();
  #noise: BufferLike | null = null;
  #room: GainLike | null = null;

  /**
   * `preset` is read on every note, so a preset change applies to the next note; `master` is
   * the initial master mode and volume (later changes through `setMasterMode`/`setMasterVolume`).
   */
  constructor(
    ctx: SynthContext,
    preset: () => SoundPresetId = () => DEFAULT_SOUND_PRESET,
    master: MasterState = defaultMaster(),
  ) {
    this.#ctx = ctx;
    this.#preset = preset;
    this.#master = buildMasterBus(ctx, master.mode, master.volume);
  }

  /** Current master protection mode. */
  get masterMode(): MasterMode {
    return this.#master.mode;
  }

  setMasterMode(mode: MasterMode): void {
    setMasterMode(this.#master, mode);
  }

  /** Master volume in percent (0–100, unity at 80). */
  setMasterVolume(percent: number): void {
    setMasterVolume(this.#master, percent, this.#ctx.currentTime);
  }

  /** Number of voices not yet finished (for tests and debugging). */
  get voiceCount(): number {
    this.#prune();
    return this.#voices.size;
  }

  /** The instrument a track of `role` plays with the current preset. */
  instrumentFor(role: TrackRole): Instrument {
    return instrumentFor(this.#preset(), role);
  }

  /** The instrument of the melody lane with the current preset. */
  leadInstrument(): Instrument {
    return leadFor(this.#preset());
  }

  /** Play one MIDI note from `time` (AudioContext seconds) for `duration` seconds. */
  playNote(note: number, time: number, duration: number, opts: NoteOptions = {}): NoteHandle {
    const voice = this.#voice(note, time, duration, opts);
    return { release: (at) => this.#release(voice, at ?? this.#ctx.currentTime) };
  }

  /** Several notes with the same timing (block chords). */
  playChord(
    notes: readonly number[],
    time: number,
    duration: number,
    opts: NoteOptions = {},
  ): NoteHandle {
    const handles = notes.map((n) => this.playNote(n, time, duration, opts));
    return { release: (at) => handles.forEach((h) => h.release(at)) };
  }

  /** One drum hit at `time`; `level` 0..1. */
  playDrum(drum: Drum, level: number, time: number): void {
    this.#prune();
    const start = Math.max(time, this.#ctx.currentTime);
    this.#noise ??= noiseBuffer(this.#ctx);
    const nodes = buildDrum(this.#ctx, drum, level, start, this.#noise, this.#bus(DRUM_BUS));
    // Drums stop on their own; `end` is when they are done, for pruning and Stop.
    this.#voices.add({ ...nodes, start, end: start + nodes.release, track: DRUM_BUS });
  }

  /** Silence one track now (muted or removed while playing). */
  stopTrack(track: string): void {
    const now = this.#ctx.currentTime;
    for (const voice of [...this.#voices]) {
      if (voice.track === track) this.#release(voice, now, STOP_RELEASE);
    }
  }

  /** Silence everything now (Stop). */
  stopAll(): void {
    const now = this.#ctx.currentTime;
    for (const voice of [...this.#voices]) this.#release(voice, now, STOP_RELEASE);
  }

  #bus(track: string): GainLike {
    let bus = this.#buses.get(track);
    if (bus === undefined) {
      bus = this.#ctx.createGain();
      bus.gain.value = 1;
      bus.connect(this.#master.input);
      this.#buses.set(track, bus);
    }
    return bus;
  }

  /** Forget voices whose release has finished. */
  #prune(): void {
    const now = this.#ctx.currentTime;
    for (const voice of this.#voices) {
      if (voice.end + voice.release * 2 < now) this.#voices.delete(voice);
    }
  }

  /** The shared room, built on first use. */
  #roomBus(): GainLike {
    this.#room ??= buildRoom(this.#ctx, this.#master.input);
    return this.#room;
  }

  /** Keep `instrument` under its voice budget at `start`: release the oldest voices early. */
  #steal(instrument: Instrument, start: number): void {
    const budget = instrument.voices;
    if (budget === undefined) return;
    const sounding = [...this.#voices]
      .filter((v) => v.instrument === instrument.id && v.end > start)
      .sort((a, b) => a.start - b.start);
    for (const voice of sounding.slice(0, Math.max(0, sounding.length - budget + 1))) {
      this.#release(voice, start, STEAL_RELEASE);
    }
  }

  #build(
    instrument: Instrument,
    note: number,
    velocity: number,
    start: number,
    out: GainLike,
  ): VoiceNodes {
    const spec = instrument.piano;
    if (spec === undefined) return buildVoice(this.#ctx, instrument, note, velocity, start, out);
    this.#noise ??= noiseBuffer(this.#ctx);
    const room = (instrument.room ?? 0) > 0 ? this.#roomBus() : null;
    return buildPianoVoice(this.#ctx, instrument, spec, note, velocity, start, out, {
      noise: this.#noise,
      room,
    });
  }

  #voice(note: number, time: number, duration: number, opts: NoteOptions): Voice {
    this.#prune();
    const instrument = opts.instrument ?? this.instrumentFor(opts.role ?? 'chords');
    const track = opts.track ?? 'default';
    const start = Math.max(time, this.#ctx.currentTime);
    this.#steal(instrument, start);
    const nodes = this.#build(instrument, note, opts.velocity ?? 96, start, this.#bus(track));
    const voice: Voice = { ...nodes, start, end: Infinity, track, instrument: instrument.id };
    this.#voices.add(voice);
    this.#release(voice, start + Math.max(duration, instrument.attack));
    return voice;
  }

  /** Start the release at `time`; only ever moves the release earlier. */
  #release(voice: Voice, time: number, release = voice.release): void {
    const at = Math.max(time, this.#ctx.currentTime);
    if (at >= voice.end) return;
    voice.end = at;
    const g = voice.gain.gain;
    g.cancelScheduledValues(at);
    let stopAt = at + release * 2;
    if (at <= voice.start) {
      // Released before it started (Stop during the lookahead window): never sound.
      g.setValueAtTime(0, at);
      stopAt = at;
    } else {
      g.setTargetAtTime(0, at, release / 4);
    }
    for (const source of voice.sources) {
      try {
        source.stop(stopAt);
      } catch {
        // Some engines reject a second stop(); the first one already ends the voice.
      }
    }
  }
}

/**
 * Owns the single AudioContext, created lazily on a user gesture (browsers keep a context
 * created without one suspended).
 */
export class AudioEngine {
  /** Sound preset and drum pattern; read live by the synth and the scheduler. */
  readonly sound: SoundSettings;
  /** Master mode and volume; applied live to the synth. */
  readonly master: MasterSettings;
  #ctx: AudioContext | null = null;
  #synth: Synth | null = null;

  /** `storage` keeps the sound settings across reloads (localStorage in the app). */
  constructor(storage: SoundStorage | null = null) {
    this.sound = new SoundSettings(storage);
    this.master = new MasterSettings(storage);
    this.master.subscribe((state) => {
      this.#synth?.setMasterMode(state.mode);
      this.#synth?.setMasterVolume(state.volume);
    });
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  get synth(): Synth | null {
    return this.#synth;
  }

  /** True once the context exists and is running. */
  get ready(): boolean {
    return this.#ctx !== null && this.#ctx.state === 'running';
  }

  /** Create or resume the context. Call from a user gesture (click, key press). */
  async start(): Promise<boolean> {
    if (typeof AudioContext === 'undefined') return false;
    if (this.#ctx === null) {
      this.#ctx = new AudioContext({ latencyHint: 'interactive' });
      this.#synth = new Synth(this.#ctx, () => this.sound.preset, this.master.state);
    }
    if (this.#ctx.state === 'suspended') {
      try {
        await this.#ctx.resume();
      } catch {
        return false;
      }
    }
    return this.ready;
  }

  /**
   * AudioContext time → DOMHighResTimeStamp (performance.now() clock), for Web MIDI. Without
   * a context the scheduler runs on performance.now() / 1000, so seconds map straight to ms.
   */
  toPerformanceTime(time: number): number {
    const ctx = this.#ctx;
    if (ctx === null) return time * 1000;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp?.contextTime !== undefined && stamp.performanceTime !== undefined) {
      return stamp.performanceTime + (time - stamp.contextTime) * 1000;
    }
    return performance.now() + (time - ctx.currentTime) * 1000;
  }
}
