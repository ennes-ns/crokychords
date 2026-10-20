import { createSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, initialState } from '../src/state';
import { makeRecord } from '../src/store/record';
import { MemorySaveStore } from '../src/store/saveStore';
import { MIGRATED_KEY, SaveSession } from '../src/store/session';
import { mountSaves, savedLabel } from '../src/views/saves';

const NOW = new Date('2026-10-20T12:00:00.000Z');

async function setup(confirm: (message: string) => boolean = () => true) {
  const saves = new MemorySaveStore();
  for (const [id, title, minute] of [
    ['a', 'Alpha', 50],
    ['b', '', 40],
  ] as const) {
    const now = new Date(Date.UTC(2026, 9, 20, 11, minute));
    await saves.put(makeRecord(createSong({ title }), { id, version: 1, now }));
  }
  const data: Record<string, string> = { [MIGRATED_KEY]: '1' };
  const storage = {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
  const app = new Store(initialState());
  const session = new SaveSession(app, { saves, storage, now: () => NOW });
  await session.start();
  const root = document.createElement('section');
  document.body.append(root);
  const view = mountSaves(root, session, { confirm, now: () => NOW });
  await view.refresh();
  const items = () => [...root.querySelectorAll<HTMLElement>('.saves-item')];
  const field = <T extends HTMLElement>(id: string, name: string): T => {
    const el = root.querySelector<T>(`[data-save="${id}"] [data-field="${name}"]`);
    if (el === null) throw new Error(`no ${name} in ${id}`);
    return el;
  };
  const settle = async () => {
    await session.flush();
    await view.refresh();
  };
  return { saves, app, session, root, items, field, settle };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('Saved progressions panel', () => {
  it('lists records newest first and marks the open one', async () => {
    const { items, root } = await setup();
    expect(items().map((li) => li.dataset['save'])).toEqual(['a', 'b']);
    expect(items()[0]?.getAttribute('aria-current')).toBe('true');
    expect(items()[1]?.textContent).toContain('Untitled');
    expect(items()[0]?.querySelector('.saves-time')?.textContent).toBe('10 min ago');
    expect(root.querySelector('h2')?.textContent).toBe('Saved progressions');
  });

  it('opens a record', async () => {
    const { field, app, session, settle } = await setup();
    field('b', 'open').click();
    await settle();
    expect(session.currentId).toBe('b');
    expect(app.state.song.title).toBe('');
  });

  it('renames with Enter and cancels with Escape', async () => {
    const { field, saves, settle } = await setup();
    field('b', 'rename').click();
    const input = field<HTMLInputElement>('b', 'title');
    input.value = 'Beta';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect((await saves.get('b'))?.title).toBe('Beta');

    field('a', 'rename').click();
    const other = field<HTMLInputElement>('a', 'title');
    other.value = 'Nope';
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    other.dispatchEvent(new Event('blur'));
    expect(field('a', 'open').textContent).toBe('Alpha');
    await settle();
    expect((await saves.get('a'))?.title).toBe('Alpha');
  });

  it('deletes after confirmation only', async () => {
    const confirm = vi.fn(() => false);
    const { field, saves, settle, items } = await setup(confirm);
    field('b', 'delete').click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('Delete "Untitled"? This cannot be undone.');
    expect(await saves.get('b')).not.toBeNull();
    confirm.mockReturnValue(true);
    field('b', 'delete').click();
    await settle();
    expect(await saves.get('b')).toBeNull();
    expect(items()).toHaveLength(1);
  });

  it('starts a new song and shows the empty state', async () => {
    const { root, saves, session, settle } = await setup();
    await saves.delete('a');
    await saves.delete('b');
    root.querySelector<HTMLButtonElement>('.panel-head button')?.click();
    await settle();
    expect(session.currentId).toBeNull();
    expect(root.querySelector('.saves-list')?.textContent).toContain('Nothing saved yet');
  });
});

describe('savedLabel', () => {
  it('reads as a relative time, then a date', () => {
    expect(savedLabel('2026-10-20T11:59:30.000Z', NOW)).toBe('just now');
    expect(savedLabel('2026-10-20T11:15:00.000Z', NOW)).toBe('45 min ago');
    expect(savedLabel('2026-10-20T07:00:00.000Z', NOW)).toBe('5 h ago');
    expect(savedLabel('2026-10-01T07:00:00.000Z', NOW)).toBe(
      new Date('2026-10-01T07:00:00.000Z').toLocaleDateString(),
    );
  });
});
