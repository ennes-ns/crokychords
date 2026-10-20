import { MELODY_TRACK_ID, TRACK_ROLES, createSong, createTrack } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  COMPRESSOR,
  DRUM_DECAY,
  MASTER_GAIN,
  MIX_GAIN,
  ROOM,
  buildDrum,
  buildMasterBus,
  buildVoice,
  noiseBuffer,
} from '../src/audio/graph';
import {
  DEFAULT_SOUND_PRESET,
  DRUM_PEAK,
  INSTRUMENTS,
  INSTRUMENT_IDS,
  SOUND_PRESETS,
  SYNTH_IDS,
  drumHits,
  envelopeAt,
  instrumentFor,
  leadFor,
  midiToFrequency,
  presetChoice,
  soundfont,
  noteAmplitude,
  notePan,
  notePeak,
  noteTail,
  panGain,
  pianoPartials,
  soundPreset,
} from '../src/audio/instruments';
import { planSong } from '../src/audio/scheduler';
import { SAMPLE_RELEASE, sampleAmplitude } from '../src/audio/soundfont';
import { AudioEngine, DRUM_BUS, Synth } from '../src/audio/synth';
import {
  FakeBufferSource,
  FakeCompressor,
  FakeContext,
  FakeFilter,
  FakeGain,
  FakeNode,
  FakeOscillator,
} from './fakeAudio';

describe('midiToFrequency', () => {
  it('tunes A4 to 440 Hz, octaves double', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(57)).toBeCloseTo(220);
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 2);
  });
});

describe('instruments', () => {
  it('piano: short attack, two-stage decay to silence, low notes ring longer', () => {
    const p = INSTRUMENTS.piano;
    expect(p.attack).toBeLessThan(0.01);
    expect(p.sustain).toBe(0);
    expect(p.filter?.env?.from).toBeGreaterThan(1);
    expect(p.decay).toBeCloseTo(0.3);
    expect(p.release).toBeCloseTo(0.08);
    expect(p.voices).toBe(24);
    const tail = p.tail;
    if (tail === undefined) throw new Error('no tail');
    expect(noteTail(tail, midiToFrequency(36))).toBeGreaterThan(
      noteTail(tail, midiToFrequency(84)),
    );
    expect(noteTail(tail, midiToFrequency(0))).toBe(6);
    expect(noteTail(tail, midiToFrequency(127))).toBe(2);
    // Unison of three sines within ±3 cents.
    expect(p.oscillators.map((o) => o.type)).toEqual(['sine', 'sine', 'sine']);
    for (const o of p.oscillators) expect(Math.abs(o.detune)).toBeLessThanOrEqual(3);
    expect(p.piano?.partials.map((x) => x.ratio)).toEqual([2.0, 3.01, 4.03, 5.08]);
  });

  it('piano: partials fall with partial number and with pitch, pan follows pitch', () => {
    const spec = INSTRUMENTS.piano.piano;
    if (spec === undefined) throw new Error('no piano spec');
    const low = pianoPartials(spec, midiToFrequency(36)).map((p) => p.level);
    const high = pianoPartials(spec, midiToFrequency(84)).map((p) => p.level);
    for (let i = 1; i < low.length; i++) {
      expect(low[i]).toBeLessThan(low[i - 1] ?? 0);
      expect(high[i]).toBeLessThan(high[i - 1] ?? 0);
    }
    for (const [i, level] of low.entries()) expect(level).toBeGreaterThan(high[i] ?? Infinity);
    expect(notePan(spec, 36)).toBeCloseTo(-0.3);
    expect(notePan(spec, 60)).toBeCloseTo(0);
    expect(notePan(spec, 108)).toBeCloseTo(0.3);
    expect(panGain(0)).toBeCloseTo(Math.SQRT1_2);
    expect(panGain(1)).toBeCloseTo(1);
  });

  it('envelopeAt mirrors the two-stage decay', () => {
    const p = INSTRUMENTS.piano;
    const f = midiToFrequency(60);
    const tail = p.tail;
    if (tail === undefined) throw new Error('no tail');
    const knee = envelopeAt(p, f, p.attack + p.decay, 10);
    expect(knee).toBeCloseTo(tail.level + (1 - tail.level) * Math.exp(-3));
    const tau = noteTail(tail, f) / 3;
    expect(envelopeAt(p, f, p.attack + p.decay + tau, 10)).toBeCloseTo(knee / Math.E);
    // Released: the damper takes it down within a fraction of a second.
    expect(envelopeAt(p, f, 1 + p.release * 2, 1)).toBeLessThan(0.01);
  });

  it('pad: slow attack, lowpass that opens, long release', () => {
    const p = INSTRUMENTS.pad;
    expect(p.attack).toBeGreaterThan(0.3);
    expect(p.sustain).toBeGreaterThan(0.5);
    expect(p.filter).not.toBeNull();
    expect(p.filter?.env?.from).toBeLessThan(1);
    expect(p.release).toBeGreaterThan(INSTRUMENTS.piano.release);
  });

  it('bass: pluck filter envelope and a sub oscillator an octave down', () => {
    const b = INSTRUMENTS.bass;
    expect(b.filter?.env?.from).toBeGreaterThan(1);
    expect(b.filter?.env?.time).toBeLessThan(0.2);
    expect(b.oscillators.some((o) => o.octave === -1)).toBe(true);
  });

  it('notePeak scales with velocity / 127 and the instrument level', () => {
    const full = notePeak(INSTRUMENTS.piano, 127);
    expect(notePeak(INSTRUMENTS.piano, 64)).toBeCloseTo((full * 64) / 127);
    expect(notePeak(INSTRUMENTS.piano, 200)).toBe(full);
    expect(notePeak(INSTRUMENTS.piano, -3)).toBe(0);
  });
});

describe('sound presets', () => {
  it('Piano, Band and Pad, with Band as the default', () => {
    expect(SOUND_PRESETS.map((p) => p.name)).toEqual([
      'Piano',
      'Band',
      'Pad',
      'Chamber',
      'Electric',
    ]);
    expect(DEFAULT_SOUND_PRESET).toBe('band');
  });

  it('maps every role to an instrument', () => {
    for (const preset of SOUND_PRESETS) {
      for (const role of TRACK_ROLES) {
        expect(INSTRUMENT_IDS).toContain(preset.instruments[role]);
      }
    }
    expect(instrumentFor('piano', 'bass')).toBe(INSTRUMENTS.piano);
    // Band tunes its piano a little darker and drier; the same object every time.
    expect(instrumentFor('band', 'chords')).toEqual({
      ...INSTRUMENTS.piano,
      brightness: 0.8,
      room: 0.6,
    });
    expect(instrumentFor('band', 'chords')).toBe(instrumentFor('band', 'arp'));
    expect(instrumentFor('band', 'bass')).toBe(INSTRUMENTS.bass);
    expect(instrumentFor('band', 'pad')).toBe(INSTRUMENTS.pad);
    expect(instrumentFor('pad', 'chords')).toBe(INSTRUMENTS.pad);
    expect(soundPreset('band').drums).toBe('straight');
    expect(soundPreset('piano').drums).toBe('none');
  });

  it('names a lead instrument for the melody lane', () => {
    for (const preset of SOUND_PRESETS) expect(INSTRUMENT_IDS).toContain(preset.lead);
    expect(leadFor('band')).toBe(INSTRUMENTS.lead);
    expect(leadFor('pad')).toBe(INSTRUMENTS.lead);
    expect(leadFor('piano')).toBe(INSTRUMENTS.lead);
    expect(new Synth(new FakeContext(), () => 'band').leadInstrument()).toBe(INSTRUMENTS.lead);
  });
});

describe('graph construction (fake context)', () => {
  it('master bus: mix → gentle compressor → master gain → volume → destination', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx);
    expect(ctx.route(bus.input)).toEqual(['gain', 'compressor', 'gain', 'gain', 'destination']);
    expect(bus.input.gain.value).toBe(MIX_GAIN);
    expect(bus.output.gain.value).toBe(MASTER_GAIN);
    expect(bus.volume.gain.value).toBe(1);
    const [comp] = ctx.of(FakeCompressor);
    expect(comp?.ratio.value).toBe(COMPRESSOR.ratio);
    expect(comp?.ratio.value).toBeLessThanOrEqual(4);
    expect(comp?.threshold.value).toBe(COMPRESSOR.threshold);
  });

  it.each(SYNTH_IDS.filter((id) => id !== 'piano'))(
    '%s voice: oscillators → lowpass → envelope → out',
    (id) => {
      const ctx = new FakeContext();
      const out = new FakeNode('out');
      const inst = INSTRUMENTS[id];
      const voice = buildVoice(ctx, inst, 60, 127, 1, out);
      const oscs = ctx.of(FakeOscillator);
      expect(oscs.map((o) => o.type)).toEqual(inst.oscillators.map((o) => o.type));
      expect(oscs.map((o) => o.starts)).toEqual(inst.oscillators.map(() => [1]));
      expect(oscs.map((o) => o.frequency.value)).toEqual(
        inst.oscillators.map((o) => midiToFrequency(60) * 2 ** o.octave),
      );
      const [first] = oscs;
      if (first === undefined) throw new Error('no oscillator');
      expect(ctx.route(first)).toEqual(['oscillator', 'gain', 'filter', 'gain', 'out']);
      expect(ctx.of(FakeFilter)[0]?.type).toBe('lowpass');
      expect(voice.sources).toHaveLength(inst.oscillators.length);
      expect(voice.gain).toBeInstanceOf(FakeGain);
      const calls = voice.gain instanceof FakeGain ? voice.gain.gain.calls : [];
      const [set, attack, decay] = calls;
      expect(set).toMatchObject({ method: 'set', value: 0, time: 1 });
      expect(attack).toMatchObject({ method: 'linear', time: 1 + inst.attack });
      expect(attack?.value).toBeCloseTo(notePeak(inst, 127));
      expect(decay).toMatchObject({ method: 'target', time: 1 + inst.attack });
      expect(decay?.value).toBeCloseTo(notePeak(inst, 127) * inst.sustain);
    },
  );

  it('filter envelope starts away from the cutoff and settles on it', () => {
    const ctx = new FakeContext();
    buildVoice(ctx, INSTRUMENTS.bass, 36, 100, 0, new FakeNode('out'));
    const [filter] = ctx.of(FakeFilter);
    const [start, settle] = filter?.frequency.calls ?? [];
    expect(start?.value).toBeGreaterThan(filter?.frequency.value ?? Infinity);
    expect(settle).toMatchObject({ method: 'target', value: filter?.frequency.value });
  });

  it('kick: sine sweeping down; snare: band-passed noise plus body; hat: high-passed noise', () => {
    const ctx = new FakeContext();
    const noise = noiseBuffer(ctx, () => 1);
    expect(noise.getChannelData(0)).toHaveLength(ctx.sampleRate);
    expect(noise.getChannelData(0)[0]).toBe(1);

    const kick = buildDrum(ctx, 'kick', 1, 2, noise, new FakeNode('out'));
    const [osc] = ctx.of(FakeOscillator);
    expect(osc?.type).toBe('sine');
    expect(osc?.frequency.calls.at(-1)).toMatchObject({ method: 'exp', value: 45 });
    expect(osc?.stops).toEqual([2 + DRUM_DECAY.kick]);
    expect(kick.gain instanceof FakeGain ? kick.gain.gain.max : 0).toBeCloseTo(DRUM_PEAK.kick);

    const snareCtx = new FakeContext();
    buildDrum(snareCtx, 'snare', 0.5, 0, noise, new FakeNode('out'));
    expect(snareCtx.of(FakeFilter).map((f) => f.type)).toEqual(['bandpass']);
    expect(snareCtx.of(FakeBufferSource)[0]?.buffer).toBe(noise);
    expect(snareCtx.of(FakeOscillator).map((o) => o.type)).toEqual(['triangle']);

    const hatCtx = new FakeContext();
    const hat = buildDrum(hatCtx, 'hat', 1, 0, noise, new FakeNode('out'));
    expect(hatCtx.of(FakeFilter).map((f) => f.type)).toEqual(['highpass']);
    expect(hatCtx.of(FakeOscillator)).toHaveLength(0);
    expect(hat.sources).toHaveLength(1);
  });
});

describe('Synth (fake context)', () => {
  it('plays each role with the instrument of the current preset', () => {
    const ctx = new FakeContext();
    let preset: 'piano' | 'band' | 'pad' = 'band';
    const synth = new Synth(ctx, () => preset);
    expect(synth.instrumentFor('bass')).toBe(INSTRUMENTS.bass);
    synth.playNote(36, 0, 1, { role: 'bass', track: 't1' });
    expect(ctx.of(FakeOscillator).map((o) => o.type)).toEqual(
      INSTRUMENTS.bass.oscillators.map((o) => o.type),
    );
    preset = 'piano';
    expect(synth.instrumentFor('bass')).toBe(INSTRUMENTS.piano);
  });

  it('routes track buses and drums into the master bus', () => {
    const ctx = new FakeContext();
    const synth = new Synth(ctx);
    synth.playNote(60, 0, 1, { role: 'chords', track: 't1' });
    synth.playDrum('kick', 1, 0);
    synth.playDrum('hat', 0.5, 0.25);
    expect(ctx.buffers).toBe(2); // one noise buffer, shared, and the room impulse
    const [osc] = ctx.of(FakeOscillator);
    if (osc === undefined) throw new Error('no oscillator');
    expect(ctx.route(osc)).toEqual([
      'oscillator',
      'gain', // oscillator level
      'filter',
      'gain', // envelope
      'panner',
      'gain', // track bus
      'gain', // mix
      'compressor',
      'gain', // master
      'gain', // volume
      'destination',
    ]);
    const kick = ctx.of(FakeOscillator).at(-1); // the hat has no oscillator
    if (kick === undefined) throw new Error('no kick');
    expect(ctx.route(kick).slice(-5)).toEqual([
      'gain',
      'compressor',
      'gain',
      'gain',
      'destination',
    ]);
    expect(synth.voiceCount).toBe(3);
    expect(DRUM_BUS).toBe('drums');
  });

  it('releases notes at their end and silences everything on stopAll', () => {
    const ctx = new FakeContext();
    const synth = new Synth(ctx);
    synth.playNote(60, 1, 0.5, { role: 'chords', track: 't1' });
    const osc = ctx.of(FakeOscillator)[0];
    expect(osc?.stops.at(-1)).toBeCloseTo(1.5 + INSTRUMENTS.piano.release * 2);
    ctx.currentTime = 1.2;
    synth.stopAll();
    expect(osc?.stops.at(-1)).toBeLessThan(1.5);
    ctx.currentTime = 10;
    expect(synth.voiceCount).toBe(0);
  });

  it('a note released before it starts never sounds', () => {
    const ctx = new FakeContext();
    const synth = new Synth(ctx);
    synth.playNote(60, 0.1, 1);
    synth.stopAll();
    expect(ctx.of(FakeOscillator)[0]?.stops.at(-1)).toBe(0);
  });
});

describe('headroom', () => {
  /**
   * Sum of all voice amplitudes (as if every oscillator peaked at the same moment) of a full
   * band (chords, bass, arp, pad all unmuted, four-note chords, straight drums) plus an
   * eighth-note melody through the lead at 120 BPM,
   * sampled every 5 ms with the real envelopes, must stay below full scale before the
   * compressor does anything, with the limiter off. A SoundFont voice counts its loudest sample
   * at full level for as long as it is held, then the release fade (soundfonts-v1 §6). Every
   * preset is checked twice: with its SoundFont samples and with their synth stand-ins.
   */
  it('a full band at 120 BPM does not clip', () => {
    const song = createSong({
      tempo: 120,
      chords: ['I7', 'vi7', 'ii7', 'V7'].map((token) => ({ token, beats: 4 })),
      tracks: [
        createTrack('chords', { id: 'c', channel: 0 }),
        createTrack('bass', { id: 'b', channel: 1 }),
        createTrack('arp', { id: 'a', channel: 2 }),
        createTrack('pad', { id: 'p', channel: 3 }),
      ],
      melody: {
        channel: 4,
        muted: false,
        notes: Array.from({ length: 32 }, (_, i) => ({
          beat: i / 2,
          length: 0.5,
          degree: ([5, 6, 7, 1] as const)[i % 4] ?? 5,
          octave: i % 4 === 3 ? 1 : 0,
          accidental: 0 as const,
        })),
      },
    });
    const spb = 60 / song.tempo;
    const roles = new Map((song.tracks ?? []).map((t) => [t.id, t.role]));
    const { events, total } = planSong(song);
    expect(new Set(events.map((e) => e.trackId)).size).toBe(5);
    expect(events.filter((e) => e.trackId === 'c' && e.start === 0)).toHaveLength(4);
    const hits = drumHits('straight', song.meter.beats, 0, total);
    for (const [preset, samples] of SOUND_PRESETS.flatMap((p) => [
      [p, true] as const,
      [p, false] as const,
    ])) {
      let worst = 0;
      for (let t = 0; t < total * spb; t += 0.005) {
        let sum = 0;
        for (const e of events) {
          const role = e.trackId === MELODY_TRACK_ID ? null : (roles.get(e.trackId) ?? 'chords');
          const choice = presetChoice(preset.id, role);
          const at = t - e.start * spb;
          if (at <= 0) continue;
          const held = e.duration * spb;
          const font = samples ? soundfont(choice) : undefined;
          if (font !== undefined) {
            const env = at < held ? 1 : Math.exp(-(at - held) / (SAMPLE_RELEASE / 4));
            sum += sampleAmplitude(font, e.velocity) * env;
            continue;
          }
          const inst = role === null ? leadFor(preset.id) : instrumentFor(preset.id, role);
          const f = midiToFrequency(e.note);
          const env = envelopeAt(inst, f, at, held);
          // The room send adds its wet share (an energy-normalised impulse) on top.
          const wet = 1 + ROOM.maxWet * (inst.room ?? 0);
          sum += noteAmplitude(inst, e.velocity, f) * env * wet;
        }
        for (const hit of hits) {
          const at = t - hit.beat * spb;
          if (at < 0 || at >= DRUM_DECAY[hit.drum]) continue;
          // Exponential decay to silence; the snare adds its triangle body (0.6).
          const body = hit.drum === 'snare' ? 1.6 : 1;
          const env = Math.exp((Math.log(0.0001) * at) / DRUM_DECAY[hit.drum]);
          sum += DRUM_PEAK[hit.drum] * hit.level * body * env;
        }
        worst = Math.max(worst, sum);
      }
      const level = worst * MIX_GAIN * MASTER_GAIN;
      const label = `${preset.id}${samples ? '' : ' (stand-ins)'}`;
      expect(level, label).toBeLessThan(1);
      // ... and loud enough to hear without turning the volume up.
      expect(level, label).toBeGreaterThan(0.3);
    }
  });
});

describe('AudioEngine', () => {
  it('stays silent without Web Audio (jsdom)', async () => {
    const engine = new AudioEngine();
    expect(await engine.start()).toBe(false);
    expect(engine.ready).toBe(false);
    expect(engine.synth).toBeNull();
    expect(engine.toPerformanceTime(1.5)).toBe(1500);
    expect(engine.sound.preset).toBe('band');
  });
});
