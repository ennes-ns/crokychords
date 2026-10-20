/**
 * Master section (docs/specs/web-instruments-v1.md, "Master"): graph routing per mode against
 * the fake context, offline sample-level models of the limiter and the soft clip, the volume
 * taper, persistence and the Band panel master row. Nothing here produces sound.
 */
import { describe, expect, it } from 'vitest';
import {
  LIMITER,
  MASTER_MODES,
  SOFTCLIP,
  VOLUME_DEFAULT,
  buildMasterBus,
  dbToGain,
  setMasterMode,
  setMasterVolume,
  softClipCurve,
  volumeGain,
} from '../src/audio/graph';
import { AudioEngine, Synth } from '../src/audio/synth';
import type { SongStorage } from '../src/persist';
import { MASTER_KEY, MasterSettings, defaultMaster, parseMaster } from '../src/persist';
import { masterControls } from '../src/views/band';
import { FakeCompressor, FakeContext, FakeGain, FakeWaveShaper } from './fakeAudio';

function memory(initial: Record<string, string> = {}): SongStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

// --- Offline models of the two protection stages (Web Audio spec behaviour) ---

/** WaveShaperNode transfer: linear interpolation over the curve, input clamped to [-1, 1]. */
function shape(curve: Float32Array, x: number): number {
  const n = curve.length;
  const v = ((n - 1) / 2) * (x + 1);
  if (v <= 0) return curve[0] ?? 0;
  if (v >= n - 1) return curve[n - 1] ?? 0;
  const k = Math.floor(v);
  const f = v - k;
  return (1 - f) * (curve[k] ?? 0) + f * (curve[k + 1] ?? 0);
}

const toDb = (gain: number): number => 20 * Math.log10(gain);

/** DynamicsCompressorNode static curve (dB in → dB out) with hard knee. */
function compressDb(db: number): number {
  return db <= LIMITER.threshold
    ? db
    : LIMITER.threshold + (db - LIMITER.threshold) / LIMITER.ratio;
}

/**
 * Steady-state limiter output for a signal of linear `peak`: compression curve, the node's
 * automatic make-up gain ((1 / curve(0 dBFS)) ^ 0.6, per the Web Audio spec) and the ceiling.
 */
function limitPeak(peak: number): number {
  const makeup = dbToGain(-compressDb(0)) ** 0.6;
  return dbToGain(compressDb(toDb(peak))) * makeup * dbToGain(LIMITER.ceiling);
}

/** One second of a 220 Hz sine at `peak`, 48 kHz. */
function sine(peak: number): Float32Array {
  const out = new Float32Array(48000);
  for (let i = 0; i < out.length; i++) out[i] = peak * Math.sin((2 * Math.PI * 220 * i) / 48000);
  return out;
}

const PLUS_6_DB = dbToGain(6);

describe('master graph (fake context)', () => {
  it('defaults to off: master gain → volume → destination, nothing in between', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx);
    expect(bus.mode).toBe('off');
    expect(ctx.route(bus.output)).toEqual(['gain', 'gain', 'destination']);
    expect(bus.output instanceof FakeGain ? bus.output.outputs : []).toEqual([bus.volume]);
    expect(bus.volume.gain.value).toBe(1);
  });

  it('limiter: threshold −3 dB, knee 0, ratio 20, 1 ms / 100 ms, −0.3 dB ceiling', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx, 'limiter');
    expect(ctx.route(bus.output)).toEqual(['gain', 'compressor', 'gain', 'gain', 'destination']);
    const limiter = ctx.of(FakeCompressor)[1];
    expect(limiter).toBe(bus.limiter);
    expect(limiter?.threshold.value).toBe(-3);
    expect(limiter?.knee.value).toBe(0);
    expect(limiter?.ratio.value).toBe(20);
    expect(limiter?.attack.value).toBe(0.001);
    expect(limiter?.release.value).toBe(0.1);
    expect(bus.ceiling.gain.value).toBeCloseTo(dbToGain(-0.3), 10);
  });

  it('soft clip: tanh wave shaper, 2x oversampling', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx, 'softclip');
    expect(ctx.route(bus.output)).toEqual(['gain', 'waveshaper', 'gain', 'destination']);
    const [shaper] = ctx.of(FakeWaveShaper);
    expect(shaper?.oversample).toBe('2x');
    expect(shaper?.curve).toEqual(softClipCurve(SOFTCLIP.drive));
  });

  it('switches modes by rewiring the master gain only', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx);
    const nodes = ctx.nodes.length;
    for (const mode of [...MASTER_MODES, 'off', 'softclip', 'limiter', 'limiter'] as const) {
      setMasterMode(bus, mode);
      expect(bus.mode).toBe(mode);
      const out = bus.output instanceof FakeGain ? bus.output.outputs : [];
      expect(out).toHaveLength(1);
      expect(ctx.route(bus.output).at(-1)).toBe('destination');
    }
    expect(ctx.nodes.length).toBe(nodes); // no new nodes per switch
    setMasterMode(bus, 'off');
    expect(ctx.route(bus.output)).toEqual(['gain', 'gain', 'destination']);
  });

  it('glides the volume to the new gain', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx, 'off', 50);
    expect(bus.volume.gain.value).toBeCloseTo(volumeGain(50));
    setMasterVolume(bus, 100, 2);
    const calls = bus.volume instanceof FakeGain ? bus.volume.gain.calls : [];
    expect(calls.at(-1)).toMatchObject({ method: 'target', value: volumeGain(100), time: 2 });
  });

  it('Synth applies the initial master state and later changes', () => {
    const ctx = new FakeContext();
    const synth = new Synth(ctx, undefined, { mode: 'softclip', volume: 40 });
    expect(synth.masterMode).toBe('softclip');
    synth.setMasterMode('limiter');
    expect(synth.masterMode).toBe('limiter');
    synth.setMasterVolume(80);
    const volume = ctx.of(FakeGain).find((g) => g.outputs[0] === ctx.destination);
    expect(volume?.gain.value).toBeCloseTo(volumeGain(40));
    expect(volume?.gain.calls.at(-1)).toMatchObject({ method: 'target', value: 1 });
  });
});

describe('volume taper', () => {
  it('is 0 at 0 %, unity at the 80 % default, +3.9 dB at 100 %, and clamps', () => {
    expect(VOLUME_DEFAULT).toBe(80);
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(80)).toBe(1);
    expect(toDb(volumeGain(100))).toBeCloseTo(3.88, 2);
    expect(volumeGain(-10)).toBe(0);
    expect(volumeGain(150)).toBe(volumeGain(100));
    expect(volumeGain(Number.NaN)).toBe(1);
    for (let p = 1; p <= 100; p++) expect(volumeGain(p)).toBeGreaterThan(volumeGain(p - 1));
  });
});

describe('offline protection models', () => {
  it('limiter keeps a +6 dB signal below 0 dBFS', () => {
    const out = limitPeak(PLUS_6_DB);
    expect(out).toBeLessThan(1);
    expect(toDb(out)).toBeLessThan(-0.3);
    // Below the threshold only make-up and ceiling apply: quiet material is not squashed.
    expect(limitPeak(0.1) / 0.1).toBeGreaterThan(1);
  });

  it('soft clip never exceeds ±1 and is monotonic', () => {
    const curve = softClipCurve();
    expect(curve.length).toBe(SOFTCLIP.points);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i] ?? 0).toBeGreaterThan(curve[i - 1] ?? 0);
    }
    expect(curve[(curve.length - 1) / 2]).toBe(0); // odd length: exact zero in the middle
    let peak = 0;
    for (const x of sine(PLUS_6_DB)) peak = Math.max(peak, Math.abs(shape(curve, x)));
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeCloseTo(Math.tanh(1), 5);
    for (let x = -3; x < 3; x += 0.01) {
      expect(shape(curve, x + 0.01)).toBeGreaterThanOrEqual(shape(curve, x));
    }
  });

  it('off is bit-identical to bypass at the default volume', () => {
    const input = sine(PLUS_6_DB);
    const gain = volumeGain(defaultMaster().volume);
    const off = input.map((x) => x * gain);
    expect(gain).toBe(1);
    expect(off).toEqual(input);
  });
});

describe('MasterSettings', () => {
  it('defaults to off / 80 % and parses field by field', () => {
    expect(defaultMaster()).toEqual({ mode: 'off', volume: 80 });
    expect(parseMaster(null)).toEqual(defaultMaster());
    expect(parseMaster('nope')).toEqual(defaultMaster());
    expect(parseMaster('7')).toEqual(defaultMaster());
    expect(parseMaster('{"mode":"limiter","volume":55}')).toEqual({ mode: 'limiter', volume: 55 });
    expect(parseMaster('{"mode":"loud","volume":"x"}')).toEqual(defaultMaster());
    expect(parseMaster('{"mode":"softclip","volume":250.4}')).toEqual({
      mode: 'softclip',
      volume: 100,
    });
  });

  it('persists across reloads and notifies on change', () => {
    const storage = memory();
    const first = new MasterSettings(storage);
    expect(first.state).toEqual(defaultMaster());
    const seen: string[] = [];
    first.subscribe((s) => seen.push(`${s.mode}/${s.volume}`));
    first.setMode('limiter');
    first.setVolume(42.6);
    first.setVolume(43); // unchanged after rounding: no event
    first.setVolume(Number.NaN);
    expect(seen).toEqual(['limiter/80', 'limiter/43']);
    expect(JSON.parse(storage.data[MASTER_KEY] ?? '{}')).toEqual({ mode: 'limiter', volume: 43 });
    expect(new MasterSettings(storage).state).toEqual({ mode: 'limiter', volume: 43 });
  });

  it('survives storage that throws', () => {
    const broken: SongStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const master = new MasterSettings(broken);
    expect(master.state).toEqual(defaultMaster());
    master.setMode('softclip');
    expect(master.state.mode).toBe('softclip');
  });

  it('is owned by the AudioEngine next to the sound settings', () => {
    const engine = new AudioEngine(memory({ [MASTER_KEY]: '{"mode":"softclip","volume":20}' }));
    expect(engine.master.state).toEqual({ mode: 'softclip', volume: 20 });
  });
});

describe('master row (Band panel)', () => {
  it('shows the settings and writes changes back', () => {
    const master = new MasterSettings(memory());
    const row = masterControls(master);
    document.body.append(row);
    const slider = row.querySelector<HTMLInputElement>('[data-field="master-volume"]');
    const select = row.querySelector<HTMLSelectElement>('[data-field="master-mode"]');
    if (slider === null || select === null) throw new Error('master row incomplete');
    expect(slider.value).toBe('80');
    expect(select.value).toBe('off');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', 'Limiter', 'Soft clip']);
    expect(row.textContent).toContain('80%');

    slider.value = '65';
    slider.dispatchEvent(new Event('input'));
    expect(master.state.volume).toBe(65);
    expect(row.textContent).toContain('65%');

    select.value = 'limiter';
    select.dispatchEvent(new Event('change'));
    expect(master.state.mode).toBe('limiter');

    master.setMode('softclip');
    expect(select.value).toBe('softclip');
    row.remove();
  });
});
