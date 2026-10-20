import { createSong, createTrack } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { SoundStorage } from '../src/audio/sound';
import {
  SOUND_KEY,
  SoundSettings,
  customTracks,
  defaultSound,
  parseSound,
  trackPrograms,
} from '../src/audio/sound';

/** Settings with only a preset and drums, as saved before per-track instruments existed. */
const plain = { instruments: {}, melody: { octave: 0, velocity: 100 } };

function memory(initial: Record<string, string> = {}): SoundStorage & {
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

describe('parseSound', () => {
  it('defaults to Band with straight drums', () => {
    expect(defaultSound()).toEqual({ preset: 'band', drums: 'straight', ...plain });
    expect(parseSound(null)).toEqual(defaultSound());
    expect(parseSound('not json')).toEqual(defaultSound());
    expect(parseSound('42')).toEqual(defaultSound());
  });

  it('keeps valid fields and replaces invalid ones', () => {
    expect(parseSound('{"preset":"pad","drums":"ballad"}')).toEqual({
      preset: 'pad',
      drums: 'ballad',
      ...plain,
    });
    expect(parseSound('{"preset":"pad","drums":"polka"}')).toEqual({
      preset: 'pad',
      drums: 'none',
      ...plain,
    });
    expect(parseSound('{"preset":"organ","drums":"none"}')).toEqual({
      preset: 'band',
      drums: 'none',
      ...plain,
    });
  });

  it('keeps valid instrument choices and melody settings, drops the rest one by one', () => {
    const json = JSON.stringify({
      preset: 'chamber',
      drums: 'none',
      instruments: { 'trk-a': 'flute', 'trk-b': 'theremin', melody: 'pad', '': 'bass', x: 3 },
      melody: { octave: -2, velocity: 64 },
    });
    expect(parseSound(json)).toEqual({
      preset: 'chamber',
      drums: 'none',
      instruments: { 'trk-a': 'flute', melody: 'pad' },
      melody: { octave: -2, velocity: 64 },
    });
    const bad = parseSound('{"instruments":[1],"melody":{"octave":3,"velocity":0.5}}');
    expect(bad.instruments).toEqual({});
    expect(bad.melody).toEqual({ octave: 0, velocity: 100 });
    expect(parseSound('{"melody":{"octave":1}}').melody).toEqual({ octave: 1, velocity: 100 });
  });
});

describe('per-track instruments', () => {
  const song = createSong({
    tracks: [
      createTrack('chords', { id: 'trk-a', channel: 0 }),
      createTrack('bass', { id: 'trk-b', channel: 1 }),
    ],
  });

  it('follow the preset until a track gets its own; a preset choice clears them', () => {
    const sound = new SoundSettings();
    expect(sound.trackInstrument({ id: 'trk-a', role: 'chords' })).toBe('acoustic_grand_piano');
    expect(sound.trackInstrument({ id: 'trk-b', role: 'bass' })).toBe('acoustic_bass');
    expect(sound.melodyInstrument()).toBe('lead');
    expect(customTracks(sound.state, song)).toEqual([]);

    sound.setInstrument('trk-b', 'bass', 'synth_bass_1');
    sound.setInstrument('melody', null, 'flute');
    expect(sound.trackInstrument({ id: 'trk-b', role: 'bass' })).toBe('synth_bass_1');
    expect(sound.melodyInstrument()).toBe('flute');
    expect(customTracks(sound.state, song)).toEqual(['trk-b', 'melody']);
    // Choosing the preset's own instrument again removes the entry.
    sound.setInstrument('trk-b', 'bass', 'acoustic_bass');
    expect(sound.state.instruments).toEqual({ melody: 'flute' });

    sound.setPreset('chamber');
    expect(sound.state.instruments).toEqual({});
    expect(sound.trackInstrument({ id: 'trk-a', role: 'chords' })).toBe('harpsichord');
    expect(sound.melodyInstrument()).toBe('clarinet');
  });

  it('ignore choices for tracks of other songs when marking the preset custom', () => {
    const sound = new SoundSettings();
    sound.setInstrument('trk-zz', 'chords', 'flute');
    expect(customTracks(sound.state, song)).toEqual([]);
  });

  it('give the melody its octave shift and velocity, clamped', () => {
    const sound = new SoundSettings();
    expect(sound.voice('melody', null)).toEqual({
      instrument: 'lead',
      transpose: 0,
      velocity: 100,
    });
    sound.setMelodyOctave(5);
    sound.setMelodyVelocity(0);
    expect(sound.voice('melody', null)).toEqual({ instrument: 'lead', transpose: 24, velocity: 1 });
    sound.setMelodyOctave(-1.4);
    sound.setMelodyVelocity(Number.NaN);
    expect(sound.melody).toEqual({ octave: -1, velocity: 1 });
    expect(sound.voice('trk-a', 'chords')).toEqual({
      instrument: 'acoustic_grand_piano',
      transpose: 0,
    });
  });

  it('map every track and the melody to a General MIDI program', () => {
    const sound = new SoundSettings();
    sound.setInstrument('trk-b', 'bass', 'electric_bass_finger');
    expect(trackPrograms(sound.state, song)).toEqual({ 'trk-a': 0, 'trk-b': 33, melody: 80 });
    sound.setPreset('chamber');
    expect(trackPrograms(sound.state, song)).toEqual({ 'trk-a': 6, 'trk-b': 45, melody: 71 });
  });
});

describe('SoundSettings', () => {
  it('loads, saves and notifies', () => {
    const storage = memory({ [SOUND_KEY]: '{"preset":"piano","drums":"none"}' });
    const sound = new SoundSettings(storage);
    expect(sound.state).toEqual({ preset: 'piano', drums: 'none', ...plain });
    const seen: string[] = [];
    const off = sound.subscribe((s) => seen.push(`${s.preset}/${s.drums}`));

    sound.setPreset('band'); // also resets the drums to the preset's default
    expect(sound.drums).toBe('straight');
    sound.setDrums('half-time');
    sound.setDrums('half-time'); // unchanged: no event
    expect(seen).toEqual(['band/straight', 'band/half-time']);
    expect(JSON.parse(storage.data[SOUND_KEY] ?? '{}')).toEqual({
      preset: 'band',
      drums: 'half-time',
      ...plain,
    });
    off();
    sound.setPreset('pad');
    expect(seen).toHaveLength(2);
    expect(new SoundSettings(storage).state).toEqual({ preset: 'pad', drums: 'none', ...plain });
  });

  it('works without storage and survives a throwing one', () => {
    const sound = new SoundSettings();
    sound.setPreset('pad');
    expect(sound.preset).toBe('pad');
    const broken: SoundStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const b = new SoundSettings(broken);
    expect(b.state).toEqual(defaultSound());
    b.setDrums('ballad');
    expect(b.drums).toBe('ballad');
  });
});
