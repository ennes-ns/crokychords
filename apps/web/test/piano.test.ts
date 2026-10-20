import { describe, expect, it } from 'vitest';
import { ROOM, buildRoom, noiseBuffer, roomImpulse } from '../src/audio/graph';
import type { Instrument, PianoSpec } from '../src/audio/instruments';
import {
  INSTRUMENTS,
  instrumentFor,
  midiToFrequency,
  noteCutoff,
  notePan,
  notePeak,
  noteTail,
} from '../src/audio/instruments';
import { PARTIAL_LIMIT_HZ, buildPianoVoice } from '../src/audio/piano';
import { STEAL_RELEASE, Synth } from '../src/audio/synth';
import {
  FakeBufferSource,
  FakeContext,
  FakeConvolver,
  FakeFilter,
  FakeGain,
  FakeNode,
  FakeOscillator,
  FakePanner,
} from './fakeAudio';

const PIANO = INSTRUMENTS.piano;
const SPEC: PianoSpec = (() => {
  if (PIANO.piano === undefined) throw new Error('piano has no piano spec');
  return PIANO.piano;
})();
const RATE = 48000;

function voice(
  note: number,
  velocity = 127,
  instrument: Instrument = PIANO,
  room: FakeNode | null = null,
): { ctx: FakeContext; out: FakeNode; gain: FakeGain } {
  const ctx = new FakeContext(RATE);
  const out = new FakeNode('out');
  const nodes = buildPianoVoice(ctx, instrument, SPEC, note, velocity, 1, out, {
    noise: noiseBuffer(ctx, () => 0.5),
    room,
  });
  if (!(nodes.gain instanceof FakeGain)) throw new Error('no fake gain');
  return { ctx, out, gain: nodes.gain };
}

describe('piano voice (fake context)', () => {
  it('detuned unison plus the inharmonic partials, through a lowpass, envelope and panner', () => {
    const { ctx } = voice(57);
    const f = midiToFrequency(57);
    const oscs = ctx.of(FakeOscillator);
    expect(oscs.every((o) => o.type === 'sine')).toBe(true);
    expect(oscs.slice(0, 3).map((o) => o.detune.value)).toEqual([-3, 0, 2]);
    expect(oscs.slice(0, 3).every((o) => o.frequency.value === f)).toBe(true);
    const ratios = oscs.slice(3).map((o) => o.frequency.value / f);
    expect(ratios).toHaveLength(SPEC.partials.length);
    for (const [i, p] of SPEC.partials.entries()) expect(ratios[i]).toBeCloseTo(p.ratio, 9);
    expect(oscs.every((o) => o.starts[0] === 1)).toBe(true);
    const [first] = oscs;
    if (first === undefined) throw new Error('no oscillator');
    expect(ctx.route(first)).toEqual(['oscillator', 'gain', 'filter', 'gain', 'panner', 'out']);
  });

  it('leaves out partials above the limit', () => {
    const { ctx } = voice(108); // C8, 4186 Hz: only the unison and partial 2.0 and 3.01 fit
    const f = midiToFrequency(108);
    const hz = ctx.of(FakeOscillator).map((o) => o.frequency.value);
    expect(Math.max(...hz)).toBeLessThan(PARTIAL_LIMIT_HZ);
    expect(hz).toHaveLength(3 + SPEC.partials.filter((p) => p.ratio * f < PARTIAL_LIMIT_HZ).length);
  });

  it('two-stage envelope: attack, fast drop to the tail level, then the key-tracked tail', () => {
    const { gain } = voice(60, 127);
    const tail = PIANO.tail;
    if (tail === undefined) throw new Error('no tail');
    const peak = notePeak(PIANO, 127);
    const [set, attack, first, second] = gain.gain.calls;
    expect(set).toMatchObject({ method: 'set', value: 0, time: 1 });
    expect(attack).toMatchObject({ method: 'linear', time: 1 + PIANO.attack });
    expect(attack?.value).toBeCloseTo(peak);
    expect(first).toMatchObject({ method: 'target', time: 1 + PIANO.attack });
    expect(first?.value).toBeCloseTo(peak * tail.level);
    expect(first?.constant).toBeCloseTo(PIANO.decay / 3);
    expect(second).toMatchObject({ method: 'target', value: 0 });
    expect(second?.time).toBeCloseTo(1 + PIANO.attack + PIANO.decay);
    expect(second?.constant).toBeCloseTo(noteTail(tail, midiToFrequency(60)) / 3);
  });

  it('velocity and brightness scale the cutoff', () => {
    const cutoff = (velocity: number, instrument: Instrument = PIANO): number =>
      voice(60, velocity, instrument)
        .ctx.of(FakeFilter)
        .find((f) => f.type === 'lowpass')?.frequency.value ?? NaN;
    const filter = PIANO.filter;
    if (filter === null) throw new Error('no filter');
    expect(cutoff(127)).toBeCloseTo(noteCutoff(filter, midiToFrequency(60)));
    expect(cutoff(0)).toBeCloseTo(noteCutoff(filter, midiToFrequency(60)) * SPEC.velocityCutoff);
    expect(cutoff(64)).toBeLessThan(cutoff(127));
    const band = instrumentFor('band', 'chords');
    expect(cutoff(127, band)).toBeCloseTo(cutoff(127) * (band.brightness ?? 1));
  });

  it('hammer: a short band-passed noise burst into the envelope', () => {
    const { ctx, gain } = voice(60);
    const [noise] = ctx.of(FakeBufferSource);
    expect(noise?.starts).toEqual([1]);
    expect(noise?.stops[0]).toBeCloseTo(1 + SPEC.hammer.duration);
    expect(SPEC.hammer.duration).toBeGreaterThanOrEqual(0.005);
    expect(SPEC.hammer.duration).toBeLessThanOrEqual(0.01);
    if (noise === undefined) throw new Error('no noise');
    expect(ctx.route(noise).slice(0, 3)).toEqual(['buffer-source', 'filter', 'gain']);
    expect(ctx.of(FakeFilter).map((f) => f.type)).toContain('bandpass');
    const hammerGain = ctx.of(FakeGain).find((g) => g.outputs[0] === gain);
    expect(hammerGain?.gain.max).toBeCloseTo(SPEC.hammer.level);
  });

  it('pans by pitch and sends to the room at most ROOM.maxWet', () => {
    const room = new FakeNode('room');
    const low = voice(36, 100, PIANO, room);
    const high = voice(84, 100, PIANO, room);
    expect(low.ctx.of(FakePanner)[0]?.pan.value).toBeCloseTo(-0.3);
    expect(high.ctx.of(FakePanner)[0]?.pan.value).toBeCloseTo(notePan(SPEC, 84));
    const [panner] = low.ctx.of(FakePanner);
    const send = panner?.outputs[1];
    expect(send).toBeInstanceOf(FakeGain);
    if (!(send instanceof FakeGain)) throw new Error('no send');
    expect(send.gain.value).toBeCloseTo(ROOM.maxWet * (PIANO.room ?? 0));
    expect(send.gain.value).toBeLessThanOrEqual(0.15);
    expect(send.outputs).toEqual([room]);
    // No room: no send.
    expect(voice(60).ctx.of(FakePanner)[0]?.outputs).toHaveLength(1);
  });
});

describe('room', () => {
  it('stereo impulse of ROOM.seconds, decaying, unit energy per channel', () => {
    const ctx = new FakeContext(1000);
    const ir = roomImpulse(ctx, () => 0.9);
    for (const channel of [0, 1]) {
      const data = ir.getChannelData(channel);
      expect(data).toHaveLength(400);
      expect(data.reduce((s, v) => s + v * v, 0)).toBeCloseTo(1);
      expect(Math.abs(data[0] ?? 0)).toBeGreaterThan(100 * Math.abs(data[399] ?? 0));
    }
  });

  it('input → convolver (not normalised) → out', () => {
    const ctx = new FakeContext(1000);
    const out = new FakeNode('out');
    const input = buildRoom(ctx, out);
    expect(ctx.route(input)).toEqual(['gain', 'convolver', 'out']);
    const [convolver] = ctx.of(FakeConvolver);
    expect(convolver?.normalize).toBe(false);
    expect(convolver?.buffer).not.toBeNull();
  });

  it('the synth builds one shared room, only for instruments with a room', () => {
    const ctx = new FakeContext(1000);
    const synth = new Synth(ctx, () => 'piano');
    synth.playChord([60, 64, 67], 0, 1, { role: 'chords' });
    expect(ctx.of(FakeConvolver)).toHaveLength(1);
    const pad = new FakeContext(1000);
    new Synth(pad, () => 'pad').playChord([60, 64, 67], 0, 1, { role: 'chords' });
    expect(pad.of(FakeConvolver)).toHaveLength(0);
  });
});

describe('voice budget', () => {
  it('24 piano voices; the 25th steals the oldest with a short release', () => {
    const ctx = new FakeContext(1000);
    const synth = new Synth(ctx, () => 'piano');
    const oscillatorsPerNote = (): number => ctx.of(FakeOscillator).length;
    synth.playNote(40, 0, 10, { role: 'chords' });
    const perNote = oscillatorsPerNote();
    for (let i = 1; i < 24; i++) synth.playNote(40 + i, i * 0.01, 10, { role: 'chords' });
    const oscs = ctx.of(FakeOscillator);
    // Nothing stolen yet: every voice still ends at its own release.
    expect(oscs.every((o) => (o.stops.at(-1) ?? 0) > 10)).toBe(true);
    synth.playNote(70, 0.5, 10, { role: 'chords' });
    const oldest = oscs.slice(0, perNote);
    for (const o of oldest) expect(o.stops.at(-1)).toBeCloseTo(0.5 + STEAL_RELEASE * 2);
    expect(oscs.slice(perNote).every((o) => (o.stops.at(-1) ?? 0) > 10)).toBe(true);
  });

  it('released voices do not count; other instruments have no budget', () => {
    const ctx = new FakeContext(1000);
    const synth = new Synth(ctx, () => 'pad');
    for (let i = 0; i < 30; i++) synth.playNote(40 + i, 0, 10, { role: 'chords' });
    expect(ctx.of(FakeOscillator).every((o) => (o.stops.at(-1) ?? 0) > 10)).toBe(true);

    const piano = new FakeContext(1000);
    const p = new Synth(piano, () => 'piano');
    for (let i = 0; i < 30; i++) p.playNote(40 + i, i * 0.1, 0.05, { role: 'chords' });
    // Each note was over before the next began: nothing was stolen.
    const stops = piano.of(FakeOscillator).map((o) => o.stops.length);
    expect(Math.max(...stops)).toBe(1);
  });
});
