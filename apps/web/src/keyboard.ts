import type { Degree } from '@crokychords/core';

/** True for the Space key (`key` is ' ', `code` is 'Space'). */
export function isSpaceKey(e: Pick<KeyLike, 'key' | 'code'>): boolean {
  return e.key === ' ' || e.code === 'Space';
}

export type KeyAction =
  | { type: 'degree'; degree: Degree }
  | { type: 'replaceDegree'; degree: Degree }
  | { type: 'remove' }
  | { type: 'resize'; delta: number }
  | { type: 'move'; delta: number }
  /** Play from the start (of the loop when looping); `fromSelection` plays from the selection. */
  | { type: 'togglePlay'; fromSelection?: boolean }
  | { type: 'toggleLoop' }
  | { type: 'loopStart' }
  | { type: 'loopEnd' }
  | { type: 'deselect' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'toggleMute' };

export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const DEGREE_KEYS: Record<string, Degree> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
};

/** Map a key press to an editor action (editor shortcuts), or null. */
export function keyAction(e: KeyLike): KeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
    if (key === 'y' && !e.shiftKey) return { type: 'redo' };
    return null;
  }
  // Alt+[ / Alt+]: loop points at the selection ([ and ] alone resize the selected chord).
  // Match the physical key: Alt changes `key` on some layouts (macOS: '“', '‘').
  if (e.altKey && !mod && !e.shiftKey) {
    if (e.code === 'BracketLeft') return { type: 'loopStart' };
    if (e.code === 'BracketRight') return { type: 'loopEnd' };
  }
  if (mod || e.altKey) return null;

  if (isSpaceKey(e)) {
    return e.shiftKey ? { type: 'togglePlay', fromSelection: true } : { type: 'togglePlay' };
  }

  const degree = DEGREE_KEYS[e.key];
  if (degree !== undefined && !e.shiftKey) return { type: 'degree', degree };
  // Shift+digit: `key` is layout-dependent ('!', '@', ...), so match the physical key.
  const digit = /^(?:Digit|Numpad)([1-7])$/.exec(e.code)?.[1];
  const shifted = e.shiftKey && digit !== undefined ? DEGREE_KEYS[digit] : undefined;
  if (shifted !== undefined) return { type: 'replaceDegree', degree: shifted };

  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') {
    return { type: 'resize', delta: e.shiftKey ? -0.25 : -1 };
  }
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') {
    return { type: 'resize', delta: e.shiftKey ? 0.25 : 1 };
  }

  if (key === 'm') return { type: 'toggleMute' };
  if (key === 'l') return { type: 'toggleLoop' };

  switch (e.key) {
    case 'Backspace':
    case 'Delete':
      return { type: 'remove' };
    case 'ArrowLeft':
      return { type: 'move', delta: -1 };
    case 'ArrowRight':
      return { type: 'move', delta: 1 };
    case 'Escape':
      return { type: 'deselect' };
    default:
      return null;
  }
}
