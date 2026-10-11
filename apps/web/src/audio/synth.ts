/**
 * Web Audio poly synth with one timbre per track role (chords, bass, arp, pad; custom uses the
 * chords timbre). Every track gets its own gain bus into the master gain (0.2) and a limiter;
 * a note's level scales with its MIDI velocity / 127.
 */
import type { TrackRole } from '@crokychords/core';

export const MASTER_GAIN = 0.2;
const VOICE_PEAK = 0.32;
/** Release time used by Stop (seconds). */
const STOP_RELEASE = 0.03;

export function midiToFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

export interface OscillatorSpec {
  type: OscillatorType;
  /** Cents. */
  detune: number;
  level: number;
  /** Octaves relative to the note (-1 = sub oscillator). */
  octave: number;
}

export interface Timbre {
  oscillators: readonly OscillatorSpec[];
  /** Lowpass cutoff: `base + frequency * track` Hz (capped at 9 kHz); null = no filter. */
  filter: { base: number; track: number; q: number } | null;
  /** Seconds. */
  attack: number;
  /** Time constant scale of the decay to the sustain level, seconds. */
  decay: number;
  /** 0..1 of the peak. */
  sustain: number;
  /** Seconds. */
  release: number;
  /** Overall level of the role (balances the timbres against each other). */
  level: number;
}

const CHORDS: Timbre = {
  oscillators: [
    { type: 'sawtooth', detune: -7, level: 0.5, octave: 0 },
    { type: 'sawtooth', detune: 7, level: 0.5, octave: 0 },
  ],
  filter: { base: 1200, track: 4, q: 0.7 },
  attack: 0.012,
  decay: 0.25,
  sustain: 0.55,
  release: 0.3,
  level: 0.8,
};

export const TIMBRES: Readonly<Record<TrackRole, Timbre>> = {
  chords: CHORDS,
  bass: {
    oscillators: [
      { type: 'triangle', detune: 0, level: 0.9, octave: 0 },
      { type: 'sine', detune: 0, level: 0.45, octave: -1 },
    ],
    filter: null,
    attack: 0.008,
    decay: 0.2,
    sustain: 0.75,
    release: 0.12,
    level: 1,
  },
  arp: {
    oscillators: [{ type: 'square', detune: 0, level: 0.35, octave: 0 }],
    filter: { base: 1800, track: 3, q: 0.9 },
    attack: 0.004,
    decay: 0.12,
    sustain: 0.12,
    release: 0.08,
    level: 0.7,
  },
  pad: {
    oscillators: [
      { type: 'sawtooth', detune: -10, level: 0.4, octave: 0 },
      { type: 'sawtooth', detune: 10, level: 0.4, octave: 0 },
    ],
    filter: { base: 700, track: 2, q: 0.5 },
    attack: 0.35,
    decay: 0.6,
    sustain: 0.85,
    release: 0.9,
    level: 0.6,
  },
  custom: CHORDS,
};

export function timbreFor(role: TrackRole): Timbre {
  return TIMBRES[role];
}

/** Peak gain of one note: velocity/127 scaled by the role level. */
export function notePeak(timbre: Timbre, velocity: number): number {
  const v = Math.min(127, Math.max(0, velocity)) / 127;
  return VOICE_PEAK * timbre.level * v;
}

/** Sounding notes that can be released early. */
export interface NoteHandle {
  release(time?: number): void;
}

export interface NoteOptions {
  /** Timbre, default 'chords'. */
  role?: TrackRole;
  /** MIDI velocity 1-127, default 96. */
  velocity?: number;
  /** Track id: the gain bus the note goes through (default 'default'). */
  track?: string;
}

interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
  start: number;
  /** Time the release starts. */
  end: number;
  release: number;
  track: string;
}

export class Synth {
  readonly #ctx: AudioContext;
  readonly #master: GainNode;
  readonly #buses = new Map<string, GainNode>();
  #voices = new Set<Voice>();

  constructor(ctx: AudioContext) {
    this.#ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    this.#master = ctx.createGain();
    this.#master.gain.value = MASTER_GAIN;
    this.#master.connect(limiter);
    limiter.connect(ctx.destination);
  }

  /** Number of voices not yet ended (for tests and debugging). */
  get voiceCount(): number {
    return this.#voices.size;
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

  #bus(track: string): GainNode {
    let bus = this.#buses.get(track);
    if (bus === undefined) {
      bus = this.#ctx.createGain();
      bus.gain.value = 1;
      bus.connect(this.#master);
      this.#buses.set(track, bus);
    }
    return bus;
  }

  #voice(note: number, time: number, duration: number, opts: NoteOptions): Voice {
    const ctx = this.#ctx;
    const timbre = timbreFor(opts.role ?? 'chords');
    const track = opts.track ?? 'default';
    const start = Math.max(time, ctx.currentTime);
    const frequency = midiToFrequency(note);

    const gain = ctx.createGain();
    gain.gain.value = 0;
    const peak = notePeak(timbre, opts.velocity ?? 96);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + timbre.attack);
    gain.gain.setTargetAtTime(peak * timbre.sustain, start + timbre.attack, timbre.decay / 3);
    gain.connect(this.#bus(track));

    let input: AudioNode = gain;
    if (timbre.filter !== null) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(9000, timbre.filter.base + frequency * timbre.filter.track);
      filter.Q.value = timbre.filter.q;
      filter.connect(gain);
      input = filter;
    }

    const oscillators = timbre.oscillators.map((spec) => {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = frequency * 2 ** spec.octave;
      osc.detune.value = spec.detune;
      const mix = ctx.createGain();
      mix.gain.value = spec.level;
      osc.connect(mix);
      mix.connect(input);
      osc.start(start);
      return osc;
    });

    const voice: Voice = {
      oscillators,
      gain,
      start,
      end: Infinity,
      release: timbre.release,
      track,
    };
    this.#voices.add(voice);
    this.#release(voice, start + Math.max(duration, timbre.attack));
    const [first] = oscillators;
    if (first !== undefined) first.onended = () => this.#voices.delete(voice);
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
    for (const osc of voice.oscillators) {
      try {
        osc.stop(stopAt);
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
  #ctx: AudioContext | null = null;
  #synth: Synth | null = null;

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
      this.#synth = new Synth(this.#ctx);
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
