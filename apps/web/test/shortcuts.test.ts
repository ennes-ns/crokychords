import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyAction } from '../src/keyboard';
import { bindShortcuts } from '../src/shortcuts';

function setup() {
  const run = vi.fn<(action: KeyAction) => void>();
  const unbind = bindShortcuts(window, run);
  return { run, unbind };
}

function control<K extends 'input' | 'select' | 'button' | 'textarea'>(
  tag: K,
  type?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (type !== undefined && el instanceof HTMLInputElement) el.type = type;
  document.body.append(el);
  return el;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const code = key === ' ' ? 'Space' : '';
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

let unbinds: (() => void)[] = [];
afterEach(() => {
  for (const unbind of unbinds) unbind();
  unbinds = [];
  document.body.replaceChildren();
});

describe('bindShortcuts', () => {
  it('plays/stops with Space on the page, a select, a checkbox and a button', () => {
    const { run, unbind } = setup();
    unbinds.push(unbind);
    const targets = [
      document.body,
      control('select'),
      control('input', 'checkbox'),
      control('button'),
    ];
    for (const target of targets) {
      const event = press(target, ' ');
      expect(event.defaultPrevented).toBe(true);
    }
    expect(run).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenLastCalledWith({ type: 'togglePlay' });
  });

  it('swallows the keyup of that Space so a focused button or checkbox does not react too', () => {
    const { unbind } = setup();
    unbinds.push(unbind);
    const box = control('input', 'checkbox');
    press(box, ' ');
    const up = new KeyboardEvent('keyup', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
  });

  it('lets Space type into the title field, number inputs and text areas', () => {
    const { run, unbind } = setup();
    unbinds.push(unbind);
    for (const target of [
      control('input', 'text'),
      control('input', 'number'),
      control('textarea'),
    ]) {
      const event = press(target, ' ');
      expect(event.defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('plays from the selection with Shift+Space, also from a select', () => {
    const { run, unbind } = setup();
    unbinds.push(unbind);
    press(control('select'), ' ', { shiftKey: true });
    expect(run).toHaveBeenCalledWith({ type: 'togglePlay', fromSelection: true });
  });

  it('keeps other shortcuts out of form controls, and Escape leaves them', () => {
    const { run, unbind } = setup();
    unbinds.push(unbind);
    const select = control('select');
    select.focus();
    press(select, 'l');
    expect(run).not.toHaveBeenCalled();
    press(select, 'Escape');
    expect(document.activeElement).not.toBe(select);
    press(document.body, 'l');
    expect(run).toHaveBeenCalledWith({ type: 'toggleLoop' });
  });

  it('ignores auto-repeat of Space', () => {
    const { run, unbind } = setup();
    unbinds.push(unbind);
    press(document.body, ' ', { repeat: true });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('bindShortcuts: the melody lane hook', () => {
  it('asks `first` before the editor shortcuts, after Space and outside form controls', () => {
    const run = vi.fn<(action: KeyAction) => void>();
    const first = vi.fn((e: KeyboardEvent) => e.key === '3');
    unbinds.push(bindShortcuts(window, run, first));
    const taken = press(document.body, '3');
    expect(taken.defaultPrevented).toBe(true);
    expect(run).not.toHaveBeenCalled();
    press(document.body, '4');
    expect(run).toHaveBeenCalledWith({ type: 'degree', degree: 4 });
    first.mockClear();
    press(document.body, ' ');
    press(control('input', 'text'), '3');
    expect(first).not.toHaveBeenCalled();
  });
});
