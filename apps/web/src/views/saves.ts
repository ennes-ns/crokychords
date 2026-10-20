/** Saved progressions panel: list the SaveStore records with New, Open, Rename and Delete. */
import { DEFAULT_SONG_TITLE } from '@crokychords/core';
import { h, replaceChildren } from '../dom';
import type { SaveSummary } from '../store/record';
import type { SaveSession } from '../store/session';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "5 min ago", "3 h ago", else the local date. */
export function savedLabel(updatedAt: string, now: Date = new Date()): string {
  const then = new Date(updatedAt);
  const age = now.getTime() - then.getTime();
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < 24 * HOUR) return `${Math.floor(age / HOUR)} h ago`;
  return then.toLocaleDateString();
}

export interface SavesViewOptions {
  /** Asks before deleting; window.confirm in the app. */
  confirm?: (message: string) => boolean;
  now?: () => Date;
  /** Shown in the header next to "+ New" (the sync status, when sync is on). */
  status?: HTMLElement;
}

export function mountSaves(
  root: HTMLElement,
  session: SaveSession,
  options: SavesViewOptions = {},
): { refresh: () => Promise<void> } {
  const confirm = options.confirm ?? ((message: string) => window.confirm(message));
  const now = options.now ?? (() => new Date());
  root.classList.add('panel', 'saves');
  const run = (action: Promise<unknown>): void => {
    action.catch((e: unknown) => console.warn('Saved progressions:', e));
  };

  const newButton = h('button', { props: { type: 'button' } }, '+ New');
  newButton.onclick = () => run(session.newSong());
  const listEl = h('ul', { class: 'saves-list', attrs: { 'aria-label': 'Saved progressions' } });
  root.append(
    h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, 'Saved progressions'),
      h('span', { class: 'saves-actions' }, options.status, newButton),
    ),
    listEl,
  );

  const item = (save: SaveSummary): HTMLLIElement => {
    const label = save.title === '' ? DEFAULT_SONG_TITLE : save.title;
    const current = save.id === session.currentId;
    const open = h(
      'button',
      {
        class: 'saves-open',
        props: { type: 'button' },
        attrs: { title: `Open "${label}"`, 'data-field': 'open' },
      },
      label,
    );
    open.onclick = () => run(session.open(save.id));
    const rename = h(
      'button',
      {
        props: { type: 'button' },
        attrs: { 'aria-label': `Rename "${label}"`, 'data-field': 'rename' },
      },
      'Rename',
    );
    const remove = h(
      'button',
      {
        props: { type: 'button' },
        attrs: { 'aria-label': `Delete "${label}"`, 'data-field': 'delete' },
      },
      'Delete',
    );
    remove.onclick = () => {
      if (confirm(`Delete "${label}"? This cannot be undone.`)) run(session.remove(save.id));
    };
    const li = h(
      'li',
      { class: current ? 'saves-item current' : 'saves-item', attrs: { 'data-save': save.id } },
      open,
      h('span', { class: 'saves-time' }, savedLabel(save.updated_at, now())),
      rename,
      remove,
    );
    if (current) li.setAttribute('aria-current', 'true');
    rename.onclick = () => {
      const input = h('input', {
        class: 'saves-rename',
        props: { value: save.title },
        attrs: { 'aria-label': 'New title', 'data-field': 'title' },
      });
      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        if (commit && input.value !== save.title) run(session.rename(save.id, input.value));
        else input.replaceWith(open);
      };
      input.onkeydown = (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
        event.stopPropagation();
      };
      input.onblur = () => finish(true);
      open.replaceWith(input);
      input.focus();
      input.select();
    };
    return li;
  };

  let generation = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const saves = await session.list();
    if (mine !== generation) return; // a newer refresh is on its way
    replaceChildren(
      listEl,
      ...(saves.length === 0
        ? [
            h(
              'li',
              { class: 'hint' },
              'Nothing saved yet: your progression saves itself as you edit.',
            ),
          ]
        : saves.map(item)),
    );
  };
  session.subscribe(() => void refresh());
  void refresh();
  return { refresh };
}
