// @vitest-environment node
/**
 * Renders a Stop, the idle suspend and a note after the resume offline (a real
 * OfflineAudioContext from node-web-audio-api, nothing is played), to check that suspending the
 * context when idle (issue #82) cannot click: by the time the engine would suspend, every voice
 * has finished and the output is silent, and the first note after the resume starts from silence.
 */
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { SynthContext } from '../src/audio/graph';
import { IDLE_MS } from '../src/audio/idle';
import { Synth } from '../src/audio/synth';

const RATE = 48000;

/** Largest absolute sample in [from, to) seconds over both channels. */
function peak(channels: Float32Array[], from: number, to: number): number {
  let max = 0;
  for (const data of channels) {
    for (let i = Math.round(from * RATE); i < Math.min(data.length, Math.round(to * RATE)); i++) {
      max = Math.max(max, Math.abs(data[i] ?? 0));
    }
  }
  return max;
}

/** Largest sample-to-sample step in [from, to) seconds over both channels. */
function largestStep(channels: Float32Array[], from: number, to: number): number {
  let max = 0;
  for (const data of channels) {
    for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) {
      max = Math.max(max, Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
    }
  }
  return max;
}

describe('idle suspend, offline', () => {
  it.each(['pad', 'piano', 'band'] as const)(
    '%s: silent at the suspend, no step at the resume',
    async (preset) => {
      const stopAt = 1;
      const suspendAt = stopAt + IDLE_MS / 1000;
      const seconds = suspendAt + 0.5;
      /**
       * A chord, a bass note and a kick that end at `stopAt` (released there, like Stop does),
       * rendered up to `until`; `after` adds what happens once the context runs again.
       */
      const render = async (until: number, after: (synth: Synth) => void = () => undefined) => {
        const ctx = new OfflineAudioContext({
          numberOfChannels: 2,
          length: Math.round(until * RATE),
          sampleRate: RATE,
        });
        const synthCtx: SynthContext = ctx;
        const synth = new Synth(synthCtx, () => preset);
        synth.playChord([60, 64, 67], 0.05, stopAt - 0.05, { role: 'chords' });
        synth.playNote(36, 0.05, stopAt - 0.05, { role: 'bass' });
        synth.playDrum('kick', 1, 0.5);
        after(synth);
        const buffer = await ctx.startRendering();
        return { synth, channels: [buffer.getChannelData(0), buffer.getChannelData(1)] };
      };
      // Up to the moment the engine would suspend: no live voices are left.
      const quiet = await render(suspendAt);
      expect(quiet.synth.voiceCount).toBe(0);
      // A suspended context renders nothing and resumes on the same sample, so the timeline
      // around a suspend is this one: the next note 10 ms after the resume point.
      const { channels } = await render(seconds, (synth) =>
        synth.playNote(72, suspendAt + 0.01, 1, { role: 'chords' }),
      );
      expect(peak(channels, 0.3, stopAt)).toBeGreaterThan(0.01); // it did sound
      // Silent for the last half second before the suspend point.
      expect(peak(channels, suspendAt - 0.5, suspendAt)).toBeLessThan(1e-4);
      // The note after the resume ramps up from silence: no step larger than its attack makes.
      expect(largestStep(channels, suspendAt - 0.01, suspendAt + 0.02)).toBeLessThan(0.02);
      expect(peak(channels, suspendAt + 0.01, seconds)).toBeGreaterThan(0.005);
    },
  );
});
