/** Toolbar: title, key/mode/tempo/meter, transport, history, export, MIDI out, table status. */
import type { Mode } from '@crokychords/core';
import { MODES, parseNoteName, toPitchClass } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, option, replaceChildren } from '../dom';
import { MODE_LABELS, TONICS } from '../music';
import type { AppState, Store } from '../state';
import { activeTable } from '../state';

export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;
const METER_BEATS = [2, 3, 4, 5, 6, 7, 9, 12];
const METER_UNITS = [2, 4, 8];

/** One-line description of the active table for the toolbar. */
export function tableSummary(state: AppState): string {
  const table = activeTable(state);
  const mode = state.song.key.mode;
  const sections = table.modes[mode]?.sections;
  const data =
    sections === undefined
      ? `no data for ${MODE_LABELS[mode].toLowerCase()}`
      : `${sections.toLocaleString('en-US')} sections (${MODE_LABELS[mode].toLowerCase()})`;
  return `${table.source.name} · ${data}`;
}

const STATUS_LABELS: Record<AppState['tableStatus'], string> = {
  loading: 'loading…',
  'seed-only': 'seed only',
  loaded: 'loaded',
  error: 'error',
};

export function mountToolbar(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('toolbar');

  const title = h('input', {
    class: 'title',
    props: { type: 'text', spellcheck: false },
    attrs: { 'aria-label': 'Song title', placeholder: 'Untitled' },
  });
  title.onchange = () => {
    const song = store.state.song;
    if (title.value !== song.title) actions.updateSong({ ...song, title: title.value });
  };

  const tonic = h('select', { attrs: { 'aria-label': 'Key' } }, ...TONICS.map((t) => option(t, t)));
  const mode = h(
    'select',
    { attrs: { 'aria-label': 'Mode' } },
    ...MODES.map((m) => option(m, MODE_LABELS[m])),
  );
  tonic.onchange = () => {
    const song = store.state.song;
    actions.updateSong({ ...song, key: { ...song.key, tonic: tonic.value } });
  };
  mode.onchange = () => {
    const song = store.state.song;
    const next = MODES.find((m): m is Mode => m === mode.value);
    if (next !== undefined) actions.updateSong({ ...song, key: { ...song.key, mode: next } });
  };

  const tempo = h('input', {
    class: 'tempo',
    props: { type: 'number', min: String(TEMPO_MIN), max: String(TEMPO_MAX), step: '1' },
    attrs: { 'aria-label': 'Tempo (BPM)' },
  });
  tempo.onchange = () => {
    const song = store.state.song;
    const value = Math.round(Number(tempo.value));
    if (!Number.isFinite(value) || value <= 0) {
      tempo.value = String(song.tempo);
      return;
    }
    const bpm = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, value));
    tempo.value = String(bpm);
    if (bpm !== song.tempo) actions.updateSong({ ...song, tempo: bpm });
  };

  const meterBeats = h(
    'select',
    { attrs: { 'aria-label': 'Beats per bar' } },
    ...METER_BEATS.map((b) => option(String(b), String(b))),
  );
  const meterUnit = h(
    'select',
    { attrs: { 'aria-label': 'Beat unit' } },
    ...METER_UNITS.map((u) => option(String(u), String(u))),
  );
  const setMeter = (): void => {
    const song = store.state.song;
    actions.updateSong({
      ...song,
      meter: { beats: Number(meterBeats.value), unit: Number(meterUnit.value) },
    });
  };
  meterBeats.onchange = setMeter;
  meterUnit.onchange = setMeter;

  const play = button('Play', 'Play / stop (Space)', () => actions.togglePlay());
  play.classList.add('primary');
  const loop = h('input', { props: { type: 'checkbox' } });
  loop.onchange = () => actions.setLoop(loop.checked);
  const undo = button('Undo', 'Undo (Ctrl/Cmd+Z)', () => actions.undo());
  const redo = button('Redo', 'Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)', () => actions.redo());
  const newSong = button('New', 'Start a new song (undoable)', () => actions.newSong());
  const exportMidi = button('Export MIDI', 'Download a Standard MIDI File', () =>
    actions.exportMidi(),
  );

  const midiBox = h('span', { class: 'midi' });
  const tableBox = h('span', { class: 'table-status' });

  root.append(
    h('span', { class: 'brand' }, 'Croky Chords'),
    title,
    group('Key', tonic, mode),
    group('BPM', tempo),
    group('Meter', meterBeats, h('span', { class: 'slash' }, '/'), meterUnit),
    h('span', { class: 'group' }, play, h('label', { class: 'check' }, loop, ' Loop')),
    h('span', { class: 'group' }, undo, redo),
    h('span', { class: 'group' }, newSong, exportMidi),
    midiBox,
    tableBox,
  );

  let midiKey: unknown[] = [];

  const renderMidi = (state: AppState): void => {
    const inputs = [state.midiStatus, state.midiOutputs, state.midiOut];
    if (inputs.every((v, i) => v === midiKey[i])) return;
    midiKey = inputs;
    if (state.midiStatus !== 'ready') {
      const label =
        state.midiStatus === 'pending'
          ? 'MIDI…'
          : state.midiStatus === 'unsupported'
            ? 'No Web MIDI'
            : state.midiStatus === 'denied'
              ? 'MIDI denied'
              : 'Enable MIDI out';
      const enable = button(label, 'Send the progression to a MIDI port (DAW, synth)', () => {
        void actions.enableMidi();
      });
      enable.disabled = state.midiStatus === 'pending' || state.midiStatus === 'unsupported';
      replaceChildren(midiBox, enable);
      return;
    }
    const select = h(
      'select',
      { attrs: { 'aria-label': 'MIDI output' } },
      option('', 'MIDI out: none', state.midiOut === null),
      ...state.midiOutputs.map((o) => option(o.id, o.name, o.id === state.midiOut)),
    );
    select.onchange = () => actions.selectMidiOut(select.value === '' ? null : select.value);
    replaceChildren(midiBox, select);
  };

  const render = (state: AppState): void => {
    const { song } = state;
    if (document.activeElement !== title && title.value !== song.title) title.value = song.title;
    const tonicValue = TONICS.find((t) => t === song.key.tonic) ?? spellTonic(song.key.tonic);
    tonic.value = tonicValue;
    mode.value = song.key.mode;
    if (document.activeElement !== tempo) tempo.value = String(song.tempo);
    meterBeats.value = String(song.meter.beats);
    meterUnit.value = String(song.meter.unit);
    play.textContent = state.playing ? 'Stop' : 'Play';
    play.setAttribute('aria-pressed', String(state.playing));
    loop.checked = state.loop;
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    renderMidi(state);

    const table = activeTable(state);
    tableBox.className = `table-status ${state.tableStatus}`;
    tableBox.title = [
      table.source.description,
      table.source.license === undefined ? undefined : `License: ${table.source.license}`,
      state.tableError,
    ]
      .filter((s): s is string => typeof s === 'string' && s !== '')
      .join('\n');
    replaceChildren(
      tableBox,
      h('span', { class: 'badge' }, STATUS_LABELS[state.tableStatus]),
      ' ',
      tableSummary(state),
      state.ngrams === null ? null : tableSwitch(state),
    );
  };

  const tableSwitch = (state: AppState): HTMLElement => {
    const select = h(
      'select',
      { attrs: { 'aria-label': 'Suggestion table' } },
      option('ngrams', state.ngrams?.source.name ?? 'ngrams', state.table === 'ngrams'),
      option('seed', 'seed', state.table === 'seed'),
    );
    select.onchange = () => store.set({ table: select.value === 'seed' ? 'seed' : 'ngrams' });
    return select;
  };

  // The toolbar is patched in place (not rebuilt) so open selects and focused inputs survive
  // the playhead updates; only the table box is rebuilt, and only when its inputs change.
  let last: unknown[] = [];
  store.subscribe((state) => {
    const inputs = [
      state.song,
      state.playing,
      state.loop,
      state.midiStatus,
      state.midiOutputs,
      state.midiOut,
      state.table,
      state.tableStatus,
      state.ngrams,
    ];
    if (inputs.every((v, i) => v === last[i])) return;
    last = inputs;
    render(state);
  });
  render(store.state);
}

/** A tonic spelled differently from the picker ('C#' for 'Db') maps to the picker's name. */
function spellTonic(name: string): string {
  try {
    return TONICS[toPitchClass(parseNoteName(name))] ?? 'C';
  } catch {
    return 'C';
  }
}

function group(label: string, ...controls: HTMLElement[]): HTMLElement {
  return h(
    'span',
    { class: 'group', attrs: { role: 'group', 'aria-label': label } },
    h('span', { class: 'label', attrs: { 'aria-hidden': 'true' } }, label),
    ...controls,
  );
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { props: { type: 'button' }, attrs: { title } }, text);
  b.onclick = onClick;
  return b;
}
