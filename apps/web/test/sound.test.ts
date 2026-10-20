import { describe, expect, it } from 'vitest';
import type { SoundStorage } from '../src/audio/sound';
import { SOUND_KEY, SoundSettings, defaultSound, parseSound } from '../src/audio/sound';

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
    expect(defaultSound()).toEqual({ preset: 'band', drums: 'straight' });
    expect(parseSound(null)).toEqual(defaultSound());
    expect(parseSound('not json')).toEqual(defaultSound());
    expect(parseSound('42')).toEqual(defaultSound());
  });

  it('keeps valid fields and replaces invalid ones', () => {
    expect(parseSound('{"preset":"pad","drums":"ballad"}')).toEqual({
      preset: 'pad',
      drums: 'ballad',
    });
    expect(parseSound('{"preset":"pad","drums":"polka"}')).toEqual({
      preset: 'pad',
      drums: 'none',
    });
    expect(parseSound('{"preset":"organ","drums":"none"}')).toEqual({
      preset: 'band',
      drums: 'none',
    });
  });
});

describe('SoundSettings', () => {
  it('loads, saves and notifies', () => {
    const storage = memory({ [SOUND_KEY]: '{"preset":"piano","drums":"none"}' });
    const sound = new SoundSettings(storage);
    expect(sound.state).toEqual({ preset: 'piano', drums: 'none' });
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
    });
    off();
    sound.setPreset('pad');
    expect(seen).toHaveLength(2);
    expect(new SoundSettings(storage).state).toEqual({ preset: 'pad', drums: 'none' });
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
