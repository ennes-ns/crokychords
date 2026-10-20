import './styles.css';
import { createSong } from '@crokychords/core';
import { createActions } from './actions';
import { BreakcoreController, loadBreakcorePrefs } from './breakcore';
import { AudioEngine } from './audio/synth';
import { loadTables } from './data/tables';
import { h } from './dom';
import { moveSelection } from './edit';
import { bindLoopPersistence } from './loop';
import { FireController } from './midi/fire/controller';
import { FireConnection, bindFirePageEvents, browserFireAccess } from './midi/fire/connect';
import { isChordTonesKey, melodyKeyAction } from './melodyKeys';
import { MidiOut, browserMidiAccess } from './midi/webmidi';
import { browserStorage } from './persist';
import { bindShortcuts } from './shortcuts';
import { Store, initialState } from './state';
import { browserIndexedDb } from './store/indexedDb';
import { openSampleStore } from './store/samples';
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
import { mountMelody } from './views/melody';
import { patternEditorKey } from './views/pattern';
import { mountSaves } from './views/saves';
import { browserCompactMedia, mountShell } from './views/shell';
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
  bindLoopPersistence(store, session, storage);
  window.addEventListener('pagehide', () => void session.flush());
  if (engine !== null) {
    bindSyncEvents(engine, window);
    void engine.start();
  }

  const audio = new AudioEngine(storage);
  const midi = new MidiOut(browserMidiAccess());
  store.set({ breakcore: { ...store.state.breakcore, ...loadBreakcorePrefs(storage) } });
  const breakcore = new BreakcoreController({
    store,
    startAudio: () => audio.start(),
    context: () => audio.context,
    synth: () => audio.synth,
    samples: await openSampleStore(browserIndexedDb()),
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`the break did not load (HTTP ${response.status})`);
      return response.arrayBuffer();
    },
    storage,
  });
  void breakcore.init();
  const actions = createActions(store, audio, midi, breakcore);
  const fire = new FireConnection(store, browserFireAccess(), new FireController(store, actions));
  bindFirePageEvents(fire, window);

  const { toolbar, grid, melody, editor, band, suggest, saves, compact } = mountShell(
    app,
    browserCompactMedia(),
  );
  const overlay = h(
    'button',
    { class: 'audio-overlay', props: { type: 'button' } },
    'Click anywhere to enable audio',
  );
  app.append(overlay);
  mountToolbar(toolbar, store, actions, {
    storage,
    fire: { connect: () => void fire.connect(), disconnect: () => fire.disconnect() },
    breakcore,
  });
  mountGrid(grid, store, actions);
  const melodyLane = mountMelody(melody, store, actions, storage);
  // Working in the chord grid gives the editing keys back to the chords.
  grid.addEventListener('pointerdown', () => actions.setFocus('chords'));
  mountChordEditor(editor, store, actions);
  // Short screens start with the Band panel collapsed until the user opens it once.
  mountBand(band, store, actions, storage, audio.sound, audio.master, { defaultOpen: !compact() });
  mountSuggest(suggest, store, actions);
  mountSaves(saves, session, engine === null ? {} : { status: syncStatusView(engine) });

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

  bindShortcuts(
    window,
    (action) => actions.key(action),
    (event) => {
      // Esc closes an open pattern editor first (docs/specs/pattern-editor-v1.md, B3).
      if (patternEditorKey(event, store.state, actions)) return true;
      // The melody lane takes its keys first while it has focus (docs/specs/melody-v1.md, B3).
      if (isChordTonesKey(event, store.state.focus)) {
        melodyLane.toggleChordTones();
        return true;
      }
      const melodyAction = melodyKeyAction(event, store.state.focus);
      if (melodyAction === null) return false;
      actions.melodyKey(melodyAction);
      return true;
    },
    (delta) => {
      const { selected, song } = store.state;
      return moveSelection(selected, delta, song.chords.length) !== selected;
    },
  );

  void loadTables(store, (url, init) => fetch(url, init));
}

const app = document.getElementById('app');
if (app !== null) void boot(app);
