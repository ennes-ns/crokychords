import { TRACK_ROLES } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  AudioEngine,
  MASTER_GAIN,
  TIMBRES,
  midiToFrequency,
  notePeak,
  timbreFor,
} from '../src/audio/synth';

describe('midiToFrequency', () => {
  it('tunes A4 to 440 Hz, octaves double', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(57)).toBeCloseTo(220);
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 2);
  });
});

describe('timbres by role', () => {
  it('has one per role; custom sounds like chords', () => {
    for (const role of TRACK_ROLES) expect(timbreFor(role)).toBe(TIMBRES[role]);
    expect(timbreFor('custom')).toBe(TIMBRES.chords);
  });

  it('chords: two detuned saws through a lowpass', () => {
    const t = TIMBRES.chords;
    expect(t.oscillators.map((o) => o.type)).toEqual(['sawtooth', 'sawtooth']);
    expect(t.oscillators[0]?.detune).toBeLessThan(0);
    expect(t.oscillators[1]?.detune).toBeGreaterThan(0);
    expect(t.filter).not.toBeNull();
  });

  it('bass: triangle plus a quieter sub sine an octave down', () => {
    const [main, sub] = TIMBRES.bass.oscillators;
    expect(main).toMatchObject({ type: 'triangle', octave: 0 });
    expect(sub).toMatchObject({ type: 'sine', octave: -1 });
    expect(sub?.level ?? 1).toBeLessThan(main?.level ?? 0);
  });

  it('arp: square with a short decay; pad: saw with slow attack and release', () => {
    expect(TIMBRES.arp.oscillators.map((o) => o.type)).toEqual(['square']);
    expect(TIMBRES.arp.decay).toBeLessThan(TIMBRES.chords.decay);
    expect(TIMBRES.arp.sustain).toBeLessThan(0.2);
    expect(TIMBRES.pad.oscillators.every((o) => o.type === 'sawtooth')).toBe(true);
    expect(TIMBRES.pad.attack).toBeGreaterThan(0.2);
    expect(TIMBRES.pad.release).toBeGreaterThan(TIMBRES.chords.release);
  });
});

describe('notePeak', () => {
  it('scales with velocity / 127 and the role level', () => {
    const full = notePeak(TIMBRES.chords, 127);
    expect(notePeak(TIMBRES.chords, 64)).toBeCloseTo((full * 64) / 127);
    expect(notePeak(TIMBRES.chords, 200)).toBe(full);
    expect(notePeak(TIMBRES.chords, -3)).toBe(0);
    expect(notePeak(TIMBRES.pad, 127)).toBeLessThan(notePeak(TIMBRES.bass, 127));
    expect(MASTER_GAIN).toBe(0.2);
  });
});

describe('AudioEngine', () => {
  it('stays silent without Web Audio (jsdom)', async () => {
    const engine = new AudioEngine();
    expect(await engine.start()).toBe(false);
    expect(engine.ready).toBe(false);
    expect(engine.synth).toBeNull();
    expect(engine.toPerformanceTime(1.5)).toBe(1500);
  });
});
