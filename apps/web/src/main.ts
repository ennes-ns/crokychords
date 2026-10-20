import './styles.css';
import { createSong, songToMidi } from '@crokychords/core';
import { createActions } from './actions';
import { HttpAssistantClient, unavailableClient } from './assistant/client';
import { createCroky } from './assistant/croky';
import { bindAssistantKey, mountAssistant } from './assistant/panel';
import { BreakcoreController, loadBreakcorePrefs } from './breakcore';
import { isInstrumentId } from './audio/instruments';
import { trackPrograms } from './audio/sound';
import { AudioEngine } from './audio/synth';
import { loadTables } from './data/tables';
import { h } from './dom';
import { moveSelection } from './edit';
import { bindLoopPersistence } from './loop';
import { FireController } from './midi/fire/controller';
import { FireConnection, bindFirePageEvents, browserFireAccess } from './midi/fire/connect';
import { isChordTonesKey, melodyKeyAction } from './melodyKeys';
import { midiFileName } from './midi/download';
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

/** How long `play` waits for the browser to let audio start (ms). */
const AUDIO_WAIT_MS = 1500;

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

  const audio = new AudioEngine(storage, { base: `${import.meta.env.BASE_URL}soundfonts/` });
  const midi = new MidiOut(browserMidiAccess());
  store.set({ breakcore: { ...store.state.breakcore, ...loadBreakcorePrefs(storage) } });
  // Own audio files: the own break and the sampler slots' samples (docs/specs/sampler-v1.md).
  const sampleStore = await openSampleStore(browserIndexedDb());
  void audio.samplers.attach(sampleStore);
  const breakcore = new BreakcoreController({
    store,
    startAudio: () => audio.start(),
    context: () => audio.context,
    synth: () => audio.synth,
    samples: sampleStore,
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`the break did not load (HTTP ${response.status})`);
      return response.arrayBuffer();
    },
    storage,
  });
  void breakcore.init();
  const actions = createActions(store, audio, midi, breakcore);
  // A hidden tab that plays nothing suspends its audio (issue #82).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.hidden();
  });
  // The command API for agents and the assistant (docs/specs/assistant-v1.md §A4).
  const commandEnv = { isInstrument: isInstrumentId };
  const croky = createCroky(store, {
    env: commandEnv,
    async play(from) {
      // Without a user gesture (and without an autoplay exemption) audio cannot start.
      const started = await Promise.race([
        actions.startAudio(),
        new Promise<false>((resolve) => window.setTimeout(() => resolve(false), AUDIO_WAIT_MS)),
      ]);
      return started && actions.playFrom(from);
    },
    stop: () => actions.stop(),
    audition: (token) => actions.audition(token),
    setInstrument(track, role, id) {
      if (isInstrumentId(id)) audio.sound.setInstrument(track, role, id);
    },
    midi: (song) => ({
      bytes: songToMidi(song, { programs: trackPrograms(audio.sound.state, song) }),
      fileName: midiFileName(song.title),
    }),
    save: () => session.flush(),
  });

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
  const assistant = mountAssistant({
    store,
    croky,
    env: commandEnv,
    client: syncConfig(import.meta.env).enabled
      ? new HttpAssistantClient({
          baseUrl: syncConfig(import.meta.env).baseUrl,
          fetch: (url, init) => fetch(url, init),
          online: () => navigator.onLine,
        })
      : unavailableClient(),
  });
  // Over the side column; the stage keeps its size (docs/specs/assistant-v1.md §B1).
  grid.closest('.workspace')?.append(assistant.element);
  bindAssistantKey(window, assistant);
  mountToolbar(toolbar, store, actions, {
    storage,
    assistant: assistant.button,
    fire: { connect: () => void fire.connect(), disconnect: () => fire.disconnect() },
    breakcore,
  });
  mountGrid(grid, store, actions);
  const melodyLane = mountMelody(melody, store, actions, storage);
  // Working in the chord grid gives the editing keys back to the chords.
  grid.addEventListener('pointerdown', () => actions.setFocus('chords'));
  mountChordEditor(editor, store, actions);
  // Short screens start with the Band panel collapsed until the user opens it once.
  mountBand(band, store, actions, storage, audio.sound, audio.master, {
    defaultOpen: !compact(),
    samples: audio.samples,
    samplers: audio.samplers,
  });
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

  window.croky = croky;
  document.dispatchEvent(new Event('croky:ready'));

  void loadTables(store, (url, init) => fetch(url, init));
  // The default preset's chords instrument, so real samples are ready by the first Play.
  audio.prefetch();
}

const app = document.getElementById('app');
if (app !== null) void boot(app);
