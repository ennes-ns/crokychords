// @vitest-environment node
/**
 * Renders notes no longer than their instrument's attack offline (a real OfflineAudioContext from
 * node-web-audio-api, nothing is played): the release starts from the level the attack reached,
 * so they sound and do not click (issue #89). Runs both with `cancelAndHoldAtTime` and with the
 * computed fallback for engines without it.
 */
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { GainLike, SynthContext } from '../src/audio/graph';
import { INSTRUMENTS } from '../src/audio/instruments';
import { Synth } from '../src/audio/synth';

const RATE = 48000;

function rms(data: Float32Array): number {
  let sum = 0;
  for (const x of data) sum += x * x;
  return Math.sqrt(sum / data.length);
}

function largestStep(data: Float32Array): number {
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    max = Math.max(max, Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
  }
  return max;
}

/** One note of `instrument` from 0.05 s for `duration`, rendered for 2 s. */
async function render(
  instrument: keyof typeof INSTRUMENTS,
  duration: number,
  hold: boolean,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 2 * RATE, sampleRate: RATE });
  const real: SynthContext = ctx;
  const synthCtx: SynthContext = hold
    ? real
    : new Proxy(real, {
        get(target, key) {
          if (key === 'createGain') return () => withoutHold(target.createGain());
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  const synth = new Synth(synthCtx);
  synth.playNote(60, 0.05, duration, { instrument: INSTRUMENTS[instrument] });
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

/** A gain whose param hides `cancelAndHoldAtTime`, like an engine without it. */
function withoutHold(gain: GainLike): GainLike {
  Object.defineProperty(gain.gain, 'cancelAndHoldAtTime', { value: undefined });
  return gain;
}

describe('notes no longer than the attack, offline', () => {
  it.each([
    ['pad', 0.3, true],
    ['pad', 0.3, false],
    ['piano', 0.05, true],
    ['piano', 0.05, false],
  ] as const)('%s %s s (cancelAndHold %s): has energy, no click', async (name, duration, hold) => {
    const data = await render(name, duration, hold);
    expect(rms(data)).toBeGreaterThan(1e-3);
    // A click is a step far above what the oscillators do in one sample at this level.
    expect(largestStep(data)).toBeLessThan(0.1);
  });
});
