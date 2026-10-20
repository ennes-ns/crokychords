import { describe, expect, it } from 'vitest';
import type { KeyLike } from '../src/keyboard';
import { keyAction } from '../src/keyboard';
import { melodyKeyAction } from '../src/melodyKeys';

function key(k: string, extra: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...extra,
  };
}

describe('melodyKeyAction', () => {
  it('only takes N while the chords have focus', () => {
    expect(melodyKeyAction(key('n'), 'chords')).toEqual({ type: 'toggleFocus' });
    expect(melodyKeyAction(key('N', { shiftKey: true }), 'chords')).toBeNull();
    for (const k of ['1', 'ArrowLeft', '[', 'Backspace', 'b', 'g', '+', 'Escape']) {
      expect(melodyKeyAction(key(k), 'chords')).toBeNull();
    }
    // N is free in the chord key map, so the two never compete.
    expect(keyAction(key('n'))).toBeNull();
  });

  it('maps the melody keys while the melody has focus', () => {
    const m = (k: string, extra: Partial<KeyLike> = {}) => melodyKeyAction(key(k, extra), 'melody');
    expect(m('n')).toEqual({ type: 'toggleFocus' });
    expect(m('5')).toEqual({ type: 'place', degree: 5 });
    expect(m('ArrowLeft')).toEqual({ type: 'cursor', delta: -1 });
    expect(m('ArrowRight')).toEqual({ type: 'cursor', delta: 1 });
    expect(m('ArrowLeft', { shiftKey: true })).toEqual({ type: 'move', delta: -1 });
    expect(m('ArrowRight', { shiftKey: true })).toEqual({ type: 'move', delta: 1 });
    expect(m('ArrowUp')).toEqual({ type: 'step', delta: 1 });
    expect(m('ArrowDown')).toEqual({ type: 'step', delta: -1 });
    expect(m('+', { shiftKey: true })).toEqual({ type: 'octave', delta: 1 });
    expect(m('=')).toEqual({ type: 'octave', delta: 1 });
    expect(m('-')).toEqual({ type: 'octave', delta: -1 });
    expect(m('x', { code: 'NumpadAdd' })).toEqual({ type: 'octave', delta: 1 });
    expect(m('[', { code: 'BracketLeft' })).toEqual({ type: 'length', delta: -1 });
    expect(m(']')).toEqual({ type: 'length', delta: 1 });
    expect(m('b')).toEqual({ type: 'accidental', accidental: -1 });
    expect(m('s')).toEqual({ type: 'accidental', accidental: 1 });
    expect(m('g')).toEqual({ type: 'grid' });
    expect(m('Home')).toEqual({ type: 'home' });
    expect(m('Backspace')).toEqual({ type: 'remove' });
    expect(m('Delete')).toEqual({ type: 'remove' });
    expect(m('Escape')).toEqual({ type: 'leave' });
  });

  it('leaves the shared and the chord-replace keys to the chord key map', () => {
    const m = (k: string, extra: Partial<KeyLike> = {}) => melodyKeyAction(key(k, extra), 'melody');
    expect(m(' ')).toBeNull();
    expect(m('m')).toBeNull();
    expect(m('z', { ctrlKey: true })).toBeNull();
    expect(m('y', { ctrlKey: true })).toBeNull();
    expect(m('z', { metaKey: true, shiftKey: true })).toBeNull();
    expect(m('8')).toBeNull();
    expect(m('n', { altKey: true })).toBeNull();
    // Shift+digit (replace the selected chord) and Shift+[ never reach the melody.
    for (const k of ['!', '@', '#', '3'])
      expect(m(k, { shiftKey: true, code: 'Digit3' })).toBeNull();
    expect(m('{', { shiftKey: true, code: 'BracketLeft' })).toBeNull();
  });
});
