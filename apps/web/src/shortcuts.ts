/**
 * The global keyboard handler: editor shortcuts outside form controls, and Space as play/stop
 * everywhere except while typing (docs/specs/loop-v1.md, "Space").
 */
import { isEditableTarget, isTypingTarget } from './dom';
import type { KeyAction } from './keyboard';
import { isSpaceKey, keyAction } from './keyboard';

/** Listen on `target` (the window) and pass every shortcut to `run`. Returns the unbind. */
export function bindShortcuts(target: EventTarget, run: (action: KeyAction) => void): () => void {
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
