/** Web Audio poly synth: per note two detuned oscillators (saw + triangle) → lowpass → ADSR. */

export const MASTER_GAIN = 0.2;

const ATTACK = 0.012;
const DECAY = 0.25;
const SUSTAIN = 0.55;
const RELEASE = 0.3;
const VOICE_PEAK = 0.32;

export function midiToFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/** A sounding chord that can be released early. */
export interface ChordHandle {
  release(time?: number): void;
}

interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
  start: number;
  /** Time the release starts. */
  end: number;
}

export class Synth {
  readonly #ctx: AudioContext;
  readonly #master: GainNode;
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

  /** Play MIDI notes from `time` (AudioContext seconds) for `duration` seconds. */
  playChord(notes: readonly number[], time: number, duration: number, velocity = 0.8): ChordHandle {
    const voices = notes.map((note) => this.#voice(note, time, duration, velocity));
    return {
      release: (at) => voices.forEach((v) => this.#release(v, at ?? this.#ctx.currentTime)),
    };
  }

  /** Silence everything now (Stop). */
  stopAll(): void {
    const now = this.#ctx.currentTime;
    for (const voice of [...this.#voices]) this.#release(voice, now, 0.03);
  }

  #voice(note: number, time: number, duration: number, velocity: number): Voice {
    const ctx = this.#ctx;
    const start = Math.max(time, ctx.currentTime);
    const frequency = midiToFrequency(note);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(9000, 1200 + frequency * 4);
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    const peak = VOICE_PEAK * velocity;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + ATTACK);
    gain.gain.setTargetAtTime(peak * SUSTAIN, start + ATTACK, DECAY / 3);
    filter.connect(gain);
    gain.connect(this.#master);

    const oscillators = (
      [
        ['sawtooth', -7, 0.5],
        ['triangle', 7, 0.8],
      ] as const
    ).map(([type, detune, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      const mix = ctx.createGain();
      mix.gain.value = level;
      osc.connect(mix);
      mix.connect(filter);
      osc.start(start);
      return osc;
    });

    const voice: Voice = { oscillators, gain, start, end: Infinity };
    this.#voices.add(voice);
    this.#release(voice, start + Math.max(duration, ATTACK));
    const [first] = oscillators;
    if (first !== undefined) first.onended = () => this.#voices.delete(voice);
    return voice;
  }

  /** Start the release at `time`; only ever moves the release earlier. */
  #release(voice: Voice, time: number, release = RELEASE): void {
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
