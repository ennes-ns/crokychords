import './styles.css';
import { createSong } from '@crokychords/core';
import { createActions } from './actions';
import { AudioEngine } from './audio/synth';
import { loadTables } from './data/tables';
import { h, isEditableTarget } from './dom';
import { keyAction } from './keyboard';
import { FireController } from './midi/fire/controller';
import { FireConnection, bindFirePageEvents, browserFireAccess } from './midi/fire/connect';
import { MidiOut, browserMidiAccess } from './midi/webmidi';
import { browserStorage } from './persist';
import { Store, initialState } from './state';
import { browserIndexedDb } from './store/indexedDb';
import { browserLocalStorage, openSaveStore } from './store/open';
import type { SaveStore } from './store/saveStore';
import { SaveSession } from './store/session';
import { syncConfig } from './sync/config';
import { SyncEngine, bindSyncEvents } from './sync/engine';
import { HttpSyncClient } from './sync/http';
import { openSyncState } from './sync/state';
import { syncStatusView } from './sync/statusView';
import { applyTheme, installThemes, loadThemeId } from './themes';
import { mountBand } from './views/band';
import { mountChordEditor } from './views/chordEditor';
import { mountGrid } from './views/grid';
import { mountSaves } from './views/saves';
import { mountSuggest } from './views/suggest';
import { mountToolbar } from './views/toolbar';

/** The sync engine when the build enables sync (docs/specs/sync-v1.md), else null. */
async function startSync(local: SaveStore): Promise<SyncEngine | null> {
  const config = syncConfig(import.meta.env);
  if (!config.enabled) return null;
  // Web Locks keep two tabs from running a cycle at the same time (not in every browser).
  const locks = 'locks' in navigator ? navigator.locks : null;
  return new SyncEngine({
    client: new HttpSyncClient({
      baseUrl: config.baseUrl,
      fetch: (url, init) => fetch(url, init),
      online: () => navigator.onLine,
    }),
    local,
    state: await openSyncState(browserIndexedDb(), browserLocalStorage()),
    online: () => navigator.onLine,
    ...(locks !== null
      ? {
          withLock: async (run: () => Promise<void>) => {
            await locks.request('crokychords-sync', run);
          },
        }
      : {}),
  });
}

async function boot(app: HTMLElement): Promise<void> {
  const storage = browserStorage();
  installThemes();
  applyTheme(loadThemeId(storage));
  const store = new Store(initialState(createSong()));
  const local = await openSaveStore(browserIndexedDb(), browserLocalStorage());
  const engine = await startSync(local);
  const session = new SaveSession(store, { saves: engine?.wrap() ?? local, storage });
  engine?.onRemoteChange((id, copyId) => session.remoteChanged(id, copyId));
  await session.start();
  window.addEventListener('pagehide', () => void session.flush());
  if (engine !== null) {
    bindSyncEvents(engine, window);
    void engine.start();
  }

  const audio = new AudioEngine(storage);
  const midi = new MidiOut(browserMidiAccess());
  const actions = createActions(store, audio, midi);
  const fire = new FireConnection(store, browserFireAccess(), new FireController(store, actions));
  bindFirePageEvents(fire, window);

  const toolbar = h('header');
  const grid = h('section');
  const editor = h('section');
  const band = h('section');
  const savesPanel = h('section');
  const suggest = h('aside');
  const overlay = h(
    'button',
    { class: 'audio-overlay', props: { type: 'button' } },
    'Click anywhere to enable audio',
  );
  app.append(
    toolbar,
    h(
      'main',
      { class: 'workspace' },
      h('div', { class: 'left' }, grid, editor, band, savesPanel),
      suggest,
    ),
    overlay,
  );
  mountToolbar(toolbar, store, actions, {
    storage,
    fire: { connect: () => void fire.connect(), disconnect: () => fire.disconnect() },
  });
  mountGrid(grid, store, actions);
  mountChordEditor(editor, store, actions);
  mountBand(band, store, actions, storage, audio.sound);
  mountSuggest(suggest, store, actions);
  mountSaves(savesPanel, session, engine === null ? {} : { status: syncStatusView(engine) });

  // Browsers only start audio from a user gesture: the first click or key press does it.
  const unlock = (): void => {
    void actions.startAudio().then((ok) => {
      if (!ok) return;
      overlay.remove();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    });
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  overlay.onclick = () => overlay.remove();

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (isEditableTarget(event.target)) {
      if (event.key === 'Escape' && event.target instanceof HTMLElement) event.target.blur();
      return;
    }
    const action = keyAction(event);
    if (action === null) return;
    event.preventDefault();
    actions.key(action);
  });

  void loadTables(store, (url, init) => fetch(url, init));
}

const app = document.getElementById('app');
if (app !== null) void boot(app);
