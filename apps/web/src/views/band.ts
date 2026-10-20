/**
 * Band panel: the browser sound (preset and drum pattern), the master row (protection mode and
 * volume), then one row per track (mute, name,
 * role, pattern, octave, MIDI channel, velocity, gate, transpose, instrument, edit pattern,
 * reorder, remove), the melody row (mute, octave shift, channel, velocity, instrument) plus "Add
 * track". The pattern editor (views/pattern.ts) opens under its track's row. Rows are patched in
 * place, so focused
 * inputs and dragged sliders survive store updates; every song edit is a commit (undoable), the
 * instruments and the melody's octave shift and velocity are sound settings (not in the song).
 */
import type { Pattern, Song, Track, TrackRole } from '@crokychords/core';
import { MELODY_TRACK_ID, ROLE_DEFAULTS, TRACK_ROLES, patternDescription } from '@crokychords/core';
import type { Actions } from '../actions';
import type { InstrumentId } from '../audio/instruments';
import {
  DRUM_PATTERNS,
  INSTRUMENTS,
  SOUNDFONTS,
  SOUND_PRESETS,
  SYNTH_IDS,
  isDrumPatternId,
  isInstrumentId,
  isSoundPresetId,
  soundfont,
} from '../audio/instruments';
import { MASTER_MODES, MASTER_MODE_LABELS, isMasterMode } from '../audio/graph';
import type { SoundSettings } from '../audio/sound';
import { MELODY_SHIFT_MAX, MELODY_SHIFT_MIN, customTracks } from '../audio/sound';
import type { SampleStatus } from '../audio/soundfont';
import type { TrackPatch } from '../band';
import {
  GATE_MAX,
  GATE_MIN,
  MIDI_CHANNELS,
  OCTAVE_MAX,
  OCTAVE_MIN,
  ROLE_LABELS,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  VELOCITY_MAX,
  VELOCITY_MIN,
  clampInt,
  hasRoleDefaults,
  isPresetPattern,
  presetGroups,
  songPatterns,
  songTracks,
  updateTrack,
} from '../band';
import { h, option } from '../dom';
import { songMelody } from '../melody';
import type { MasterSettings, SongStorage } from '../persist';
import { loadBandOpen, saveBandOpen } from '../persist';
import type { AppState, Store } from '../state';
import { createPatternEditor } from './pattern';

const GATE_STEP = 0.05;
const CUSTOM_PATTERN = '__custom__';

export const BAND_COLUMNS = [
  'Mute',
  'Name',
  'Role',
  'Pattern',
  'Oct',
  'Ch',
  'Velocity',
  'Gate',
  'Transp.',
  'Instrument',
  '',
] as const;

function isTrackRole(value: string): value is TrackRole {
  return TRACK_ROLES.some((r) => r === value);
}

/** "90%" for a gate of 0.9. */
export function gateLabel(gate: number): string {
  return `${Math.round(gate * 100)}%`;
}

interface RowView {
  el: HTMLElement;
  update(
    track: Track,
    index: number,
    count: number,
    selected: boolean,
    editing: boolean,
    songPresets: readonly Pattern[],
  ): void;
}

/** Label of a built-in preset in the pattern select: "Name — description". */
export function presetLabel(pattern: Pattern): string {
  const description = patternDescription(pattern.id);
  return description === '' ? pattern.name : `${pattern.name} — ${description}`;
}

interface RowContext {
  store: Store;
  actions: Actions;
  /** Role a track was switched to in this session; shows "apply defaults" until used. */
  pendingRole: Map<string, TrackRole>;
  sound: SoundSettings | null;
  samples: SampleStatus | null;
}

/** Instrument select plus its loading mark, for a track or the melody (`role` null). */
interface InstrumentPicker {
  cell: HTMLElement;
  update(track: string, role: TrackRole | null): void;
}

/** Status mark of a SoundFont instrument: loading, failed, or nothing. */
export function loadingMark(state: string): { text: string; title: string } {
  if (state === 'loading') return { text: '…', title: 'Loading the samples' };
  if (state === 'error') return { text: '!', title: 'Could not load; playing the synth stand-in' };
  return { text: '', title: '' };
}

function instrumentPicker(ctx: RowContext): InstrumentPicker {
  const select = h(
    'select',
    { attrs: { 'aria-label': 'Instrument', 'data-field': 'instrument' } },
    h(
      'optgroup',
      { props: { label: 'SoundFont' } },
      ...SOUNDFONTS.map((s) => option(s.id, s.name)),
    ),
    h(
      'optgroup',
      { props: { label: 'Synth' } },
      ...SYNTH_IDS.map((id) => option(id, INSTRUMENTS[id].name)),
    ),
  );
  const mark = h('span', { class: 'band-load', attrs: { 'data-field': 'loading' } });
  let current: { track: string; role: TrackRole | null } | null = null;
  select.onchange = () => {
    const id = select.value;
    if (current === null || ctx.sound === null || !isInstrumentId(id)) return;
    ctx.sound.setInstrument(current.track, current.role, id);
    // Also retries an instrument that failed to load before.
    const font = soundfont(id);
    if (font !== undefined) ctx.samples?.load(font.id);
  };
  const cell = h('span', { class: 'band-cell band-instrument' }, select, mark);
  cell.hidden = ctx.sound === null;
  return {
    cell,
    update(track, role) {
      current = { track, role };
      const sound = ctx.sound;
      if (sound === null) return;
      const id: InstrumentId =
        role === null ? sound.melodyInstrument() : sound.trackInstrument({ id: track, role });
      if (select.value !== id) select.value = id;
      const font = soundfont(id);
      const status = loadingMark(
        font === undefined ? 'ready' : (ctx.samples?.state(font.id) ?? ''),
      );
      mark.textContent = status.text;
      mark.title = status.title;
      mark.classList.toggle('failed', status.text === '!');
    },
  };
}

function setIfIdle(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const typing =
    document.activeElement === input &&
    input instanceof HTMLInputElement &&
    (input.type === 'text' || input.type === 'number');
  if (!typing && input.value !== value) input.value = value;
}

/** A range input that previews while dragging and commits one undo step on release. */
function slider(
  ctx: RowContext,
  id: string,
  label: string,
  attrs: { min: number; max: number; step: number },
  patch: (value: number) => TrackPatch,
): HTMLInputElement {
  const input = h('input', {
    class: 'band-range',
    props: {
      type: 'range',
      min: String(attrs.min),
      max: String(attrs.max),
      step: String(attrs.step),
    },
    attrs: { 'aria-label': label, 'data-field': label.toLowerCase() },
  });
  let base: Song | null = null;
  const next = (): Song => updateTrack(ctx.store.state.song, id, patch(Number(input.value)));
  input.oninput = () => {
    base ??= ctx.store.state.song;
    ctx.actions.previewSong(next());
  };
  input.onchange = () => {
    const from = base ?? ctx.store.state.song;
    base = null;
    ctx.actions.updateSong(next(), from);
  };
  return input;
}

function createRow(ctx: RowContext, id: string): RowView {
  const { actions } = ctx;
  const track = (): Track | undefined => songTracks(ctx.store.state.song).find((t) => t.id === id);

  const mute = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'aria-label': 'Mute', title: 'Mute (M on the selected track)', 'data-field': 'mute' },
  });
  mute.onchange = () => actions.updateTrack(id, { muted: mute.checked });

  const name = h('input', {
    class: 'band-name',
    props: { type: 'text', spellcheck: false },
    attrs: { 'aria-label': 'Track name', 'data-field': 'name' },
  });
  name.onchange = () => {
    const value = name.value.trim();
    const current = track();
    if (value === '' && current !== undefined) name.value = current.name;
    else actions.updateTrack(id, { name: value });
  };

  const role = h(
    'select',
    { attrs: { 'aria-label': 'Role', 'data-field': 'role' } },
    ...TRACK_ROLES.map((r) => option(r, ROLE_LABELS[r])),
  );
  const applyDefaults = h(
    'button',
    { class: 'band-defaults', props: { type: 'button', hidden: true } },
    'apply defaults',
  );
  role.onchange = () => {
    if (!isTrackRole(role.value)) return;
    ctx.pendingRole.set(id, role.value);
    actions.updateTrack(id, { role: role.value });
  };
  applyDefaults.onclick = () => {
    ctx.pendingRole.delete(id);
    actions.applyRoleDefaults(id);
  };

  const customOption = h('option', { props: { value: CUSTOM_PATTERN, disabled: true } }, 'Custom');
  const songGroup = h('optgroup', { props: { label: 'Song presets' } });
  let songGroupOf: readonly Pattern[] | null = null;
  const pattern = h(
    'select',
    { attrs: { 'aria-label': 'Pattern', 'data-field': 'pattern' } },
    customOption,
    ...presetGroups().map((g) =>
      h(
        'optgroup',
        { props: { label: g.label } },
        ...g.presets.map((p) => option(p.id, presetLabel(p))),
      ),
    ),
  );
  pattern.onchange = () => {
    if (pattern.value === CUSTOM_PATTERN) return;
    actions.setTrackPattern(id, pattern.value);
  };

  const numberInput = (
    label: string,
    field: string,
    min: number,
    max: number,
    patch: (value: number) => TrackPatch,
    current: (t: Track) => number,
  ): HTMLInputElement => {
    const input = h('input', {
      class: 'band-number',
      props: { type: 'number', min: String(min), max: String(max), step: '1' },
      attrs: { 'aria-label': label, 'data-field': field },
    });
    input.onchange = () => {
      const value = clampInt(input.value, min, max);
      const t = track();
      if (value === undefined) {
        if (t !== undefined) input.value = String(current(t));
        return;
      }
      input.value = String(value);
      actions.updateTrack(id, patch(value));
    };
    return input;
  };
  const octave = numberInput(
    'Octave',
    'octave',
    OCTAVE_MIN,
    OCTAVE_MAX,
    (v) => ({ octave: v }),
    (t) => t.octave,
  );
  const transpose = numberInput(
    'Transpose (semitones)',
    'transpose',
    TRANSPOSE_MIN,
    TRANSPOSE_MAX,
    (v) => ({ transpose: v }),
    (t) => t.transpose,
  );

  const channel = h(
    'select',
    { attrs: { 'aria-label': 'MIDI channel', 'data-field': 'channel' } },
    ...Array.from({ length: MIDI_CHANNELS }, (_, i) => option(String(i), String(i + 1))),
  );
  channel.onchange = () => actions.updateTrack(id, { channel: Number(channel.value) });

  const velocity = slider(
    ctx,
    id,
    'Velocity',
    { min: VELOCITY_MIN, max: VELOCITY_MAX, step: 1 },
    (v) => ({ velocity: Math.round(v) }),
  );
  const velocityValue = h('span', { class: 'band-value' });
  const gate = slider(ctx, id, 'Gate', { min: GATE_MIN, max: GATE_MAX, step: GATE_STEP }, (v) => ({
    gate: Math.min(GATE_MAX, Math.max(GATE_MIN, Math.round(v * 100) / 100)),
  }));
  const gateValue = h('span', { class: 'band-value' });

  const edit = iconButton('✎', 'Edit pattern', () =>
    actions.openPatternEditor(ctx.store.state.patternEditor === id ? null : id),
  );
  edit.dataset['field'] = 'edit-pattern';
  const instrument = instrumentPicker(ctx);

  const up = iconButton('▲', 'Move up', () => actions.moveTrack(id, -1));
  const down = iconButton('▼', 'Move down', () => actions.moveTrack(id, 1));
  const remove = iconButton('✕', 'Remove track (undo restores it)', () => actions.removeTrack(id));
  remove.classList.add('danger');

  const el = h(
    'div',
    { class: 'band-row', attrs: { role: 'listitem', 'data-track': id } },
    h('span', { class: 'band-cell band-mute' }, mute),
    h('span', { class: 'band-cell' }, name),
    h('span', { class: 'band-cell band-role' }, role, applyDefaults),
    h('span', { class: 'band-cell' }, pattern),
    h('span', { class: 'band-cell' }, octave),
    h('span', { class: 'band-cell' }, channel),
    h('span', { class: 'band-cell band-slider' }, velocity, velocityValue),
    h('span', { class: 'band-cell band-slider' }, gate, gateValue),
    h('span', { class: 'band-cell' }, transpose),
    instrument.cell,
    h('span', { class: 'band-cell band-buttons' }, edit, up, down, remove),
  );
  const selectRow = (): void => {
    if (ctx.store.state.selectedTrack !== id) actions.selectTrack(id);
  };
  el.addEventListener('pointerdown', selectRow);
  el.addEventListener('focusin', selectRow);

  return {
    el,
    update(t, index, count, selected, editing, songPresets) {
      el.classList.toggle('selected', selected);
      el.classList.toggle('editing', editing);
      edit.setAttribute('aria-pressed', String(editing));
      edit.setAttribute('aria-expanded', String(editing));
      el.classList.toggle('muted', t.muted);
      el.setAttribute('aria-current', String(selected));
      mute.checked = t.muted;
      setIfIdle(name, t.name);
      role.value = t.role;
      const pending = ctx.pendingRole.get(id);
      if (pending !== undefined && pending !== t.role) ctx.pendingRole.delete(id);
      applyDefaults.hidden = pending !== t.role || hasRoleDefaults(t);
      const d = ROLE_DEFAULTS[t.role];
      applyDefaults.title = `Octave ${d.octave}, pattern ${d.pattern}, velocity ${d.velocity}`;
      if (songPresets !== songGroupOf) {
        songGroupOf = songPresets;
        songGroup.replaceChildren(...songPresets.map((p) => option(p.id, p.name)));
        // Only listed while the song has presets of its own.
        if (songPresets.length === 0) songGroup.remove();
        else if (songGroup.parentElement !== pattern) {
          pattern.append(songGroup);
        }
      }
      const preset = isPresetPattern(t.pattern, songPresets);
      customOption.hidden = preset;
      customOption.textContent = `Custom: ${t.pattern.name}`;
      setIfIdle(pattern, preset ? t.pattern.id : CUSTOM_PATTERN);
      pattern.title = pattern.selectedOptions[0]?.textContent ?? '';
      setIfIdle(octave, String(t.octave));
      setIfIdle(channel, String(t.channel));
      setIfIdle(velocity, String(t.velocity));
      velocityValue.textContent = String(t.velocity);
      setIfIdle(gate, String(t.gate));
      gateValue.textContent = gateLabel(t.gate);
      setIfIdle(transpose, String(t.transpose));
      instrument.update(t.id, t.role);
      up.disabled = index === 0;
      down.disabled = index === count - 1;
    },
  };
}

interface MelodyRowView {
  el: HTMLElement;
  update(song: Song): void;
}

/**
 * The melody lane's row: mute and MIDI channel (song fields, undoable), the octave shift and
 * velocity of its browser sound and its instrument (sound settings). Same columns as a track.
 */
function createMelodyRow(ctx: RowContext): MelodyRowView {
  const { actions, sound } = ctx;
  const mute = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'aria-label': 'Mute melody', title: 'Mute the melody', 'data-field': 'mute' },
  });
  mute.onchange = () => {
    if (mute.checked !== songMelody(ctx.store.state.song).muted) actions.toggleMelodyMute();
  };
  const octave = h('input', {
    class: 'band-number',
    props: {
      type: 'number',
      min: String(MELODY_SHIFT_MIN),
      max: String(MELODY_SHIFT_MAX),
      step: '1',
      disabled: sound === null,
    },
    attrs: {
      'aria-label': 'Melody octave shift',
      title: 'Octave shift of the browser sound (the song keeps its notes)',
      'data-field': 'octave',
    },
  });
  octave.onchange = () => {
    const value = clampInt(octave.value, MELODY_SHIFT_MIN, MELODY_SHIFT_MAX);
    if (value !== undefined) sound?.setMelodyOctave(value);
    octave.value = String(sound?.melody.octave ?? 0);
  };
  const channel = h(
    'select',
    { attrs: { 'aria-label': 'Melody MIDI channel', 'data-field': 'channel' } },
    ...Array.from({ length: MIDI_CHANNELS }, (_, i) => option(String(i), String(i + 1))),
  );
  channel.onchange = () => actions.setMelodyChannel(Number(channel.value));
  const velocity = h('input', {
    class: 'band-range',
    props: {
      type: 'range',
      min: String(VELOCITY_MIN),
      max: String(VELOCITY_MAX),
      step: '1',
      disabled: sound === null,
    },
    attrs: {
      'aria-label': 'Melody velocity',
      title: 'Velocity of the browser sound',
      'data-field': 'velocity',
    },
  });
  const velocityValue = h('span', { class: 'band-value' });
  velocity.oninput = () => sound?.setMelodyVelocity(Number(velocity.value));
  const instrument = instrumentPicker(ctx);

  const el = h(
    'div',
    {
      class: 'band-row band-melody-row',
      attrs: { role: 'group', 'aria-label': 'Melody', 'data-track': MELODY_TRACK_ID },
    },
    h('span', { class: 'band-cell band-mute' }, mute),
    h('span', { class: 'band-cell band-melody-name' }, 'Melody'),
    h('span', { class: 'band-cell' }),
    h('span', { class: 'band-cell' }),
    h('span', { class: 'band-cell' }, octave),
    h('span', { class: 'band-cell' }, channel),
    h('span', { class: 'band-cell band-slider' }, velocity, velocityValue),
    h('span', { class: 'band-cell' }),
    h('span', { class: 'band-cell' }),
    instrument.cell,
    h('span', { class: 'band-cell band-buttons' }),
  );
  return {
    el,
    update(song) {
      const melody = songMelody(song);
      el.classList.toggle('muted', melody.muted);
      mute.checked = melody.muted;
      setIfIdle(channel, String(melody.channel));
      const settings = sound?.melody ?? { octave: 0, velocity: 100 };
      setIfIdle(octave, String(settings.octave));
      if (document.activeElement !== velocity) velocity.value = String(settings.velocity);
      velocityValue.textContent = String(settings.velocity);
      instrument.update(MELODY_TRACK_ID, null);
    },
  };
}

/**
 * Sound preset and drum pattern selects; they only change the browser sound, not the MIDI. The
 * preset reads "(custom)" while a track of the current song has its own instrument; "Reset"
 * gives every track the preset's instruments again.
 */
export function soundControls(sound: SoundSettings, store: Store | null = null): HTMLElement {
  const preset = h(
    'select',
    { attrs: { 'aria-label': 'Sound preset', 'data-field': 'sound-preset' } },
    ...SOUND_PRESETS.map((p) => option(p.id, p.name)),
  );
  const reset = h(
    'button',
    {
      class: 'band-reset',
      props: { type: 'button', hidden: true },
      attrs: { title: "Give every track the preset's instruments again", 'data-field': 'reset' },
    },
    'Reset',
  );
  reset.onclick = () => sound.setPreset(sound.preset);
  const drums = h(
    'select',
    { attrs: { 'aria-label': 'Drums', 'data-field': 'drums' } },
    ...DRUM_PATTERNS.map((p) => option(p.id, p.name)),
  );
  preset.onchange = () => {
    if (isSoundPresetId(preset.value)) sound.setPreset(preset.value);
  };
  drums.onchange = () => {
    if (isDrumPatternId(drums.value)) sound.setDrums(drums.value);
  };
  const sync = (): void => {
    const custom = store !== null && customTracks(sound.state, store.state.song).length > 0;
    for (const o of preset.options) {
      const name = SOUND_PRESETS.find((p) => p.id === o.value)?.name ?? o.value;
      o.textContent = custom && o.value === sound.preset ? `${name} (custom)` : name;
    }
    preset.value = sound.preset;
    drums.value = sound.drums;
    reset.hidden = !custom;
  };
  sync();
  sound.subscribe(sync);
  store?.subscribe((state, previous) => {
    if (state.song !== previous.song) sync();
  });
  return h(
    'div',
    { class: 'band-sound' },
    h('label', {}, 'Sound ', preset),
    reset,
    h('label', {}, 'Drums ', drums),
    h('span', { class: 'hint' }, 'Browser playback only; MIDI out and export are unchanged.'),
  );
}

/** Master volume slider and protection-mode select (browser sound only, kept locally). */
export function masterControls(master: MasterSettings): HTMLElement {
  const volume = h('input', {
    class: 'band-range',
    props: { type: 'range', min: '0', max: '100', step: '1' },
    attrs: { 'aria-label': 'Master volume', 'data-field': 'master-volume' },
  });
  const value = h('span', { class: 'band-value' });
  const mode = h(
    'select',
    { attrs: { 'aria-label': 'Output protection', 'data-field': 'master-mode' } },
    ...MASTER_MODES.map((m) => option(m, MASTER_MODE_LABELS[m])),
  );
  volume.oninput = () => master.setVolume(Number(volume.value));
  mode.onchange = () => {
    if (isMasterMode(mode.value)) master.setMode(mode.value);
  };
  const sync = (): void => {
    const { volume: v, mode: m } = master.state;
    if (document.activeElement !== volume) volume.value = String(v);
    value.textContent = `${v}%`;
    mode.value = m;
  };
  sync();
  master.subscribe(sync);
  return h(
    'div',
    { class: 'band-master' },
    h('label', { class: 'band-slider' }, 'Volume ', volume, value),
    h('label', {}, 'Protect ', mode),
  );
}

export function mountBand(
  root: HTMLElement,
  store: Store,
  actions: Actions,
  storage: SongStorage | null = null,
  sound: SoundSettings | null = null,
  master: MasterSettings | null = null,
  options: { defaultOpen?: boolean; samples?: SampleStatus | null } = {},
): void {
  root.classList.add('panel', 'band');
  let open = loadBandOpen(storage, options.defaultOpen);
  const samples = options.samples ?? null;
  const ctx: RowContext = { store, actions, pendingRole: new Map(), sound, samples };
  const melodyRow = createMelodyRow(ctx);

  const toggle = h(
    'button',
    { class: 'band-toggle', props: { type: 'button' }, attrs: { 'aria-controls': 'band-body' } },
    h('span', { class: 'caret', attrs: { 'aria-hidden': 'true' } }),
    h('h2', {}, 'Band'),
  );
  const summary = h('span', { class: 'band-summary' });
  const rowsEl = h('div', { class: 'band-rows', attrs: { role: 'list', 'aria-label': 'Tracks' } });
  const addRole = h(
    'select',
    { attrs: { 'aria-label': 'Role of the new track' } },
    ...TRACK_ROLES.map((r) => option(r, ROLE_LABELS[r])),
  );
  const add = h('button', { props: { type: 'button' } }, '+ Add track');
  add.onclick = () => {
    if (isTrackRole(addRole.value)) actions.addTrack(addRole.value);
  };
  const body = h(
    'div',
    { class: 'band-body', attrs: { id: 'band-body' } },
    ...(sound === null ? [] : [soundControls(sound, store)]),
    ...(master === null ? [] : [masterControls(master)]),
    h(
      'div',
      { class: 'band-row band-labels', attrs: { 'aria-hidden': 'true' } },
      ...BAND_COLUMNS.map((c) => h('span', { class: 'band-cell' }, c)),
    ),
    rowsEl,
    h('div', { class: 'band-melody' }, melodyRow.el),
    h('div', { class: 'band-add' }, addRole, add),
    h(
      'p',
      { class: 'hint' },
      'Every track plays on its own MIDI channel. Click a row to select it (auditions play ' +
        'through it); M mutes the selected track; ✎ opens its pattern editor.',
    ),
  );
  root.append(h('header', { class: 'panel-head' }, toggle, summary), body);

  toggle.onclick = () => {
    open = !open;
    saveBandOpen(storage, open);
    last = [];
    render(store.state);
  };

  const rows = new Map<string, RowView>();
  const editor = createPatternEditor(store, actions);
  let last: unknown[] = [];
  /** Bumped when the sound settings or a loading state change (they are not in the store). */
  let soundVersion = 0;

  const render = (state: AppState): void => {
    const tracks = songTracks(state.song);
    const presets = songPatterns(state.song);
    const inputs = [
      tracks,
      state.selectedTrack,
      open,
      state.patternEditor,
      presets,
      songMelody(state.song),
      soundVersion,
    ];
    if (inputs.every((v, i) => v === last[i])) return;
    last = inputs;

    body.hidden = !open;
    root.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    const audible = tracks.filter((t) => !t.muted).length;
    summary.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${audible} audible`;

    for (const [id, row] of rows) {
      if (!tracks.some((t) => t.id === id)) {
        row.el.remove();
        rows.delete(id);
        ctx.pendingRole.delete(id);
      }
    }
    const ordered = tracks.map((t) => {
      let row = rows.get(t.id);
      if (row === undefined) {
        row = createRow(ctx, t.id);
        rows.set(t.id, row);
      }
      return row;
    });
    const editing = tracks.find((t) => t.id === state.patternEditor);
    const wanted = ordered.flatMap((r, i) =>
      editing !== undefined && tracks[i] === editing ? [r.el, editor.el] : [r.el],
    );
    const current = [...rowsEl.children];
    if (wanted.length !== current.length || wanted.some((el, i) => el !== current[i])) {
      const focused = document.activeElement;
      rowsEl.replaceChildren(...wanted);
      if (
        focused instanceof HTMLElement &&
        focused !== document.activeElement &&
        focused.isConnected
      ) {
        focused.focus();
      }
    }
    tracks.forEach((t, i) =>
      ordered[i]?.update(
        t,
        i,
        tracks.length,
        t.id === state.selectedTrack,
        t.id === state.patternEditor,
        presets,
      ),
    );
    if (editing !== undefined) editor.update(editing, state.song);
    if (tracks.length === 0) {
      rowsEl.append(h('p', { class: 'hint band-empty' }, 'No tracks: add one to hear the song.'));
    }
    melodyRow.update(state.song);
  };

  const refresh = (): void => {
    soundVersion += 1;
    render(store.state);
  };
  render(store.state);
  store.subscribe(render);
  sound?.subscribe(refresh);
  samples?.subscribe(refresh);
}

function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h(
    'button',
    { class: 'icon', props: { type: 'button' }, attrs: { title, 'aria-label': title } },
    text,
  );
  b.onclick = onClick;
  return b;
}
