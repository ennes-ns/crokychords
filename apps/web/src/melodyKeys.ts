/**
 * Melody-lane shortcuts (docs/specs/melody-v1.md, B3). Asked before the chord shortcuts in
 * `keyboard.ts`; returns null for every key the melody lane leaves to them (Space, undo/redo,
 * `M`, Shift+digits, ...).
 */
import type { Degree } from '@crokychords/core';
import type { KeyLike } from './keyboard';

export type Focus = 'chords' | 'melody';

export type MelodyKeyAction =
  | { type: 'toggleFocus' }
  | { type: 'leave' }
  | { type: 'place'; degree: Degree }
  | { type: 'cursor'; delta: number }
  | { type: 'home' }
  | { type: 'move'; delta: number }
  | { type: 'step'; delta: number }
  | { type: 'octave'; delta: number }
  | { type: 'length'; delta: number }
  | { type: 'accidental'; accidental: -1 | 1 }
  | { type: 'remove' }
  | { type: 'grid' };

const DEGREE_KEYS: Record<string, Degree> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };

/** The melody action for a key press while `focus` is active, or null. */
export function melodyKeyAction(e: KeyLike, focus: Focus): MelodyKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'n' && !e.shiftKey) return { type: 'toggleFocus' };
  if (focus !== 'melody') return null;

  // '+' is Shift+'=' on most layouts, so these accept Shift.
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return { type: 'octave', delta: 1 };
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
    return { type: 'octave', delta: -1 };
  }
  // Shift+digit stays with the chord lane (replace the selected chord).
  if (e.shiftKey) {
    if (e.key === 'ArrowLeft') return { type: 'move', delta: -1 };
    if (e.key === 'ArrowRight') return { type: 'move', delta: 1 };
    return null;
  }

  const degree = DEGREE_KEYS[e.key];
  if (degree !== undefined) return { type: 'place', degree };
  if (e.code === 'BracketLeft' || e.key === '[') return { type: 'length', delta: -1 };
  if (e.code === 'BracketRight' || e.key === ']') return { type: 'length', delta: 1 };

  switch (key) {
    case 'b':
      return { type: 'accidental', accidental: -1 };
    case 's':
      return { type: 'accidental', accidental: 1 };
    case 'g':
      return { type: 'grid' };
    case 'ArrowLeft':
      return { type: 'cursor', delta: -1 };
    case 'ArrowRight':
      return { type: 'cursor', delta: 1 };
    case 'ArrowUp':
      return { type: 'step', delta: 1 };
    case 'ArrowDown':
      return { type: 'step', delta: -1 };
    case 'Home':
      return { type: 'home' };
    case 'Backspace':
    case 'Delete':
      return { type: 'remove' };
    case 'Escape':
      return { type: 'leave' };
    default:
      return null;
  }
}
