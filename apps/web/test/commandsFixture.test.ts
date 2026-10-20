/**
 * The command contract's scenarios (packages/core/test/fixtures/commands-v1.json), run through
 * `window.croky` on a real store. The terminal app runs the same file (crates/croky-tui).
 */
import { defaultMelody } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import fixture from '../../../packages/core/test/fixtures/commands-v1.json';
import { createCroky } from '../src/assistant/croky';
import { Store, initialState } from '../src/state';
import type { SongSpec } from './commandHelpers';
import { quietHost, songFrom } from './commandHelpers';

interface Expect {
  ok?: boolean;
  applied?: number;
  error?: { code: string; index: number; path: string };
  results?: Record<string, unknown>[];
  chords?: (string | number)[][];
  selected?: number | null;
  key?: { tonic: string; mode: string };
  tempo?: number;
  meter?: number[];
  title?: string;
  notes?: number[][];
  melody?: { channel: number; muted: boolean };
  tracks?: Record<string, unknown>[];
  loop?: { enabled: boolean; range: { start: number; end: number } | null };
}

describe('command fixture', () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      const store = new Store(initialState(songFrom(scenario.song as SongSpec)));
      const croky = createCroky(store, quietHost);
      for (const [n, s] of scenario.steps.entries()) {
        const where = `${scenario.name}, step ${n}`;
        const stepSpec = s as { undo?: string; commands: unknown[]; expect: Expect };
        const options = stepSpec.undo === 'batch' ? { undo: 'batch' as const } : {};
        const result = await croky.applyCommands(stepSpec.commands, options);
        const want = stepSpec.expect;
        const song = croky.getSong();
        const state = croky.getState();
        if (want.ok !== undefined) expect(result.ok, where).toBe(want.ok);
        if (want.applied !== undefined) expect(result.applied, where).toBe(want.applied);
        if (want.error !== undefined) {
          expect(result.ok ? null : result.error, where).toMatchObject(want.error);
        }
        if (want.results !== undefined) {
          expect(result.results.length, where).toBe(want.results.length);
          want.results.forEach((r, i) => expect(result.results[i], where).toMatchObject(r));
        }
        if (want.chords !== undefined) {
          expect(
            song.chords.map((c) => [c.token, c.beats]),
            where,
          ).toEqual(want.chords);
        }
        if (want.selected !== undefined) expect(state.selected, where).toBe(want.selected);
        if (want.key !== undefined) expect(song.key, where).toEqual(want.key);
        if (want.tempo !== undefined) expect(song.tempo, where).toBe(want.tempo);
        if (want.meter !== undefined) {
          expect([song.meter.beats, song.meter.unit], where).toEqual(want.meter);
        }
        if (want.title !== undefined) expect(song.title, where).toBe(want.title);
        const melody = song.melody ?? defaultMelody();
        if (want.notes !== undefined) {
          const notes = melody.notes.map((x) => [
            x.beat,
            x.length,
            x.degree,
            x.octave,
            x.accidental,
          ]);
          expect(notes, where).toEqual(want.notes);
        }
        if (want.melody !== undefined) {
          expect({ channel: melody.channel, muted: melody.muted }, where).toEqual(want.melody);
        }
        if (want.tracks !== undefined) {
          const tracks = (song.tracks ?? []).map((t) => ({ ...t, pattern: t.pattern.id }));
          expect(tracks.length, where).toBe(want.tracks.length);
          want.tracks.forEach((t, i) => expect(tracks[i], where).toMatchObject(t));
        }
        if (want.loop !== undefined) expect(state.loop, where).toEqual(want.loop);
      }
    });
  }
});
