import './styles.css';
import { createSong } from '@crokychords/core';
import { createActions } from './actions';
import { AudioEngine } from './audio/synth';
import { loadTables } from './data/tables';
import { h, isEditableTarget } from './dom';
import { keyAction } from './keyboard';
import { MidiOut, browserMidiAccess } from './midi/webmidi';
import { browserStorage, loadSong, persistSongs } from './persist';
import { Store, initialState } from './state';
import { mountChordEditor } from './views/chordEditor';
import { mountGrid } from './views/grid';
import { mountSuggest } from './views/suggest';
import { mountToolbar } from './views/toolbar';

function boot(app: HTMLElement): void {
  const storage = browserStorage();
  const store = new Store(initialState(loadSong(storage) ?? createSong()));
  persistSongs(store, storage);

  const audio = new AudioEngine();
  const midi = new MidiOut(browserMidiAccess());
  const actions = createActions(store, audio, midi);

  const toolbar = h('header');
  const grid = h('section');
  const editor = h('section');
  const suggest = h('aside');
  const overlay = h(
    'button',
    { class: 'audio-overlay', props: { type: 'button' } },
    'Click anywhere to enable audio',
  );
  app.append(
    toolbar,
    h('main', { class: 'workspace' }, h('div', { class: 'left' }, grid, editor), suggest),
    overlay,
  );
  mountToolbar(toolbar, store, actions);
  mountGrid(grid, store, actions);
  mountChordEditor(editor, store, actions);
  mountSuggest(suggest, store, actions);

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
if (app !== null) boot(app);
