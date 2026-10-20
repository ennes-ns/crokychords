import type { Degree } from '@crokychords/core';

export type KeyAction =
  | { type: 'degree'; degree: Degree }
  | { type: 'remove' }
  | { type: 'resize'; delta: number }
  | { type: 'move'; delta: number }
  | { type: 'togglePlay' }
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
  if (mod || e.altKey) return null;

  const degree = DEGREE_KEYS[e.key];
  if (degree !== undefined && !e.shiftKey) return { type: 'degree', degree };

  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') {
    return { type: 'resize', delta: e.shiftKey ? -0.25 : -1 };
  }
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') {
    return { type: 'resize', delta: e.shiftKey ? 0.25 : 1 };
  }

  if (key === 'm') return { type: 'toggleMute' };

  switch (e.key) {
    case 'Backspace':
    case 'Delete':
      return { type: 'remove' };
    case 'ArrowLeft':
      return { type: 'move', delta: -1 };
    case 'ArrowRight':
      return { type: 'move', delta: 1 };
    case ' ':
      return { type: 'togglePlay' };
    case 'Escape':
      return { type: 'deselect' };
    default:
      return null;
  }
}
