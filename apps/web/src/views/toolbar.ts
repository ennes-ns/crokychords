/**
 * Toolbar: title, key/mode/tempo/meter, transport, history, export, MIDI out, table status,
 * theme switcher.
 */
import type { Mode, NgramTable } from '@crokychords/core';
import { MODES, parseNoteName, toPitchClass } from '@crokychords/core';
import type { Actions } from '../actions';
import { BREAK_SPEEDS, isBreakSpeed } from '../audio/breaks';
import type { BreakcoreController, BreakcoreState } from '../breakcore';
import { channelMap, channelMapLabel, songTracks } from '../band';
import type { Child } from '../dom';
import { h, option, replaceChildren } from '../dom';
import { barLength } from '../edit';
import { loopLabel } from '../loop';
import { MODE_LABELS, TONICS } from '../music';
import type { AppState, Store } from '../state';
import { activeTable } from '../state';
import type { ThemeStorage } from '../themes';
import { THEMES, applyTheme, loadThemeId, saveThemeId } from '../themes';

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

/** The one attribution line the app shows for tables built from Chordonomicon. */
export const CHORDONOMICON_ATTRIBUTION =
  'Suggestion data derived from Chordonomicon (CC BY-NC 4.0)';

/** Attribution line for the table status tooltip, or undefined when the source has none. */
export function tableAttribution(source: NgramTable['source']): string | undefined {
  if (source.name.toLowerCase().includes('chordonomicon')) return CHORDONOMICON_ATTRIBUTION;
  return source.license === undefined ? undefined : `License: ${source.license}`;
}

const STATUS_LABELS: Record<AppState['tableStatus'], string> = {
  loading: 'loading…',
  'seed-only': 'seed only',
  loaded: 'loaded',
  error: 'error',
};

/** The Akai Fire connection as the toolbar sees it (docs/specs/akai-fire-v1.md). */
export interface FireControls {
  connect(): void;
  disconnect(): void;
}

export interface ToolbarOptions {
  /** Where the theme choice is persisted (localStorage); null keeps it for this page only. */
  storage?: ThemeStorage | null;
  /** Shows the "Connect Fire" button when given. */
  fire?: FireControls;
  /** Shows the Breakcore controls when given (docs/specs/breakcore-v1.md). */
  breakcore?: BreakcoreController;
}

/** The lamp: 8×10 pixels, `#` glass (lit in the state colour), `=` the socket. */
const LAMP_ROWS = [
  '..####..',
  '.######.',
  '##.##.##',
  '###..###',
  '########',
  '.######.',
  '..####..',
  '..====..',
  '..====..',
  '...==...',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The pixel-art Breakcore lamp as an inline SVG of square pixels (theme colours via CSS). */
export function breakLamp(doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'break-lamp');
  svg.setAttribute('viewBox', '0 0 8 10');
  svg.setAttribute('width', '8');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('shape-rendering', 'crispEdges');
  LAMP_ROWS.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === '.') return;
      const rect = doc.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      rect.setAttribute('class', cell === '#' ? 'glass' : 'socket');
      svg.append(rect);
    });
  });
  return svg;
}

const LAMP_TITLES: Record<'off' | BreakcoreState['status'], string> = {
  off: 'Breakcore (K): a fast chopped break under the progression. Shift+K cycles the intensity.',
  idle: 'Breakcore is on.',
  loading: 'Loading the break…',
  ready: 'Breakcore is on (K to turn off, Shift+K for the intensity).',
  error: 'The break could not be loaded',
};

/** Value of the break select that opens the file picker / removes the own break. */
const PICK_OWN = 'pick';
const REMOVE_OWN = 'remove';

/** The Breakcore group: toggle with lamp, intensity, speed and the break source. */
export function breakcoreControls(
  controller: BreakcoreController,
  store: Store,
): {
  element: HTMLElement;
  render: (state: BreakcoreState) => void;
} {
  const toggle = h('button', {
    class: 'break-toggle',
    props: { type: 'button' },
    attrs: { 'aria-pressed': 'false' },
  });
  toggle.append(breakLamp(toggle.ownerDocument), ' Breakcore');
  toggle.onclick = () => controller.toggle();

  const intensity = h('input', {
    class: 'break-intensity',
    props: { type: 'range', min: '0', max: '100', step: '5' },
    attrs: { 'aria-label': 'Breakcore intensity', title: 'Intensity (Shift+K: 25/50/75/100)' },
  });
  intensity.oninput = () => controller.setIntensity(Number(intensity.value));
  const percent = h('span', { class: 'break-percent' });

  const speed = h(
    'select',
    { attrs: { 'aria-label': 'Breakcore speed', title: 'Speed: ×2 turns 16ths into 32nds' } },
    ...BREAK_SPEEDS.map((s) => option(String(s), `×${s}`)),
  );
  speed.onchange = () => {
    const value = Number(speed.value);
    if (isBreakSpeed(value)) controller.setSpeed(value);
  };

  const file = h('input', {
    class: 'break-file',
    props: { type: 'file', accept: 'audio/*,.wav,.ogg,.flac,.mp3', hidden: true },
    attrs: { 'aria-label': 'Use my own break' },
  });
  file.onchange = () => {
    const picked = file.files?.[0];
    file.value = '';
    if (picked !== undefined) void controller.useOwn(picked).catch(() => undefined);
  };
  const source = h('select', {
    attrs: { 'aria-label': 'Break', title: 'Which break plays: the bundled one or your own' },
  });
  source.onchange = () => {
    const value = source.value;
    if (value === PICK_OWN) file.click();
    else if (value === REMOVE_OWN) void controller.removeOwn();
    else controller.setSource(value === 'own' ? 'own' : 'bundled');
    source.value = store.state.breakcore.source;
  };

  const element = h(
    'span',
    { class: 'group breakcore', attrs: { role: 'group', 'aria-label': 'Breakcore' } },
    toggle,
    intensity,
    percent,
    speed,
    source,
    file,
  );

  const render = (state: BreakcoreState): void => {
    const lamp = state.enabled ? state.status : 'off';
    toggle.dataset['lamp'] = lamp;
    toggle.setAttribute('aria-pressed', String(state.enabled));
    toggle.title =
      lamp === 'error' && state.error !== null
        ? `${LAMP_TITLES.error}: ${state.error}`
        : LAMP_TITLES[lamp];
    if (document.activeElement !== intensity) intensity.value = String(state.intensity);
    percent.textContent = `${state.intensity}%`;
    speed.value = String(state.speed);
    replaceChildren(
      source,
      option('bundled', 'Bundled break', state.source === 'bundled'),
      state.ownName === null
        ? null
        : option('own', `Own: ${state.ownName}`, state.source === 'own'),
      option(PICK_OWN, 'Use my own break…'),
      state.ownName === null ? null : option(REMOVE_OWN, 'Remove own break'),
    );
    source.value = state.source;
  };
  return { element, render };
}

const FIRE_LABELS: Record<AppState['fire']['status'], string> = {
  off: 'Connect Fire',
  pending: 'Fire…',
  waiting: 'Fire: plug in',
  connected: 'Fire connected',
  unsupported: 'No Web MIDI',
  denied: 'Fire: SysEx denied',
};

const FIRE_TITLES: Record<AppState['fire']['status'], string> = {
  off: 'Use an Akai Fire as a controller. The browser asks to control your MIDI devices (SysEx): that lights the pads.',
  pending: 'Waiting for MIDI access…',
  waiting: 'Access granted; plug in the Akai Fire. Click to stop.',
  connected: 'The Akai Fire controls the editor. Click to disconnect.',
  unsupported: 'This browser has no Web MIDI (use Chrome or Edge).',
  denied: 'MIDI with SysEx was denied; the Fire needs it for its pads. Click to try again.',
};

/**
 * The theme switcher: applies the stored theme, and on change applies and stores the new one
 * (docs/specs/themes-v1.md, "Switching and persistence").
 */
export function themeSwitcher(storage: ThemeStorage | null, doc: Document = document): HTMLElement {
  const current = applyTheme(loadThemeId(storage), doc);
  const select = h(
    'select',
    { attrs: { 'aria-label': 'Theme' } },
    ...THEMES.map((t) => option(t.id, t.label, t.id === current)),
  );
  select.value = current;
  select.onchange = () => saveThemeId(storage, applyTheme(select.value, doc));
  return h(
    'span',
    { class: 'group theme-switch', attrs: { role: 'group', 'aria-label': 'Theme' } },
    h('span', { class: 'label', attrs: { 'aria-hidden': 'true' } }, 'Theme'),
    select,
  );
}

export function mountToolbar(
  root: HTMLElement,
  store: Store,
  actions: Actions,
  options: ToolbarOptions = {},
): void {
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

  const play = button(
    'Play',
    'Play / stop (Space): from the loop start when looping, else from the start',
    () => actions.togglePlay(),
  );
  play.classList.add('primary');
  const loop = h('input', { props: { type: 'checkbox' }, attrs: { 'aria-label': 'Loop' } });
  loop.onchange = () => actions.setLoop(loop.checked);
  const loopRange = h('span', { class: 'loop-range' });
  const clearLoop = button('×', 'Clear the loop points (loop the whole song)', () =>
    actions.setLoopRange(null),
  );
  clearLoop.classList.add('loop-clear');
  clearLoop.setAttribute('aria-label', 'Clear the loop points');
  const undo = button('Undo', 'Undo (Ctrl/Cmd+Z)', () => actions.undo());
  const redo = button('Redo', 'Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)', () => actions.redo());
  const newSong = button('New', 'Start a new song (undoable)', () => actions.newSong());
  const exportMidi = button('Export MIDI', 'Download a Standard MIDI File', () =>
    actions.exportMidi(),
  );

  const breakcore =
    options.breakcore === undefined ? null : breakcoreControls(options.breakcore, store);

  const midiBox = h('span', { class: 'midi' });
  const channelBox = h('span', { class: 'channel-map', attrs: { 'aria-label': 'MIDI channels' } });
  const tableBox = h('span', { class: 'table-status' });
  const fireControls = options.fire;
  const fireButton =
    fireControls === undefined
      ? null
      : button(FIRE_LABELS.off, FIRE_TITLES.off, () => {
          const status = store.state.fire.status;
          if (status === 'connected' || status === 'waiting') fireControls.disconnect();
          else fireControls.connect();
        });

  root.append(
    h(
      'span',
      { class: 'brand' },
      h('img', {
        class: 'brand-mark',
        attrs: { src: '/brand/croky-mark.svg', alt: '', width: '28', height: '28' },
      }),
      h('span', { class: 'brand-name' }, h('b', {}, 'Croky'), 'Chords'),
    ),
    title,
    group('Key', tonic, mode),
    group('BPM', tempo),
    group('Meter', meterBeats, h('span', { class: 'slash' }, '/'), meterUnit),
    h(
      'span',
      { class: 'group' },
      play,
      h(
        'label',
        {
          class: 'check',
          attrs: {
            title:
              'Loop (L): the loop points when set, else the whole song. Set them by clicking or ' +
              'dragging the bar numbers, Shift+click to extend, Alt+[ / Alt+] at the selection.',
          },
        },
        loop,
        ' Loop',
      ),
      loopRange,
      clearLoop,
    ),
    ...(breakcore === null ? [] : [breakcore.element]),
    h('span', { class: 'group' }, undo, redo),
    h('span', { class: 'group' }, newSong, exportMidi),
    h('span', { class: 'group' }, midiBox, channelBox, fireButton),
    tableBox,
    themeSwitcher(options.storage ?? null, root.ownerDocument),
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

  let channelKey: unknown = null;
  const renderChannels = (state: AppState): void => {
    const tracks = songTracks(state.song);
    if (tracks === channelKey) return;
    channelKey = tracks;
    channelBox.title = `${channelMapLabel(tracks)}\nEvery track sends on its own MIDI channel.`;
    const items: Child[] = [];
    channelMap(tracks).forEach((item, i) => {
      if (i > 0) items.push(h('span', { class: 'sep', attrs: { 'aria-hidden': 'true' } }, '·'));
      items.push(
        h(
          'span',
          { class: item.muted ? 'channel muted' : 'channel' },
          `${item.name} `,
          h('b', {}, `ch${item.channel}`),
        ),
      );
    });
    replaceChildren(channelBox, ...items);
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
    loopRange.textContent =
      state.loopRange === null ? '' : loopLabel(state.loopRange, barLength(song));
    loopRange.classList.toggle('off', !state.loop);
    clearLoop.hidden = state.loopRange === null;
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    renderMidi(state);
    renderChannels(state);
    breakcore?.render(state.breakcore);
    if (fireButton !== null) {
      const status = state.fire.status;
      fireButton.textContent = FIRE_LABELS[status];
      fireButton.title = FIRE_TITLES[status];
      fireButton.disabled = status === 'pending' || status === 'unsupported';
      fireButton.setAttribute('aria-pressed', String(status === 'connected'));
    }

    const table = activeTable(state);
    tableBox.className = `table-status ${state.tableStatus}`;
    tableBox.title = [table.source.description, tableAttribution(table.source), state.tableError]
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
      state.loopRange,
      state.midiStatus,
      state.midiOutputs,
      state.midiOut,
      state.table,
      state.tableStatus,
      state.ngrams,
      state.fire.status,
      state.breakcore,
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
