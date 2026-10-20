/** Shared by the command tests: songs from the fixture's short form and a silent host. */
import type { MelodyAccidental, Mode } from '@crokychords/core';
import { createSong, defaultMelody } from '@crokychords/core';
import type { CrokyHost } from '../src/assistant/croky';

export interface SongSpec {
  key?: { tonic: string; mode: string };
  tempo?: number;
  meter?: number[];
  chords?: (string | number)[][];
  notes?: number[][];
}

export function songFrom(spec: SongSpec) {
  const [beats, unit] = spec.meter ?? [4, 4];
  return createSong({
    ...(spec.key === undefined
      ? {}
      : { key: { tonic: spec.key.tonic, mode: spec.key.mode as Mode } }),
    ...(spec.tempo === undefined ? {} : { tempo: spec.tempo }),
    meter: { beats: beats ?? 4, unit: unit ?? 4 },
    chords: (spec.chords ?? []).map(([token, b]) => ({ token: String(token), beats: Number(b) })),
    melody: {
      ...defaultMelody(),
      notes: (spec.notes ?? []).map(([beat, length, degree, octave, accidental]) => ({
        beat: beat ?? 0,
        length: length ?? 1,
        degree: (degree ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        octave: octave ?? 0,
        accidental: (accidental ?? 0) as MelodyAccidental,
      })),
    },
  });
}

export const quietHost: CrokyHost = {
  env: { isInstrument: (id) => id === 'piano' || id === 'lead' },
  play: () => Promise.resolve(true),
  stop: () => undefined,
  audition: () => undefined,
  setInstrument: () => undefined,
  midi: () => ({ bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64]), fileName: 'x.mid' }),
  save: () => Promise.resolve(),
};
