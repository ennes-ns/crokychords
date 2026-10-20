import type { Command } from '@crokychords/core';
import { createSong, parseCommand } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { EngineState } from '../src/assistant/engine';
import { step } from '../src/assistant/engine';
import { quietHost, songFrom } from './commandHelpers';

function state(chords: [string, number][] = [], selected: number | null = null): EngineState {
  return {
    song: songFrom({ chords }),
    selected,
    loop: false,
    loopRange: null,
    past: [],
    future: [],
  };
}

function cmd(value: unknown): Command {
  const parsed = parseCommand(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.command;
}

function run(s: EngineState, value: unknown) {
  const r = step(s, cmd(value), quietHost.env);
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.path}: ${r.error.message}`);
  return r;
}

const ABC: [string, number][] = [
  ['I', 4],
  ['V', 4],
  ['vi', 4],
];

describe('command engine', () => {
  it('keeps the selection on the same chord when chords are inserted or deleted before it', () => {
    expect(run(state(ABC, 1), { op: 'insertChord', at: 0, token: 'IV' }).state.selected).toBe(2);
    expect(run(state(ABC, 1), { op: 'insertChord', at: 2, token: 'IV' }).state.selected).toBe(1);
    expect(run(state(ABC, 2), { op: 'deleteChord', index: 0 }).state.selected).toBe(1);
    expect(run(state(ABC, 1), { op: 'deleteChord', index: 1 }).state.selected).toBe(0);
    expect(run(state(ABC, 0), { op: 'deleteChord', index: 2 }).state.selected).toBe(0);
    expect(run(state([['I', 4]], 0), { op: 'deleteChord', index: 0 }).state.selected).toBeNull();
  });

  it('records history only for real changes, and caps it', () => {
    const s = state(ABC);
    expect(run(s, { op: 'setTempo', bpm: 120 }).state.past).toHaveLength(0);
    let cur = s;
    for (let i = 0; i < 60; i++) cur = run(cur, { op: 'setTempo', bpm: 21 + i }).state;
    expect(cur.past).toHaveLength(50);
    const undone = run(cur, { op: 'undo' }).state;
    expect(undone.song.tempo).toBe(79);
    expect(run(undone, { op: 'redo' }).state.song.tempo).toBe(80);
    expect(run(state(), { op: 'redo' }).result).toEqual({ op: 'redo', changed: false });
  });

  it('a role change keeps the track’s pattern and octave', () => {
    const r = run(state(ABC), { op: 'setTrack', track: 1, role: 'pad' });
    const bass = r.state.song.tracks?.[1];
    expect(bass).toMatchObject({ role: 'pad', octave: 2, pattern: { id: 'bass-quarters' } });
  });

  it('tracks resolve by id as well as by index; removing by id', () => {
    const s = state(ABC);
    const id = s.song.tracks?.[2]?.id ?? '';
    const r = run(s, { op: 'removeTrack', track: id });
    expect(r.state.song.tracks?.map((t) => t.name)).toEqual(['Chords', 'Bass']);
    const added = run(s, { op: 'addTrack', role: 'arp' });
    expect(added.result.track).toBe(added.state.song.tracks?.[3]?.id);
  });

  it('newSong stops playback and empties chords and melody', () => {
    const r = run(state(ABC, 1), { op: 'newSong' });
    expect(r.effects).toEqual([{ type: 'stop' }]);
    expect(r.state.song.chords).toEqual([]);
    expect(r.state.selected).toBeNull();
  });

  it('transport and file commands only produce effects', () => {
    const s = state(ABC);
    expect(run(s, { op: 'play', from: 4 }).effects).toEqual([{ type: 'play', from: 4 }]);
    expect(run(s, { op: 'play' }).effects).toEqual([{ type: 'play' }]);
    expect(run(s, { op: 'audition', token: 'ii' }).effects).toEqual([
      { type: 'audition', token: 'ii' },
    ]);
    expect(run(s, { op: 'exportMidi' }).state).toBe(s);
    expect(run(s, { op: 'setInstrument', track: 0, instrument: 'piano' }).effects).toEqual([
      { type: 'setInstrument', track: s.song.tracks?.[0]?.id, role: 'chords', instrument: 'piano' },
    ]);
  });

  it('setChordBeats and deleteNote report missing targets as not_found', () => {
    const missing = step(
      state(ABC),
      cmd({ op: 'setChordBeats', index: 3, beats: 1 }),
      quietHost.env,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found', path: 'index' } });
    const note = step(state(), cmd({ op: 'deleteNote', index: 0 }), quietHost.env);
    expect(note).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('never changes the input state', () => {
    const s = state(ABC, 0);
    const frozen = JSON.stringify(s);
    run(s, { op: 'setChords', chords: [{ token: 'ii', beats: 4 }] });
    run(s, { op: 'addNote', beat: 0, length: 1, degree: 1 });
    run(s, { op: 'setTrack', track: 0, muted: true });
    expect(JSON.stringify(s)).toBe(frozen);
    expect(createSong().chords).toEqual([]);
  });
});
