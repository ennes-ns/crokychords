/**
 * Band panel: the browser sound (preset and drum pattern), then one row per track (mute, name,
 * role, pattern, octave, MIDI channel, velocity, gate, transpose, reorder, remove) plus "Add
 * track". Rows are patched in place, so focused
 * inputs and dragged sliders survive store updates; every edit is a song commit (undoable).
 */
import type { Song, Track, TrackRole } from '@crokychords/core';
import { ROLE_DEFAULTS, TRACK_ROLES } from '@crokychords/core';
import type { Actions } from '../actions';
import {
  DRUM_PATTERNS,
  SOUND_PRESETS,
  isDrumPatternId,
  isSoundPresetId,
} from '../audio/instruments';
import type { SoundSettings } from '../audio/sound';
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
  setTrackPattern,
  songTracks,
  updateTrack,
} from '../band';
import { h, option } from '../dom';
import type { SongStorage } from '../persist';
import { loadBandOpen, saveBandOpen } from '../persist';
import type { AppState, Store } from '../state';

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
  update(track: Track, index: number, count: number, selected: boolean): void;
}

interface RowContext {
  store: Store;
  actions: Actions;
  /** Role a track was switched to in this session; shows "apply defaults" until used. */
  pendingRole: Map<string, TrackRole>;
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
  const pattern = h(
    'select',
    { attrs: { 'aria-label': 'Pattern', 'data-field': 'pattern' } },
    customOption,
    ...presetGroups().map((g) =>
      h('optgroup', { props: { label: g.label } }, ...g.presets.map((p) => option(p.id, p.name))),
    ),
  );
  pattern.onchange = () => {
    if (pattern.value === CUSTOM_PATTERN) return;
    actions.updateSong(setTrackPattern(ctx.store.state.song, id, pattern.value));
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
    h('span', { class: 'band-cell band-buttons' }, up, down, remove),
  );
  const selectRow = (): void => {
    if (ctx.store.state.selectedTrack !== id) actions.selectTrack(id);
  };
  el.addEventListener('pointerdown', selectRow);
  el.addEventListener('focusin', selectRow);

  return {
    el,
    update(t, index, count, selected) {
      el.classList.toggle('selected', selected);
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
      const preset = isPresetPattern(t.pattern);
      customOption.hidden = preset;
      customOption.textContent = `Custom: ${t.pattern.name}`;
      setIfIdle(pattern, preset ? t.pattern.id : CUSTOM_PATTERN);
      setIfIdle(octave, String(t.octave));
      setIfIdle(channel, String(t.channel));
      setIfIdle(velocity, String(t.velocity));
      velocityValue.textContent = String(t.velocity);
      setIfIdle(gate, String(t.gate));
      gateValue.textContent = gateLabel(t.gate);
      setIfIdle(transpose, String(t.transpose));
      up.disabled = index === 0;
      down.disabled = index === count - 1;
    },
  };
}

/** Sound preset and drum pattern selects; they only change the browser sound, not the MIDI. */
export function soundControls(sound: SoundSettings): HTMLElement {
  const preset = h(
    'select',
    { attrs: { 'aria-label': 'Sound preset', 'data-field': 'sound-preset' } },
    ...SOUND_PRESETS.map((p) => option(p.id, p.name)),
  );
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
    preset.value = sound.preset;
    drums.value = sound.drums;
  };
  sync();
  sound.subscribe(sync);
  return h(
    'div',
    { class: 'band-sound' },
    h('label', {}, 'Sound ', preset),
    h('label', {}, 'Drums ', drums),
    h('span', { class: 'hint' }, 'Browser playback only; MIDI out and export are unchanged.'),
  );
}

export function mountBand(
  root: HTMLElement,
  store: Store,
  actions: Actions,
  storage: SongStorage | null = null,
  sound: SoundSettings | null = null,
): void {
  root.classList.add('panel', 'band');
  let open = loadBandOpen(storage);
  const ctx: RowContext = { store, actions, pendingRole: new Map() };

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
    ...(sound === null ? [] : [soundControls(sound)]),
    h(
      'div',
      { class: 'band-row band-labels', attrs: { 'aria-hidden': 'true' } },
      ...BAND_COLUMNS.map((c) => h('span', { class: 'band-cell' }, c)),
    ),
    rowsEl,
    h('div', { class: 'band-add' }, addRole, add),
    h(
      'p',
      { class: 'hint' },
      'Every track plays on its own MIDI channel. Click a row to select it (auditions play ' +
        'through it); M mutes the selected track.',
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
  let last: unknown[] = [];

  const render = (state: AppState): void => {
    const tracks = songTracks(state.song);
    const inputs = [tracks, state.selectedTrack, open];
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
    const current = [...rowsEl.children];
    if (ordered.length !== current.length || ordered.some((r, i) => r.el !== current[i])) {
      const focused = document.activeElement;
      rowsEl.replaceChildren(...ordered.map((r) => r.el));
      if (
        focused instanceof HTMLElement &&
        focused !== document.activeElement &&
        focused.isConnected
      ) {
        focused.focus();
      }
    }
    tracks.forEach((t, i) => ordered[i]?.update(t, i, tracks.length, t.id === state.selectedTrack));
    if (tracks.length === 0) {
      rowsEl.append(h('p', { class: 'hint band-empty' }, 'No tracks: add one to hear the song.'));
    }
  };

  render(store.state);
  store.subscribe(render);
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
