import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import {
  FireController,
  buttonLeds,
  chordVariants,
  followScroll,
  inversionTokens,
  suggestionSlot,
} from '../src/midi/fire/controller';
import type { FireEvent } from '../src/midi/fire/protocol';
import {
  BTN_ALT,
  BTN_BANK,
  BTN_PATTERN,
  BTN_PAT_DOWN,
  BTN_REC,
  BTN_SELECT_PRESS,
  BTN_SHIFT,
  BTN_SOLO,
  BTN_PLAY,
  CC_BANK_LEDS,
  ENC_FILTER,
  ENC_PAN,
  ENC_RESONANCE,
  ENC_SELECT,
  ENC_VOLUME,
  LED_ROW,
} from '../src/midi/fire/protocol';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';

function setup(tokens: string[] = ['I', 'V', 'vi', 'IV']) {
  const song = createSong({ chords: tokens.map((token) => ({ token, beats: 4 })) });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const fire = new FireController(store, actions);
  const send = (...events: FireEvent[]) => events.forEach((e) => fire.handle(e));
  const tokensOf = () => store.state.song.chords.map((c) => `${c.token}:${c.beats}`);
  return { store, fire, send, tokensOf };
}

const pad = (row: number, col: number, down = true): FireEvent => ({ type: 'pad', row, col, down });
const tap = (row: number, col: number): FireEvent[] => [pad(row, col), pad(row, col, false)];
const btn = (note: number, down = true): FireEvent => ({ type: 'button', note, down });
const press = (note: number): FireEvent[] => [btn(note), btn(note, false)];
const turn = (encoder: number, delta: number): FireEvent => ({ type: 'turn', encoder, delta });

describe('Fire gestures', () => {
  it('tap selects a chord, tap again deselects', () => {
    const { store, send } = setup();
    send(...tap(0, 5));
    expect(store.state.selected).toBe(1);
    send(...tap(0, 6));
    expect(store.state.selected).toBeNull();
  });

  it('a palette pad replaces the selected chord, keeping its length', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(0, 4), ...tap(3, 5)); // select V, vi replaces it
    expect(tokensOf()).toEqual(['I:4', 'vi:4']);
    expect(store.state.selected).toBe(1);
  });

  it('a palette pad on the "+" slot (no chord selected) appends and stays there', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(3, 3), ...tap(3, 0)); // IV, then I
    expect(tokensOf()).toEqual(['I:4', 'V:4', 'IV:4', 'I:4']);
    expect(store.state.selected).toBeNull();
  });

  it('SHIFT + palette pad inserts after the selected chord and selects it', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(0, 0), btn(BTN_SHIFT), ...tap(3, 1), btn(BTN_SHIFT, false));
    expect(tokensOf()).toEqual(['I:4', 'ii:4', 'V:4']);
    expect(store.state.selected).toBe(1);
  });

  it('ALT + tap removes a chord', () => {
    const { send, tokensOf } = setup(['I', 'V', 'vi']);
    send(btn(BTN_ALT), ...tap(0, 4), btn(BTN_ALT, false));
    expect(tokensOf()).toEqual(['I:4', 'vi:4']);
  });

  it('hold a chord and tap a later pad: the chord ends on that beat', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(pad(0, 0), ...tap(0, 5), pad(0, 0, false));
    expect(tokensOf()).toEqual(['I:6', 'V:4']);
    expect(store.state.selected).toBe(0);
    // Already selected: holding to resize does not deselect on release.
    send(pad(0, 0), ...tap(0, 1), pad(0, 0, false));
    expect(tokensOf()).toEqual(['I:2', 'V:4']);
    expect(store.state.selected).toBe(0);
  });

  it('tapping an empty beat after the end appends the top suggestion', () => {
    const { store, send } = setup(['I']);
    send(...tap(1, 0));
    expect(store.state.song.chords).toHaveLength(2);
    expect(store.state.selected).toBeNull();
  });

  it('SELECT turns move the suggestion cursor; press inserts that suggestion', () => {
    const { store, fire, send } = setup(['I']);
    send(turn(ENC_SELECT, 1), turn(ENC_SELECT, 1), turn(ENC_SELECT, -1));
    expect(store.state.fire.cursor).toBe(1);
    const expected = fire.suggestions()[1]?.token;
    send(...press(BTN_SELECT_PRESS));
    expect(store.state.song.chords.at(-1)?.token).toBe(expected);
    expect(store.state.fire.cursor).toBe(0);
    send(...Array.from({ length: 20 }, () => turn(ENC_SELECT, -1)));
    expect(store.state.fire.cursor).toBe(0);
  });

  it('VOLUME changes the selected chord length as one undo step', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(0, 0));
    send(btn(ENC_VOLUME), turn(ENC_VOLUME, 1), turn(ENC_VOLUME, 1), btn(ENC_VOLUME, false));
    expect(tokensOf()).toEqual(['I:6', 'V:4']);
    send(btn(BTN_SHIFT), turn(ENC_VOLUME, -1), btn(BTN_SHIFT, false));
    expect(tokensOf()).toEqual(['I:5.75', 'V:4']);
    send(...press(BTN_PATTERN)); // undo the shift turn (flushed by PATTERN)
    expect(tokensOf()).toEqual(['I:6', 'V:4']);
    send(...press(BTN_PATTERN)); // undo the two-step turn at once
    expect(tokensOf()).toEqual(['I:4', 'V:4']);
    expect(store.canUndo).toBe(false);
    send(btn(BTN_SHIFT), ...press(BTN_PATTERN), btn(BTN_SHIFT, false)); // redo
    expect(tokensOf()).toEqual(['I:6', 'V:4']);
  });

  it('RESONANCE changes the tempo (SHIFT: by 5), clamped', () => {
    const { store, send } = setup();
    send(turn(ENC_RESONANCE, 1), turn(ENC_RESONANCE, 1));
    expect(store.state.song.tempo).toBe(122);
    send(btn(BTN_SHIFT), turn(ENC_RESONANCE, -1), btn(BTN_SHIFT, false));
    expect(store.state.song.tempo).toBe(117);
    send(...Array.from({ length: 300 }, () => turn(ENC_RESONANCE, 1)));
    expect(store.state.song.tempo).toBe(300);
  });

  it('SOLO buttons mute tracks; REC toggles the loop; PATTERN DOWN scrolls', () => {
    const { store, send } = setup(Array.from({ length: 14 }, () => 'I'));
    const first = store.state.song.tracks?.[0];
    send(...press(BTN_SOLO[0]));
    expect(store.state.song.tracks?.[0]?.muted).toBe(!first?.muted);
    send(...press(BTN_REC));
    expect(store.state.loop).toBe(true);
    send(...press(BTN_PAT_DOWN), ...press(BTN_PAT_DOWN));
    expect(store.state.fire.scroll).toBe(1); // 56 beats: rows 0-3, three visible
  });

  it('follows the playhead and lights the buttons', () => {
    const { store, fire, send } = setup();
    expect(followScroll({ ...store.state, playing: true, cursor: 50 })).toBe(3);
    expect(followScroll({ ...store.state, playing: true, cursor: 20 })).toBeNull();
    expect(followScroll({ ...store.state, playing: false, cursor: 50 })).toBeNull();
    send(btn(BTN_SHIFT));
    const leds = buttonLeds({ ...store.state, playing: true }, fire);
    expect(leds.get(BTN_PLAY)).toBe(2);
    expect(leds.get(BTN_SHIFT)).toBe(2);
    expect(leds.get(LED_ROW[0])).toBe(4);
  });
});

describe('Fire v2: Replace/Add mode', () => {
  it('BANK toggles the mode, shown on BANK LED 1 (Replace) or 2 (Add)', () => {
    const { store, fire, send } = setup();
    expect(store.state.fire.mode).toBe('replace');
    expect(buttonLeds(store.state, fire).get(CC_BANK_LEDS)).toBe(0x11);
    send(...press(BTN_BANK));
    expect(store.state.fire.mode).toBe('add');
    expect(buttonLeds(store.state, fire).get(CC_BANK_LEDS)).toBe(0x12);
    send(...press(BTN_BANK));
    expect(store.state.fire.mode).toBe('replace');
  });

  it('in Add mode a palette pad inserts after the selected chord and selects it', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...press(BTN_BANK), ...tap(0, 0), ...tap(3, 3), ...tap(3, 5));
    expect(tokensOf()).toEqual(['I:4', 'IV:4', 'vi:4', 'V:4']);
    expect(store.state.selected).toBe(2);
    // SHIFT does the other one: replace.
    send(btn(BTN_SHIFT), ...tap(3, 1), btn(BTN_SHIFT, false));
    expect(tokensOf()).toEqual(['I:4', 'IV:4', 'ii:4', 'V:4']);
  });

  it('in Add mode the "+" slot still appends', () => {
    const { store, send, tokensOf } = setup(['I']);
    send(...press(BTN_BANK), ...tap(3, 4));
    expect(tokensOf()).toEqual(['I:4', 'V:4']);
    expect(store.state.selected).toBeNull();
  });

  it('in Add mode SELECT press inserts the suggestion for the slot after the selection', () => {
    const { store, fire, send, tokensOf } = setup(['I', 'V', 'vi']);
    send(...tap(0, 4)); // select V
    send(...press(BTN_BANK));
    expect(suggestionSlot(store.state)).toBe(2); // suggestions follow V
    const expected = fire.suggestions()[0]?.token;
    send(...press(BTN_SELECT_PRESS));
    expect(tokensOf()).toEqual(['I:4', 'V:4', `${expected}:4`, 'vi:4']);
    expect(store.state.selected).toBe(2);
  });
});

describe('Fire v2: PAN inversion and FILTER variants', () => {
  it('lists inversions and variants the chord editor offers', () => {
    expect(inversionTokens('V', 'major')).toEqual(['V', 'V/1', 'V/2']);
    expect(inversionTokens('V7', 'major')).toEqual(['V7', 'V7/1', 'V7/2', 'V7/3']);
    expect(chordVariants('V', 'major')).toEqual([
      'V',
      'V7',
      'Vmaj7',
      'V9',
      'Vmaj9',
      'Vsus2',
      'Vsus4',
      'Vadd9',
    ]);
    expect(chordVariants('vii°', 'major').slice(0, 3)).toEqual(['vii°', 'viiø7', 'vii°7']);
    // A sus chord on a minor degree comes back to the minor triad.
    expect(chordVariants('VIsus4', 'major')[0]).toBe('vi');
    expect(chordVariants('V7(b9)', 'major')[0]).toBe('V7(b9)');
  });

  it('PAN steps through inversions as one undo step per touch', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(0, 4));
    send(btn(ENC_PAN), turn(ENC_PAN, 1), turn(ENC_PAN, 1), turn(ENC_PAN, 1));
    expect(tokensOf()).toEqual(['I:4', 'V/2:4']); // clamped: a triad has no third inversion
    send(btn(ENC_PAN, false));
    send(...press(BTN_PATTERN));
    expect(tokensOf()).toEqual(['I:4', 'V:4']);
    expect(store.canUndo).toBe(false);
  });

  it('FILTER steps through variants as one undo step per touch', () => {
    const { store, send, tokensOf } = setup(['I', 'V']);
    send(...tap(0, 4));
    send(btn(ENC_FILTER), turn(ENC_FILTER, 1), turn(ENC_FILTER, 1), turn(ENC_FILTER, -1));
    send(btn(ENC_FILTER, false));
    expect(tokensOf()).toEqual(['I:4', 'V7:4']);
    send(btn(ENC_FILTER), turn(ENC_FILTER, -1), btn(ENC_FILTER, false));
    expect(tokensOf()).toEqual(['I:4', 'V:4']);
    send(...press(BTN_PATTERN));
    expect(tokensOf()).toEqual(['I:4', 'V7:4']);
    send(...press(BTN_PATTERN));
    expect(tokensOf()).toEqual(['I:4', 'V:4']);
    expect(store.canUndo).toBe(false);
  });

  it('PAN and FILTER do nothing on the "+" slot; the touched knob is tracked', () => {
    const { fire, send, tokensOf } = setup(['I']);
    send(btn(ENC_FILTER), turn(ENC_FILTER, 1));
    expect(fire.touched).toBe(ENC_FILTER);
    send(btn(ENC_FILTER, false));
    expect(fire.touched).toBeNull();
    expect(tokensOf()).toEqual(['I:4']);
  });
});
