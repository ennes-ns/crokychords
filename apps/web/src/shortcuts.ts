/**
 * The global keyboard handler: editor shortcuts outside form controls, and Space as play/stop
 * everywhere except while typing (docs/specs/loop-v1.md, "Space").
 */
import { isEditableTarget, isTypingTarget } from './dom';
import type { KeyAction } from './keyboard';
import { isSpaceKey, keyAction } from './keyboard';

/** Marks the element (the chord grid) inside which Tab / Shift+Tab move the chord selection. */
export const TAB_SLOTS_ATTR = 'data-tab-slots';

/** Targets that handle Enter themselves (a focused button, link or form control). */
function isControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a[href], input, select, textarea, summary') !== null
  );
}

function inTabSlots(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${TAB_SLOTS_ATTR}]`) !== null;
}

/**
 * Listen on `target` (the window) and pass every shortcut to `run`. `first` sees every key
 * outside form controls before the editor shortcuts (the melody lane); when it returns true the
 * key is handled. Tab / Shift+Tab move the chord selection while the focus is in the chord grid
 * and `canTab(delta)` says the selection would move; at either end they move the focus on as
 * usual, so the grid is no keyboard trap. Returns the unbind.
 */
export function bindShortcuts(
  target: EventTarget,
  run: (action: KeyAction) => void,
  first: (e: KeyboardEvent) => boolean = () => false,
  canTab: (delta: number) => boolean = () => false,
): () => void {
  /** Space went to play/stop on a control that would also react to its keyup (button, checkbox). */
  let swallowSpaceUp = false;
  const down = (e: Event): void => {
    if (!(e instanceof KeyboardEvent) || e.defaultPrevented || e.isComposing) return;
    if (isSpaceKey(e) && !isTypingTarget(e.target)) {
      const action = keyAction(e);
      if (action === null) return;
      e.preventDefault();
      swallowSpaceUp = true;
      if (!e.repeat) run(action);
      return;
    }
    if (isEditableTarget(e.target)) {
      if (e.key === 'Escape' && e.target instanceof HTMLElement) e.target.blur();
      return;
    }
    if (e.key === 'Tab') {
      if (e.ctrlKey || e.metaKey || e.altKey || !inTabSlots(e.target)) return;
      const delta = e.shiftKey ? -1 : 1;
      if (!canTab(delta)) return;
      e.preventDefault();
      run({ type: 'move', delta });
      return;
    }
    if (e.key === 'Enter' && isControlTarget(e.target)) return;
    if (first(e)) {
      e.preventDefault();
      return;
    }
    const action = keyAction(e);
    if (action === null) return;
    e.preventDefault();
    run(action);
  };
  const up = (e: Event): void => {
    if (!(e instanceof KeyboardEvent) || !isSpaceKey(e) || !swallowSpaceUp) return;
    swallowSpaceUp = false;
    e.preventDefault();
  };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
  };
}
