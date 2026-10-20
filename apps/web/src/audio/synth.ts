/**
 * Web Audio poly synth for the built-in instruments (piano, pad, bass, lead), the SoundFont
 * instruments and the drum kit. The sound settings pick the instrument per track (the preset's
 * choice for its role unless the track has its own); a SoundFont instrument plays its synth
 * stand-in until its samples are loaded. Every track gets its own gain bus into the master bus
 * (mix → gentle compressor → master gain → limiter / soft clip / bypass → volume); piano and
 * sample voices also send into a shared room. Graph construction lives in `graph.ts`,
 * `piano.ts` and `soundfont.ts` and works on an injected `SynthContext`. Instruments with a
 * voice budget, and the sample voices together, steal their oldest voice when full.
 */
import type { TrackRole } from '@crokychords/core';
import { MELODY_TRACK_ID, TRACK_ROLES } from '@crokychords/core';
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
  buildBreakBus,
  buildDrum,
  buildMasterBus,
  buildRoom,
  buildVoice,
  guardedMasterMode,
  noiseBuffer,
  setMasterMode,
  setMasterVolume,
} from './graph';
import { IdleSuspender } from './idle';
import type {
  Drum,
  Instrument,
  InstrumentId,
  SoundPresetId,
  SoundfontId,
  SoundfontInstrument,
  SynthId,
} from './instruments';
import {
  DEFAULT_SOUND_PRESET,
  instrumentFor,
  presetChoice,
  presetInstrument,
  soundfont,
} from './instruments';
import type { SoundStorage, TrackVoice } from './sound';
import { SoundSettings } from './sound';
import type { SampleCacheStorage, SampleFetch, SampleSet, SampleSource } from './soundfont';
import {
  SAMPLE_ATTACK,
  SAMPLE_VOICES,
  SoundfontBank,
  buildSampleVoice,
  sampleGain,
} from './soundfont';
import { buildPianoVoice } from './piano';

export { midiToFrequency } from './instruments';
export { MASTER_GAIN, MIX_GAIN } from './graph';

/** Release time used by Stop (seconds). */
const STOP_RELEASE = 0.03;
/** Release time of a voice stolen to stay within an instrument's voice budget (seconds). */
export const STEAL_RELEASE = 0.02;
/**
 * A released voice stops `release × RELEASE_TAIL` after its release starts. The release falls
 * with τ = release / 4, so by then it is 4.8 τ down (about −42 dB): inaudible, and much shorter
 * than running the oscillators on for twice the release (issue #82).
 */
export const RELEASE_TAIL = 1.2;
/** Bus id of the drum kit. */
export const DRUM_BUS = 'drums';

/** Sounding notes that can be released early. */
export interface NoteHandle {
  release(time?: number): void;
}

export interface NoteOptions {
  /** Track role; with the track id it picks the instrument. Default 'chords'. */
  role?: TrackRole;
  /** Play this synth instrument instead of the track's choice. */
  instrument?: Instrument;
  /** MIDI velocity 1-127, default 96. */
  velocity?: number;
  /** Track id: the gain bus the note goes through (default 'default'); 'melody' is the lane. */
  track?: string;
}

export interface SynthOptions {
  /** What plays a track (`role` null for the melody); default: the preset's choice. */
  voice?: (track: string, role: TrackRole | null) => TrackVoice;
  /** Decoded SoundFont samples; without them SoundFont instruments play their stand-ins. */
  samples?: SampleSource | null;
}

interface Voice {
  sources: SourceLike[];
  gain: GainLike;
  start: number;
  /** Time the release starts. */
  end: number;
  release: number;
  track: string;
  /** Instrument of a synth voice (absent for drums and samples). */
  instrument?: SynthId;
  /** True for a SoundFont sample voice (they share one voice budget). */
  sample?: boolean;
  /** Level held after the attack (sample voices): the release fades from it. */
  hold?: number;
}

export class Synth {
  readonly #ctx: SynthContext;
  readonly #master: MasterBus;
  readonly #preset: () => SoundPresetId;
  readonly #resolve: (track: string, role: TrackRole | null) => TrackVoice;
  readonly #samples: SampleSource | null;
  readonly #buses = new Map<string, GainLike>();
  #voices = new Set<Voice>();
  #noise: BufferLike | null = null;
  #room: GainLike | null = null;
  /** Breakcore (docs/specs/breakcore-v1.md): its bus, and the user's mode under the guard. */
  #breakBus: GainLike | null = null;
  #breakGuard = false;
  #userMode: MasterMode;

  /**
   * `preset` and `options.voice` are read on every note, so a change applies to the next note;
   * `master` is the initial master mode and volume (later changes through
   * `setMasterMode`/`setMasterVolume`).
   */
  constructor(
    ctx: SynthContext,
    preset: () => SoundPresetId = () => DEFAULT_SOUND_PRESET,
    master: MasterState = defaultMaster(),
    options: SynthOptions = {},
  ) {
    this.#ctx = ctx;
    this.#preset = preset;
    this.#resolve =
      options.voice ??
      ((_track, role) => ({ instrument: presetChoice(this.#preset(), role), transpose: 0 }));
    this.#samples = options.samples ?? null;
    this.#master = buildMasterBus(ctx, master.mode, master.volume);
    this.#userMode = master.mode;
  }

  /** Current master protection mode. */
  get masterMode(): MasterMode {
    return this.#master.mode;
  }

  setMasterMode(mode: MasterMode): void {
    this.#userMode = mode;
    setMasterMode(this.#master, guardedMasterMode(mode, this.#breakGuard));
  }

  /** The Breakcore bus into the master gain (built on first use). */
  breakBus(): GainLike {
    this.#breakBus ??= buildBreakBus(this.#ctx, this.#master);
    return this.#breakBus;
  }

  /** While Breakcore is on, the master protection is at least the limiter. */
  setBreakGuard(on: boolean): void {
    this.#breakGuard = on;
    this.setMasterMode(this.#userMode);
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

  /** The synth recipe a track of `role` plays (or stands in with) under the current preset. */
  instrumentFor(role: TrackRole): Instrument {
    return instrumentFor(this.#preset(), role);
  }

  /** The synth recipe of the melody lane's instrument (its stand-in for a SoundFont). */
  leadInstrument(): Instrument {
    return presetInstrument(this.#preset(), this.#resolve(MELODY_TRACK_ID, null).instrument);
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
      if (voice.end + voice.release * RELEASE_TAIL < now) this.#voices.delete(voice);
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
    const track = opts.track ?? 'default';
    const start = Math.max(time, this.#ctx.currentTime);
    const explicit = opts.instrument;
    if (explicit !== undefined) {
      return this.#synthVoice(explicit, note, opts.velocity ?? 96, start, duration, track);
    }
    const role = track === MELODY_TRACK_ID ? null : (opts.role ?? 'chords');
    const choice = this.#resolve(track, role);
    const pitch = Math.min(127, Math.max(0, note + choice.transpose));
    const velocity = choice.velocity ?? opts.velocity ?? 96;
    const font = soundfont(choice.instrument);
    if (font !== undefined) {
      const set = this.#samples?.samples(font.id) ?? null;
      if (set !== null)
        return this.#sampleVoice(font, set, pitch, velocity, start, duration, track);
      // Not loaded yet: ask for it and play the stand-in meanwhile.
      this.#samples?.load(font.id);
    }
    const instrument = presetInstrument(this.#preset(), choice.instrument);
    return this.#synthVoice(instrument, pitch, velocity, start, duration, track);
  }

  #synthVoice(
    instrument: Instrument,
    note: number,
    velocity: number,
    start: number,
    duration: number,
    track: string,
  ): Voice {
    this.#steal(instrument, start);
    const nodes = this.#build(instrument, note, velocity, start, this.#bus(track));
    const voice: Voice = { ...nodes, start, end: Infinity, track, instrument: instrument.id };
    this.#voices.add(voice);
    this.#release(voice, start + Math.max(duration, instrument.attack));
    return voice;
  }

  #sampleVoice(
    font: SoundfontInstrument,
    set: SampleSet,
    note: number,
    velocity: number,
    start: number,
    duration: number,
    track: string,
  ): Voice {
    this.#stealSamples(start);
    const out = this.#bus(track);
    const nodes = buildSampleVoice(
      this.#ctx,
      font,
      set,
      note,
      velocity,
      start,
      out,
      this.#roomBus(),
    );
    const { gain, sources, release } = nodes;
    const hold = sampleGain(font, velocity);
    const voice: Voice = {
      gain,
      sources,
      release,
      start,
      end: Infinity,
      track,
      sample: true,
      hold,
    };
    this.#voices.add(voice);
    this.#release(voice, start + Math.max(duration, SAMPLE_ATTACK));
    // A sample shorter than the note ends on its own.
    voice.end = Math.min(voice.end, start + nodes.length);
    return voice;
  }

  /** Keep the sample voices under SAMPLE_VOICES at `start`: release the oldest early. */
  #stealSamples(start: number): void {
    const sounding = [...this.#voices]
      .filter((v) => v.sample === true && v.end > start)
      .sort((a, b) => a.start - b.start);
    for (const voice of sounding.slice(0, Math.max(0, sounding.length - SAMPLE_VOICES + 1))) {
      this.#release(voice, start, STEAL_RELEASE);
    }
  }

  /** Start the release at `time`; only ever moves the release earlier. */
  #release(voice: Voice, time: number, release = voice.release): void {
    const at = Math.max(time, this.#ctx.currentTime);
    if (at >= voice.end) return;
    voice.end = at;
    const g = voice.gain.gain;
    g.cancelScheduledValues(at);
    let stopAt = at + release * RELEASE_TAIL;
    if (at <= voice.start) {
      // Released before it started (Stop during the lookahead window): never sound.
      g.setValueAtTime(0, at);
      stopAt = at;
    } else {
      // Anchor the fade at the held level (some engines mis-handle a target after a ramp).
      if (voice.hold !== undefined) g.setValueAtTime(voice.hold, at);
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

export interface EngineOptions {
  /** How samples are fetched (default: the global `fetch`). */
  fetch?: SampleFetch;
  /** The Cache API (default: `window.caches` when it exists). */
  caches?: SampleCacheStorage | null;
  /** URL prefix of the sample folders (default 'soundfonts/'). */
  base?: string;
}

/** SoundFont instruments a sound state may play: the preset's choices and every own choice. */
function soundfontsInUse(sound: SoundSettings): Set<SoundfontId> {
  const { state } = sound;
  const ids: InstrumentId[] = [
    ...Object.values(soundPresetInstruments(state.preset)),
    ...Object.values(state.instruments),
  ];
  return new Set(ids.flatMap((id) => soundfont(id)?.id ?? []));
}

function soundPresetInstruments(preset: SoundPresetId): InstrumentId[] {
  return [...TRACK_ROLES.map((r) => presetChoice(preset, r)), presetChoice(preset, null)];
}

/**
 * Owns the single AudioContext, created lazily on a user gesture (browsers keep a context
 * created without one suspended), and the SoundFont bank.
 */
export class AudioEngine {
  /** Sound preset, drums, per-track instruments; read live by the synth and the scheduler. */
  readonly sound: SoundSettings;
  /** Master mode and volume; applied live to the synth. */
  readonly master: MasterSettings;
  /** SoundFont samples, loaded on demand. */
  readonly samples: SoundfontBank;
  #ctx: AudioContext | null = null;
  #synth: Synth | null = null;
  #playing: () => boolean = () => false;
  /** Suspends the context while nothing plays or sounds (issue #82). */
  readonly #idle = new IdleSuspender(
    () => this.#ctx,
    () => this.#playing() || (this.#synth?.voiceCount ?? 0) > 0,
  );

  /** `storage` keeps the sound settings across reloads (localStorage in the app). */
  constructor(storage: SoundStorage | null = null, options: EngineOptions = {}) {
    this.sound = new SoundSettings(storage);
    this.master = new MasterSettings(storage);
    this.master.subscribe((state) => {
      this.#synth?.setMasterMode(state.mode);
      this.#synth?.setMasterVolume(state.volume);
    });
    this.samples = new SoundfontBank({
      fetch: options.fetch ?? ((url) => fetch(url)),
      caches: options.caches !== undefined ? options.caches : browserCaches(),
      ...(options.base === undefined ? {} : { base: options.base }),
    });
    // A newly chosen SoundFont instrument (a preset or one track) starts loading at once.
    let inUse = soundfontsInUse(this.sound);
    this.sound.subscribe(() => {
      const next = soundfontsInUse(this.sound);
      for (const id of next) if (!inUse.has(id)) this.samples.load(id);
      inUse = next;
    });
  }

  /** Start fetching the current preset's chords instrument (the first thing that plays). */
  prefetch(): void {
    const font = soundfont(presetChoice(this.sound.preset, 'chords'));
    if (font !== undefined) this.samples.load(font.id);
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

  /**
   * Create or resume the context. Call from a user gesture (click, key press) the first time;
   * later calls also wake a context suspended for idling.
   */
  async start(): Promise<boolean> {
    if (typeof AudioContext === 'undefined') return false;
    if (this.#ctx === null) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.#ctx = ctx;
      this.#synth = new Synth(ctx, () => this.sound.preset, this.master.state, {
        voice: (track, role) => this.sound.voice(track, role),
        samples: this.samples,
      });
      void this.samples.attach((bytes) => ctx.decodeAudioData(bytes));
      this.prefetch();
    }
    return this.#idle.wake();
  }

  /**
   * Make an existing context run again (it may be suspended for idling) and say whether notes
   * can be scheduled on it now. Notes scheduled while the resume is pending play once it runs.
   */
  wake(): boolean {
    const ctx = this.#ctx;
    if (ctx === null || ctx.state === 'closed') return false;
    void this.#idle.wake();
    return true;
  }

  /** Tell the engine whether the transport plays (it never suspends while it does). */
  setPlaying(playing: () => boolean): void {
    this.#playing = playing;
  }

  /** Playback stopped: suspend the context once the tails are over. */
  idle(): void {
    if (this.#ctx !== null) this.#idle.touch();
  }

  /** The page was hidden: suspend now when nothing plays or sounds. */
  hidden(): void {
    this.#idle.check();
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

/** `window.caches` when the page may use it (secure origins), else null. */
function browserCaches(): SampleCacheStorage | null {
  try {
    return typeof caches === 'undefined' ? null : caches;
  } catch {
    return null;
  }
}
