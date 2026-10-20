/**
 * The Sampler panel and its entry in the Band panel (docs/specs/sampler-v1.md §7–§8), in jsdom.
 * Decoding is injected (a generated buffer); nothing is played.
 */
import { createSong, createTrack } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import type { SamplerBuffer } from '../src/audio/sampler';
import { MIN_LOOP, MIN_TRIM, SAMPLER_RATE, withSample, defaultPatch } from '../src/audio/sampler';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import { MemorySampleStore } from '../src/store/samples';
import { OPEN_SAMPLER, mountBand, samplerMark } from '../src/views/band';
import {
  fromLog,
  hertzLabel,
  markerFrames,
  moveMarker,
  nearestMarker,
  noteLabel,
  secondsLabel,
  toLog,
} from '../src/views/sampler';

function tone(seconds: number, hz: number): SamplerBuffer {
  const length = Math.round(seconds * SAMPLER_RATE);
  const data = new Float32Array(length).map(
    (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLER_RATE),
  );
  return {
    numberOfChannels: 1,
    length,
    sampleRate: SAMPLER_RATE,
    duration: seconds,
    getChannelData: () => data,
  };
}

function setup() {
  const song = createSong({
    chords: [{ token: 'I', beats: 4 }],
    tracks: [
      createTrack('chords', { id: 'trk-a', channel: 0 }),
      createTrack('bass', { id: 'trk-b', channel: 1 }),
    ],
  });
  const store = new Store(initialState(song));
  const audio = new AudioEngine(null, { decodeSampler: () => Promise.resolve(tone(1, 220)) });
  void audio.samplers.attach(new MemorySampleStore());
  const audition = vi.spyOn(audio, 'audition');
  const actions = createActions(store, audio, new MidiOut(null));
  const root = document.createElement('section');
  document.body.append(root);
  mountBand(root, store, actions, null, audio.sound, null, { samplers: audio.samplers });
  const field = <T extends HTMLElement>(scope: ParentNode | null, name: string): T => {
    const el = scope?.querySelector<T>(`[data-field="${name}"]`);
    if (el === null || el === undefined) throw new Error(`no ${name}`);
    return el;
  };
  const row = (id: string) => root.querySelector<HTMLElement>(`[data-track="${id}"]`);
  const panel = () => root.querySelector<HTMLElement>('.sampler-panel');
  return { store, audio, audition, root, row, panel, field };
}

function change(el: HTMLInputElement | HTMLSelectElement, value: string, event = 'change'): void {
  el.value = value;
  el.dispatchEvent(new Event(event));
}

function dropFile(target: HTMLElement, file: File): void {
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  target.dispatchEvent(drop);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe('Band panel: Sampler entries', () => {
  it('lists the eight slots and "Sampler… ✎" in the instrument select', () => {
    const { row, field } = setup();
    const select = field<HTMLSelectElement>(row('trk-a'), 'instrument');
    const group = [...select.querySelectorAll('optgroup')].find((g) => g.label === 'Sampler');
    const values = [...(group?.querySelectorAll('option') ?? [])].map((o) => o.value);
    expect(values).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `sampler-${i + 1}`),
      OPEN_SAMPLER,
    ]);
    expect(group?.lastElementChild?.textContent).toBe('Sampler… ✎');
    expect(group?.firstElementChild?.textContent).toBe('1 · Sampler 1');
  });

  it('choosing a slot assigns it and opens the panel under the row, with the empty mark', () => {
    const { audio, row, panel, field } = setup();
    expect(panel()).toBeNull();
    change(field<HTMLSelectElement>(row('trk-a'), 'instrument'), 'sampler-3');
    expect(audio.sound.trackInstrument({ id: 'trk-a', role: 'chords' })).toBe('sampler-3');
    expect(row('trk-a')?.nextElementSibling).toBe(panel());
    expect(field<HTMLSelectElement>(panel(), 'slot').value).toBe('sampler-3');
    expect(panel()?.querySelector('.sampler-for')?.textContent).toBe('for Chords');
    const mark = field(row('trk-a'), 'loading');
    expect(mark.textContent).toBe('∅');
    expect(mark.title).toBe(samplerMark('empty').title);
    expect(field<HTMLButtonElement>(row('trk-a'), 'sampler').hidden).toBe(false);
    expect(field<HTMLButtonElement>(row('trk-b'), 'sampler').hidden).toBe(true);
  });

  it('"Sampler… ✎" gives a track slot 1 and opens it; the slot select re-assigns', () => {
    const { audio, row, panel, field } = setup();
    const select = field<HTMLSelectElement>(row('trk-b'), 'instrument');
    change(select, OPEN_SAMPLER);
    expect(audio.sound.trackInstrument({ id: 'trk-b', role: 'bass' })).toBe('sampler-1');
    expect(select.value).toBe('sampler-1');
    expect(row('trk-b')?.nextElementSibling).toBe(panel());
    change(field<HTMLSelectElement>(panel(), 'slot'), 'sampler-2');
    expect(audio.sound.trackInstrument({ id: 'trk-b', role: 'bass' })).toBe('sampler-2');
  });

  it('closes with ✕, with Escape, and when the track plays something else', () => {
    const { row, panel, field } = setup();
    const select = field<HTMLSelectElement>(row('trk-a'), 'instrument');
    change(select, 'sampler-1');
    panel()?.querySelector<HTMLButtonElement>('button[aria-label="Close the sampler"]')?.click();
    expect(panel()).toBeNull();
    field<HTMLButtonElement>(row('trk-a'), 'sampler').click();
    expect(panel()).not.toBeNull();
    panel()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel()).toBeNull();
    change(select, 'sampler-1');
    change(select, 'flute');
    expect(panel()).toBeNull();
  });

  it('opens under the melody row for the melody lane', () => {
    const { root, panel, field } = setup();
    const melody = root.querySelector<HTMLElement>('.band-melody-row');
    change(field<HTMLSelectElement>(melody, 'instrument'), 'sampler-4');
    expect(melody?.nextElementSibling).toBe(panel());
    expect(panel()?.querySelector('.sampler-for')?.textContent).toBe('for Melody');
  });
});

describe('Sampler panel', () => {
  async function loaded() {
    const s = setup();
    change(s.field<HTMLSelectElement>(s.row('trk-a'), 'instrument'), 'sampler-1');
    const p = s.panel();
    if (p === null) throw new Error('no panel');
    dropFile(p, new File([new Uint8Array(64)], 'low-a.wav', { type: 'audio/wav' }));
    await settle();
    await settle();
    return { ...s, p };
  }

  it('shows a hint without a sample', () => {
    const { row, panel, field } = setup();
    change(field<HTMLSelectElement>(row('trk-a'), 'instrument'), 'sampler-1');
    expect(panel()?.querySelector<HTMLElement>('.sampler-empty')?.hidden).toBe(false);
    expect(field<HTMLButtonElement>(panel(), 'remove').disabled).toBe(true);
    expect(field<HTMLButtonElement>(panel(), 'detect').disabled).toBe(true);
  });

  it('a dropped file loads into the slot (root detected) and never auditions', async () => {
    const { audio, audition, p, field, row } = await loaded();
    const patch = audio.samplers.patch('sampler-1');
    expect(patch.sample?.name).toBe('low-a.wav');
    expect(patch.root).toBe(57);
    expect(field(p, 'info').textContent).toBe('low-a.wav · 1.00 s');
    expect(field<HTMLInputElement>(p, 'root').value).toBe('57');
    expect(p.querySelector('.sampler-root-row .sampler-value')?.textContent).toBe('A3');
    expect(field(row('trk-a'), 'loading').textContent).toBe('');
    expect(audition).not.toHaveBeenCalled();
    // The audition strip starts at the C below the root.
    expect(p.querySelector<HTMLElement>('.sampler-key')?.dataset['note']).toBe('48');
    expect(p.querySelector('.sampler-key.root')?.getAttribute('data-note')).toBe('57');
  });

  it('shows why a file was rejected and keeps the slot', async () => {
    const s = setup();
    change(s.field<HTMLSelectElement>(s.row('trk-a'), 'instrument'), 'sampler-1');
    const p = s.panel();
    if (p === null) throw new Error('no panel');
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.wav');
    dropFile(p, big);
    await settle();
    expect(s.field(p, 'error').textContent).toMatch(/Could not load huge.wav: .*10 MB/);
    expect(s.audio.samplers.patch('sampler-1').sample).toBeNull();
  });

  it('every control edits the patch through the edit API', async () => {
    const { audio, p, field } = await loaded();
    const patch = () => audio.samplers.patch('sampler-1');
    change(field<HTMLInputElement>(p, 'root'), '64');
    expect(patch().root).toBe(64);
    change(field<HTMLInputElement>(p, 'tune'), '-12', 'input');
    change(field<HTMLInputElement>(p, 'keytrack'), '0', 'input');
    const reverse = field<HTMLInputElement>(p, 'reverse');
    reverse.checked = true;
    reverse.dispatchEvent(new Event('change'));
    const loop = field<HTMLInputElement>(p, 'loop');
    loop.checked = true;
    loop.dispatchEvent(new Event('change'));
    change(field<HTMLSelectElement>(p, 'loop-mode'), 'pingpong');
    change(field<HTMLInputElement>(p, 'crossfade'), '5', 'input');
    change(field<HTMLInputElement>(p, 'attack'), String(toLog(0.5, 0.001, 10)), 'input');
    change(field<HTMLInputElement>(p, 'sustain'), '40', 'input');
    change(field<HTMLSelectElement>(p, 'filter-type'), 'bandpass');
    change(field<HTMLInputElement>(p, 'cutoff'), String(toLog(1000, 20, 20000)), 'input');
    change(field<HTMLInputElement>(p, 'resonance'), '30', 'input');
    change(field<HTMLInputElement>(p, 'env-amount'), '-25', 'input');
    change(field<HTMLInputElement>(p, 'gain'), '-6', 'input');
    change(field<HTMLInputElement>(p, 'pan'), '50', 'input');
    change(field<HTMLInputElement>(p, 'velocity-gain'), '20', 'input');
    change(field<HTMLInputElement>(p, 'velocity-cutoff'), '70', 'input');
    change(field<HTMLInputElement>(p, 'name'), 'Low A');
    change(field<HTMLInputElement>(p, 'program'), '33');
    const r = patch();
    expect(r).toMatchObject({ tune: -12, keytrack: 0, reverse: true, gain: -6, pan: 0.5 });
    expect(r).toMatchObject({
      velocityToGain: 20,
      velocityToCutoff: 70,
      name: 'Low A',
      program: 32,
    });
    expect(r.loop).toMatchObject({ enabled: true, mode: 'pingpong', crossfade: 240 });
    expect(r.envelope.attack).toBeCloseTo(0.5, 2);
    expect(r.envelope.sustain).toBe(0.4);
    expect(r.filter.type).toBe('bandpass');
    expect(r.filter.cutoff).toBeCloseTo(1000, -1);
    expect(r.filter).toMatchObject({ resonance: 30, envAmount: -25 });
    // The slot's new name shows in the instrument selects.
    expect(field<HTMLSelectElement>(p, 'slot').selectedOptions[0]?.textContent).toBe('1 · Low A');
  });

  it('Detect sets the root again; Remove clears the sample', async () => {
    const { audio, p, field, row } = await loaded();
    audio.samplers.setRoot('sampler-1', 40);
    field<HTMLButtonElement>(p, 'detect').click();
    expect(audio.samplers.patch('sampler-1').root).toBe(57);
    field<HTMLButtonElement>(p, 'remove').click();
    await settle();
    expect(audio.samplers.patch('sampler-1').sample).toBeNull();
    expect(field(row('trk-a'), 'loading').textContent).toBe('∅');
  });

  it('a pressed key auditions the slot until it is let go', async () => {
    const { audio, audition, p } = await loaded();
    const release = vi.fn();
    audition.mockReturnValue({ release });
    const key = p.querySelector<HTMLElement>('.sampler-key[data-note="60"]');
    key?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(audition).toHaveBeenCalledWith('sampler-1', 60, 100, undefined);
    expect(key?.classList.contains('down')).toBe(true);
    key?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(audio.samplers.patch('sampler-1').root).toBe(57);
  });
});

describe('waveform helpers', () => {
  const patch = withSample(
    defaultPatch('sampler-1'),
    'sampler-1',
    {
      name: 'x',
      frames: 1000,
      sampleRate: SAMPLER_RATE,
      channels: 1,
      savedAt: 't',
    },
    60,
  );

  it('markers: trim always, loop only while the loop is on', () => {
    expect(markerFrames(patch).map((m) => m.marker)).toEqual(['start', 'end']);
    const looped = { ...patch, loop: { ...patch.loop, enabled: true } };
    expect(markerFrames(looped)).toEqual([
      { marker: 'start', frame: 0 },
      { marker: 'end', frame: 1000 },
      { marker: 'loopStart', frame: 250 },
      { marker: 'loopEnd', frame: 750 },
    ]);
    expect(nearestMarker(looped, 252, 1000)).toBe('loopStart');
    expect(nearestMarker(looped, 995, 1000)).toBe('end');
    expect(nearestMarker(looped, 500, 1000)).toBeNull();
    expect(nearestMarker({ ...looped, sample: null }, 0, 1000)).toBeNull();
  });

  it('moving a marker never passes its partner', async () => {
    const { audio } = setup();
    const file = new File([new Uint8Array(8)], 'x.wav');
    await audio.samplers.load('sampler-1', file);
    const s = audio.samplers;
    const frames = s.patch('sampler-1').sample?.frames ?? 0;
    moveMarker(s, 'sampler-1', 'start', frames);
    expect(s.patch('sampler-1').start).toBe(frames - MIN_TRIM);
    moveMarker(s, 'sampler-1', 'start', 100);
    moveMarker(s, 'sampler-1', 'end', 0);
    expect([s.patch('sampler-1').start, s.patch('sampler-1').end]).toEqual([100, 100 + MIN_TRIM]);
    moveMarker(s, 'sampler-1', 'end', frames);
    s.setLoop('sampler-1', { enabled: true, start: 1000, end: 5000 });
    moveMarker(s, 'sampler-1', 'loopStart', 9000);
    expect(s.patch('sampler-1').loop.start).toBe(5000 - MIN_LOOP);
    moveMarker(s, 'sampler-1', 'loopEnd', 0);
    expect(s.patch('sampler-1').loop.end).toBe(5000);
  });

  it('labels and the logarithmic slider scale', () => {
    expect(noteLabel(60)).toBe('C4');
    expect(noteLabel(61)).toBe('C#4');
    expect(noteLabel(21)).toBe('A0');
    expect(secondsLabel(0.012)).toBe('12 ms');
    expect(secondsLabel(1.2)).toBe('1.20 s');
    expect(hertzLabel(880)).toBe('880 Hz');
    expect(hertzLabel(12000)).toBe('12.0 kHz');
    expect(toLog(20, 20, 20000)).toBe(0);
    expect(toLog(20000, 20, 20000)).toBe(1000);
    expect(fromLog(500, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000));
    expect(fromLog(toLog(440, 20, 20000), 20, 20000)).toBeCloseTo(440, -1);
  });
});
