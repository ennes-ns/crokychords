import type { Song } from '@crokychords/core';
import { createSong, parseCommand, songToMidi } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../src/assistant/engine';
import { fromBase64, step } from '../src/assistant/engine';
import { base64 } from '../src/assistant/croky';
import { MAX_IMPORT_FILES, importEntry, importableFiles } from '../src/importer';
import { Store, initialState } from '../src/state';
import { makeRecord } from '../src/store/record';
import { MemorySaveStore } from '../src/store/saveStore';
import { SaveSession } from '../src/store/session';
import { bindImportDrop, mountImporter } from '../src/views/importer';
import { quietHost } from './commandHelpers';

function exported(title: string, chords: [string, number][], tonic = 'C'): Uint8Array<ArrayBuffer> {
  return songToMidi(
    createSong({
      title,
      key: { tonic, mode: 'major' },
      chords: chords.map(([token, beats]) => ({ token, beats })),
    }),
  );
}

const POP = exported('Pop', [
  ['I', 4],
  ['V', 4],
  ['vi', 4],
  ['IV', 4],
  ['I', 4],
]);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('importer helpers', () => {
  it('keeps importable files, skips big ones and caps the count', () => {
    const file = (name: string, size = 10) => ({ name, size });
    const { files, skipped } = importableFiles([
      file('a.mid'),
      file('b.wav'),
      file('c.musicxml'),
      file('d.mid', 6 * 1024 * 1024),
    ]);
    expect(files.map((f) => f.name)).toEqual(['a.mid', 'c.musicxml']);
    expect(skipped).toEqual(['d.mid (larger than 5 MB)']);
    const many = Array.from({ length: MAX_IMPORT_FILES + 2 }, (_, i) => file(`${i}.mid`));
    expect(importableFiles(many).files).toHaveLength(MAX_IMPORT_FILES);
  });

  it('an entry holds the result, or the error for a file that is not MIDI', () => {
    expect(importEntry({ name: 'pop.mid', bytes: POP }).result?.song.title).toBe('Pop');
    const bad = importEntry({ name: 'x.mid', bytes: new Uint8Array([1, 2, 3]) });
    expect(bad.result).toBeNull();
    expect(bad.error).toMatch(/not a Standard MIDI File/);
    const rekeyed = importEntry({ name: 'pop.mid', bytes: POP }, { tonic: 'A', mode: 'minor' });
    expect(rekeyed.result?.song.chords.map((c) => c.token)).toEqual([
      'III',
      'VII',
      'i',
      'VI',
      'III',
    ]);
  });
});

function mount(save = vi.fn(async (_songs: Song[]) => undefined)) {
  const host = document.createElement('div');
  document.body.append(host);
  const importer = mountImporter(host, { save });
  return { host, importer, save };
}

describe('import preview', () => {
  it('shows one entry per file with key, tempo, chords and parts, and opens a single file', async () => {
    const { host, importer, save } = mount();
    importer.openSources([{ name: 'pop.mid', bytes: POP }]);
    expect(importer.isOpen()).toBe(true);
    const entry = host.querySelector('.import-entry');
    expect(entry?.querySelector('.import-song-title')?.textContent).toBe('Pop');
    expect(host.querySelector<HTMLSelectElement>('[data-field="tonic"]')?.value).toBe('C');
    expect(host.querySelector<HTMLSelectElement>('[data-field="mode"]')?.value).toBe('major');
    const strip = [...host.querySelectorAll('.import-chord')].map((c) => c.textContent);
    expect(strip).toEqual(['I', 'V', 'vi', 'IV', 'I']);
    expect(entry?.textContent).toContain('5 chords · 5 diatonic');
    expect(entry?.textContent).toContain('Chords: chords');
    const accept = host.querySelector<HTMLButtonElement>('.import-actions .primary');
    expect(accept?.textContent).toBe('Open');
    expect(document.activeElement).toBe(accept);
    accept?.click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].map((s) => s.title)).toEqual(['Pop']);
    await Promise.resolve();
    await Promise.resolve();
    expect(importer.isOpen()).toBe(false);
  });

  it('a key override re-runs the import; failed files are listed and skipped by Save all', () => {
    const { host, importer, save } = mount();
    importer.openSources([
      { name: 'pop.mid', bytes: POP },
      {
        name: 'other.mid',
        bytes: exported(
          'Other',
          [
            ['ii', 4],
            ['V7', 4],
            ['I', 4],
          ],
          'D',
        ),
      },
      { name: 'broken.mid', bytes: new Uint8Array([0x4d]) },
    ]);
    expect(host.querySelector('.import-title')?.textContent).toBe('Import 3 files');
    expect(host.querySelector('.import-status')?.textContent).toContain('1 could not be imported');
    expect(host.querySelector('.import-entry.failed')?.textContent).toContain('Not imported');
    const tonic = host.querySelector<HTMLSelectElement>('[data-entry="0"] [data-field="tonic"]');
    const mode = host.querySelector<HTMLSelectElement>('[data-entry="0"] [data-field="mode"]');
    if (tonic === null || mode === null) throw new Error('no key select');
    tonic.value = 'A';
    mode.value = 'minor';
    mode.dispatchEvent(new Event('change'));
    const first = host.querySelector('[data-entry="0"]');
    expect([...(first?.querySelectorAll('.import-chord') ?? [])].map((c) => c.textContent)).toEqual(
      ['III', 'VII', 'i', 'VI', 'III'],
    );
    expect(first?.textContent).toContain('chosen');
    const accept = host.querySelector<HTMLButtonElement>('.import-actions .primary');
    expect(accept?.textContent).toBe('Save all (2)');
    accept?.click();
    expect(save.mock.calls[0]?.[0].map((s) => [s.title, s.key.tonic])).toEqual([
      ['Pop', 'A'],
      ['Other', 'D'],
    ]);
  });

  it('Escape and Cancel close without saving; keys do not reach the app', () => {
    const { host, importer, save } = mount();
    const appKeys = vi.fn();
    window.addEventListener('keydown', appKeys);
    importer.openSources([{ name: 'pop.mid', bytes: POP }]);
    const dialog = host.querySelector('.import-dialog');
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(appKeys).not.toHaveBeenCalled();
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(importer.isOpen()).toBe(false);
    importer.openSources([{ name: 'pop.mid', bytes: POP }]);
    host.querySelector<HTMLButtonElement>('.import-actions button:not(.primary)')?.click();
    expect(importer.isOpen()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appKeys);
  });

  it('lists warnings and dropped entries with their bar and beat', () => {
    const note = (step: string, extra = '') =>
      `<note>${extra}<pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration></note>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
      <part id="P1"><measure><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <sound tempo="90"/>${note('C')}${note('E')}<note><grace/><pitch><step>F</step><octave>4</octave></pitch></note>${note('G')}<sound tempo="100"/>${note('C')}</measure></part></score-partwise>`;
    const { host, importer } = mount();
    importer.openSources([{ name: 'lead.musicxml', bytes: new TextEncoder().encode(xml) }]);
    expect(host.querySelector('.import-warnings')?.textContent).toContain('tempo changes');
    const dropped = host.querySelector('.import-dropped');
    expect(dropped?.querySelector('summary')?.textContent).toBe('Dropped (1)');
    expect(dropped?.querySelector('li')?.textContent).toBe('bar 1, beat 3: note — grace note');
    expect(host.querySelector('.import-entry')?.textContent).toContain('no chords found');
    expect(host.querySelector('.import-entry')?.textContent).toContain('Melody: 4 notes');
  });

  it('opening files filters them and reads their bytes', async () => {
    const { host, importer } = mount();
    const file = new File([POP], 'pop.mid', { type: 'audio/midi' });
    const text = new File(['hello'], 'notes.txt');
    await importer.openFiles([file, text]);
    expect(host.querySelectorAll('.import-entry')).toHaveLength(1);
    expect(host.querySelector('.import-song-title')?.textContent).toBe('Pop');
  });

  it('the grid takes dropped files', async () => {
    const grid = document.createElement('div');
    const openFiles = vi.fn(async () => undefined);
    bindImportDrop(grid, { openFiles });
    const file = new File([POP], 'pop.mid');
    const transfer = { types: ['Files'], files: [file], items: [] };
    const enter = new Event('dragenter', { cancelable: true });
    Object.defineProperty(enter, 'dataTransfer', { value: transfer });
    grid.dispatchEvent(enter);
    expect(grid.classList.contains('drop-target')).toBe(true);
    const drop = new Event('drop', { cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    grid.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(grid.classList.contains('drop-target')).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(openFiles).toHaveBeenCalledWith([file]);
  });
});

describe('SaveSession.importSongs', () => {
  it('saves every song as a new record and opens the first', async () => {
    let n = 0;
    const saves = new MemorySaveStore();
    const app = new Store(initialState());
    const session = new SaveSession(app, { saves, storage: null, newId: () => `id${++n}` });
    await saves.put(
      makeRecord(createSong({ title: 'Mine' }), { id: 'mine', version: 1, now: new Date() }),
    );
    await session.start();
    const a = createSong({ title: 'A', chords: [{ token: 'I', beats: 4 }] });
    const b = createSong({ title: 'B', chords: [{ token: 'V', beats: 4 }] });
    expect(await session.importSongs([a, b])).toEqual(['id1', 'id2']);
    expect(session.currentId).toBe('id1');
    expect(app.state.song.title).toBe('A');
    expect((await session.list()).map((s) => s.title).sort()).toEqual(['A', 'B', 'Mine']);
  });
});

describe('importFile command', () => {
  const state = (): EngineState => ({
    song: createSong({ chords: [{ token: 'IV', beats: 4 }] }),
    selected: 0,
    loop: false,
    loopRange: null,
    past: [],
    future: [],
  });
  const run = (value: unknown) => {
    const parsed = parseCommand(value);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return step(state(), parsed.command, quietHost.env);
  };

  it('replaces the song with the import (one undo step) and reports it', () => {
    const r = run({ op: 'importFile', name: 'pop.mid', data: base64(POP) });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.state.song.chords.map((c) => c.token)).toEqual(['I', 'V', 'vi', 'IV', 'I']);
    expect(r.state.past).toHaveLength(1);
    expect(r.state.selected).toBeNull();
    expect(r.result).toMatchObject({ op: 'importFile', title: 'Pop', key: 'C major', chords: 5 });
    const minor = run({
      op: 'importFile',
      name: 'pop.mid',
      data: base64(POP),
      tonic: 'A',
      mode: 'minor',
    });
    expect(minor.ok && minor.state.song.key).toEqual({ tonic: 'A', mode: 'minor' });
  });

  it('refuses bad base64, unreadable files and half a key', () => {
    const bad = run({ op: 'importFile', name: 'x.mid', data: '***' });
    expect(bad.ok ? null : [bad.error.code, bad.error.path]).toEqual(['invalid', 'data']);
    const notMidi = run({ op: 'importFile', name: 'x.mid', data: base64(new Uint8Array([1, 2])) });
    expect(notMidi.ok ? null : notMidi.error.message).toMatch(/not a Standard MIDI File/);
    const half = parseCommand({ op: 'importFile', name: 'x.mid', data: 'AA==', mode: 'minor' });
    expect(half.ok ? null : half.error.path).toBe('tonic');
    expect(fromBase64('TVRoZA==')).toEqual(new Uint8Array([0x4d, 0x54, 0x68, 0x64]));
  });
});
