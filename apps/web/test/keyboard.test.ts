import { describe, expect, it } from 'vitest';
import type { KeyLike } from '../src/keyboard';
import { keyAction } from '../src/keyboard';

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: '',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

describe('keyAction', () => {
  it('maps 1–7 to diatonic degrees', () => {
    expect(keyAction(press('1'))).toEqual({ type: 'degree', degree: 1 });
    expect(keyAction(press('7'))).toEqual({ type: 'degree', degree: 7 });
    expect(keyAction(press('8'))).toBeNull();
    expect(keyAction(press('4', { ctrlKey: true }))).toBeNull();
  });

  it('maps Shift+1–7 to replacing with that degree (by physical key)', () => {
    const shift = (key: string, code: string) => press(key, { code, shiftKey: true });
    expect(keyAction(shift('!', 'Digit1'))).toEqual({ type: 'replaceDegree', degree: 1 });
    expect(keyAction(shift('&', 'Digit7'))).toEqual({ type: 'replaceDegree', degree: 7 });
    expect(keyAction(shift('4', 'Numpad4'))).toEqual({ type: 'replaceDegree', degree: 4 });
    expect(keyAction(shift('*', 'Digit8'))).toBeNull();
    expect(keyAction(press('!', { code: 'Digit1', shiftKey: true, ctrlKey: true }))).toBeNull();
  });

  it('maps brackets to resizing (Shift for quarter beats)', () => {
    expect(keyAction(press('[', { code: 'BracketLeft' }))).toEqual({ type: 'resize', delta: -1 });
    expect(keyAction(press(']', { code: 'BracketRight' }))).toEqual({ type: 'resize', delta: 1 });
    expect(keyAction(press('{', { code: 'BracketLeft', shiftKey: true }))).toEqual({
      type: 'resize',
      delta: -0.25,
    });
    expect(keyAction(press('}', { shiftKey: true }))).toEqual({ type: 'resize', delta: 0.25 });
  });

  it('maps editing and transport keys', () => {
    expect(keyAction(press('Backspace'))).toEqual({ type: 'remove' });
    expect(keyAction(press('Delete'))).toEqual({ type: 'remove' });
    expect(keyAction(press('ArrowLeft'))).toEqual({ type: 'move', delta: -1 });
    expect(keyAction(press('ArrowRight'))).toEqual({ type: 'move', delta: 1 });
    expect(keyAction(press(' '))).toEqual({ type: 'togglePlay' });
    expect(keyAction(press('Escape'))).toEqual({ type: 'deselect' });
    expect(keyAction(press('a'))).toBeNull();
  });

  it('maps Space to play/stop, Shift+Space to play from the selection', () => {
    expect(keyAction(press(' ', { code: 'Space' }))).toEqual({ type: 'togglePlay' });
    expect(keyAction(press(' ', { code: 'Space', shiftKey: true }))).toEqual({
      type: 'togglePlay',
      fromSelection: true,
    });
    expect(keyAction(press(' ', { code: 'Space', ctrlKey: true }))).toBeNull();
  });

  it('maps L to loop on/off and Alt+[ / Alt+] to loop points (by physical key)', () => {
    expect(keyAction(press('l'))).toEqual({ type: 'toggleLoop' });
    expect(keyAction(press('L', { shiftKey: true }))).toEqual({ type: 'toggleLoop' });
    expect(keyAction(press('“', { code: 'BracketLeft', altKey: true }))).toEqual({
      type: 'loopStart',
    });
    expect(keyAction(press(']', { code: 'BracketRight', altKey: true }))).toEqual({
      type: 'loopEnd',
    });
    // Plain brackets still resize the selected chord.
    expect(keyAction(press('[', { code: 'BracketLeft' }))).toEqual({ type: 'resize', delta: -1 });
    expect(keyAction(press('l', { altKey: true }))).toBeNull();
  });

  it('maps M to muting the selected track', () => {
    expect(keyAction(press('m'))).toEqual({ type: 'toggleMute' });
    expect(keyAction(press('M', { shiftKey: true }))).toEqual({ type: 'toggleMute' });
    expect(keyAction(press('m', { ctrlKey: true }))).toBeNull();
  });

  it('maps undo and redo on Ctrl and Cmd', () => {
    expect(keyAction(press('z', { ctrlKey: true }))).toEqual({ type: 'undo' });
    expect(keyAction(press('z', { metaKey: true }))).toEqual({ type: 'undo' });
    expect(keyAction(press('Z', { metaKey: true, shiftKey: true }))).toEqual({ type: 'redo' });
    expect(keyAction(press('y', { ctrlKey: true }))).toEqual({ type: 'redo' });
    expect(keyAction(press('z', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(keyAction(press('c', { ctrlKey: true }))).toBeNull();
  });
});
