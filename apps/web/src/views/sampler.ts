/**
 * The Sampler panel (docs/specs/sampler-v1.md §7): opens inside the Band panel under the track
 * that plays a sampler slot. Waveform with draggable trim and loop markers (a canvas, redrawn
 * only when something it shows changes), pitch, loop, envelope, filter and level controls, an
 * audition strip, and drag-and-drop of an audio file. Everything goes through the `Samplers` edit
 * API; nothing here plays on its own.
 */
import { noteName, toPitchClass } from '@crokychords/core';
import type { SamplerId } from '../audio/instruments';
import { SAMPLER_IDS, samplerSlot } from '../audio/instruments';
import type { AuditionHandle, SamplerPatch, Samplers, WaveformPeaks } from '../audio/sampler';
import { FILTER_TYPES, LOOP_MODES, MIN_LOOP, MIN_TRIM, RANGES, loadError } from '../audio/sampler';
import { h, option } from '../dom';

/** Note name with octave: 60 → "C4", 61 → "C#4". */
export function noteLabel(note: number): string {
  return `${noteName(toPitchClass(note))}${Math.floor(note / 12) - 1}`;
}

/** Steps of the logarithmic sliders. */
export const LOG_STEPS = 1000;

/** Slider position (0…LOG_STEPS) of `value` on a logarithmic scale from `min` to `max`. */
export function toLog(value: number, min: number, max: number): number {
  const v = Math.min(max, Math.max(min, value));
  return Math.round((Math.log(v / min) / Math.log(max / min)) * LOG_STEPS);
}

/** The value at slider position `x` of a logarithmic scale from `min` to `max`. */
export function fromLog(x: number, min: number, max: number): number {
  return min * (max / min) ** (Math.min(LOG_STEPS, Math.max(0, x)) / LOG_STEPS);
}

/** "12 ms", "1.20 s". */
export function secondsLabel(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;
}

/** "880 Hz", "12.0 kHz". */
export function hertzLabel(hz: number): string {
  return hz < 1000 ? `${Math.round(hz)} Hz` : `${(hz / 1000).toFixed(1)} kHz`;
}

export type Marker = 'start' | 'end' | 'loopStart' | 'loopEnd';

/** The markers the waveform shows, with their frames (loop markers only while the loop is on). */
export function markerFrames(patch: SamplerPatch): { marker: Marker; frame: number }[] {
  const markers: { marker: Marker; frame: number }[] = [
    { marker: 'start', frame: patch.start },
    { marker: 'end', frame: patch.end },
  ];
  if (patch.loop.enabled) {
    markers.push({ marker: 'loopStart', frame: patch.loop.start });
    markers.push({ marker: 'loopEnd', frame: patch.loop.end });
  }
  return markers;
}

/** The marker nearest to `x` (CSS px over a waveform `width` px wide) within `radius`, or null. */
export function nearestMarker(
  patch: SamplerPatch,
  x: number,
  width: number,
  radius = 8,
): Marker | null {
  const frames = patch.sample?.frames ?? 0;
  if (frames === 0 || width <= 0) return null;
  let best: Marker | null = null;
  let distance = radius;
  for (const { marker, frame } of markerFrames(patch)) {
    const d = Math.abs((frame / frames) * width - x);
    // Loop markers win ties: they sit inside the trim and are the ones moved most.
    if (d < distance || (d === distance && best !== null && marker.startsWith('loop'))) {
      best = marker;
      distance = d;
    }
  }
  return best;
}

/** Move `marker` to `frame`, never past its partner. */
export function moveMarker(samplers: Samplers, id: SamplerId, marker: Marker, frame: number): void {
  const p = samplers.patch(id);
  const f = Math.round(frame);
  switch (marker) {
    case 'start':
      samplers.trim(id, Math.min(f, p.end - MIN_TRIM), p.end);
      break;
    case 'end':
      samplers.trim(id, p.start, Math.max(f, p.start + MIN_TRIM));
      break;
    case 'loopStart':
      samplers.setLoop(id, { start: Math.min(f, p.loop.end - MIN_LOOP) });
      break;
    case 'loopEnd':
      samplers.setLoop(id, { end: Math.max(f, p.loop.start + MIN_LOOP) });
      break;
  }
}

/** Theme colours of the waveform, read from the CSS tokens. */
interface WaveColours {
  background: string;
  wave: string;
  line: string;
  dim: string;
  loop: string;
  marker: string;
  loopMarker: string;
}

function themeColours(el: Element): WaveColours {
  const style = getComputedStyle(el);
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--panel-2', 'Canvas'),
    wave: token('--accent', 'CanvasText'),
    line: token('--line', 'GrayText'),
    dim: token('--muted', 'GrayText'),
    loop: token('--ok', 'Highlight'),
    marker: token('--text', 'CanvasText'),
    loopMarker: token('--ok', 'Highlight'),
  };
}

/** Draw the waveform, the trimmed-off parts, the loop region and the markers. */
function drawWaveform(
  g: CanvasRenderingContext2D,
  peaks: WaveformPeaks,
  patch: SamplerPatch,
  width: number,
  height: number,
  colours: WaveColours,
): void {
  const frames = patch.sample?.frames ?? 1;
  const xOf = (frame: number): number => Math.round((frame / frames) * width);
  const mid = Math.floor(height / 2);
  g.globalAlpha = 1;
  g.fillStyle = colours.background;
  g.fillRect(0, 0, width, height);
  if (patch.loop.enabled) {
    g.globalAlpha = 0.18;
    g.fillStyle = colours.loop;
    g.fillRect(xOf(patch.loop.start), 0, xOf(patch.loop.end) - xOf(patch.loop.start), height);
  }
  g.globalAlpha = 1;
  g.fillStyle = colours.line;
  g.fillRect(0, mid, width, 1);
  g.fillStyle = colours.wave;
  const columns = peaks.min.length;
  for (let x = 0; x < columns; x++) {
    const hi = mid - Math.round((peaks.max[x] ?? 0) * (mid - 2));
    const lo = mid - Math.round((peaks.min[x] ?? 0) * (mid - 2));
    g.fillRect(x, hi, 1, Math.max(1, lo - hi + 1));
  }
  g.globalAlpha = 0.6;
  g.fillStyle = colours.background;
  g.fillRect(0, 0, xOf(patch.start), height);
  g.fillRect(xOf(patch.end), 0, width - xOf(patch.end), height);
  g.globalAlpha = 1;
  const markerWidth = Math.max(1, Math.round(width / 600));
  for (const { marker, frame } of markerFrames(patch)) {
    const loop = marker.startsWith('loop');
    g.fillStyle = loop ? colours.loopMarker : colours.marker;
    const x = Math.min(width - markerWidth, xOf(frame));
    g.fillRect(x, 0, markerWidth, height);
    const tab = loop ? height - 8 : 0;
    g.fillRect(marker === 'end' || marker === 'loopEnd' ? x - 6 : x, tab, 6, 8);
  }
}

interface Control {
  el: HTMLElement;
  sync(patch: SamplerPatch): void;
}

/** A labelled range input with its value; `get` reads the model value, `set` writes it. */
function range(
  label: string,
  field: string,
  limits: { min: number; max: number; step: number },
  get: (p: SamplerPatch) => number,
  set: (x: number) => void,
  format: (p: SamplerPatch) => string,
): Control {
  const input = h('input', {
    props: {
      type: 'range',
      min: String(limits.min),
      max: String(limits.max),
      step: String(limits.step),
    },
    attrs: { 'aria-label': label, 'data-field': field },
  });
  const value = h('span', { class: 'sampler-value' });
  input.oninput = () => set(Number(input.value));
  const el = h('label', { class: 'sampler-range' }, h('span', {}, label), input, value);
  return {
    el,
    sync(p) {
      const x = String(get(p));
      if (input.value !== x && document.activeElement !== input) input.value = x;
      value.textContent = format(p);
    },
  };
}

function checkbox(
  label: string,
  field: string,
  get: (p: SamplerPatch) => boolean,
  set: (on: boolean) => void,
): Control {
  const input = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'aria-label': label, 'data-field': field },
  });
  input.onchange = () => set(input.checked);
  return {
    el: h('label', { class: 'sampler-check' }, input, label),
    sync(p) {
      input.checked = get(p);
    },
  };
}

function select<T extends string>(
  label: string,
  field: string,
  values: readonly { value: T; label: string }[],
  get: (p: SamplerPatch) => T,
  set: (value: T) => void,
): Control {
  const input = h(
    'select',
    { attrs: { 'aria-label': label, 'data-field': field } },
    ...values.map((v) => option(v.value, v.label)),
  );
  input.onchange = () => {
    const picked = values.find((v) => v.value === input.value);
    if (picked !== undefined) set(picked.value);
  };
  return {
    el: h('label', { class: 'sampler-select' }, h('span', {}, label), input),
    sync(p) {
      input.value = get(p);
    },
  };
}

function group(title: string, ...controls: Control[]): { el: HTMLElement; controls: Control[] } {
  return {
    el: h(
      'fieldset',
      { class: 'sampler-group' },
      h('legend', {}, title),
      ...controls.map((c) => c.el),
    ),
    controls,
  };
}

const FILTER_LABELS: Readonly<Record<(typeof FILTER_TYPES)[number], string>> = {
  lowpass: 'Lowpass',
  highpass: 'Highpass',
  bandpass: 'Bandpass',
};
const LOOP_LABELS: Readonly<Record<(typeof LOOP_MODES)[number], string>> = {
  forward: 'Forward',
  pingpong: 'Ping-pong',
};

const signed = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v)}`;

export interface SamplerPanelOptions {
  samplers: Samplers;
  /** The slot select changed: make the track play `id`. */
  assign(id: SamplerId): void;
  close(): void;
}

export interface SamplerPanel {
  el: HTMLElement;
  /** Show slot `id` for the track called `label`. */
  show(id: SamplerId, label: string): void;
  /** Bring the panel up to date with its slot (cheap when nothing changed). */
  update(): void;
  readonly slot: SamplerId | null;
}

export function createSamplerPanel(options: SamplerPanelOptions): SamplerPanel {
  const { samplers } = options;
  let slot: SamplerId | null = null;
  const id = (): SamplerId => slot ?? 'sampler-1';
  const edit = (run: (id: SamplerId) => void): void => {
    if (slot !== null) run(slot);
  };

  // Head -----------------------------------------------------------------------------------
  const forLabel = h('span', { class: 'sampler-for' });
  const slotSelect = h(
    'select',
    { attrs: { 'aria-label': 'Sampler slot', 'data-field': 'slot' } },
    ...SAMPLER_IDS.map((s) => option(s, String(samplerSlot(s)))),
  );
  slotSelect.onchange = () => {
    const picked = SAMPLER_IDS.find((s) => s === slotSelect.value);
    if (picked !== undefined) options.assign(picked);
  };
  const name = h('input', {
    class: 'sampler-name',
    props: { type: 'text', spellcheck: false, maxLength: 24 },
    attrs: { 'aria-label': 'Slot name', 'data-field': 'name' },
  });
  name.onchange = () => edit((s) => samplers.rename(s, name.value));
  const program = h('input', {
    class: 'sampler-program',
    props: { type: 'number', min: '1', max: '128', step: '1' },
    attrs: {
      'aria-label': 'General MIDI program for the export',
      title: 'General MIDI program written to the .mid export (1–128)',
      'data-field': 'program',
    },
  });
  program.onchange = () => edit((s) => samplers.setProgram(s, Number(program.value) - 1));
  const file = h('input', {
    class: 'sampler-file-input',
    props: { type: 'file', accept: 'audio/*,.wav,.ogg,.flac,.mp3', hidden: true },
    attrs: { 'aria-label': 'Sample file', 'data-field': 'file' },
  });
  const loadButton = h(
    'button',
    { props: { type: 'button' }, attrs: { 'data-field': 'load' } },
    'Load sample…',
  );
  loadButton.onclick = () => file.click();
  const remove = h(
    'button',
    { class: 'danger', props: { type: 'button' }, attrs: { 'data-field': 'remove' } },
    'Remove',
  );
  remove.onclick = () =>
    edit((s) => {
      void samplers.clear(s).catch((e: unknown) => showError(`Could not remove: ${loadError(e)}`));
    });
  const info = h('span', { class: 'sampler-info', attrs: { 'data-field': 'info' } });
  const close = h(
    'button',
    {
      class: 'icon',
      props: { type: 'button' },
      attrs: { title: 'Close the sampler (Esc)', 'aria-label': 'Close the sampler' },
    },
    '✕',
  );
  close.onclick = () => options.close();
  const head = h(
    'div',
    { class: 'sampler-head' },
    h('h3', { class: 'sampler-title' }, 'Sampler'),
    forLabel,
    h('label', { class: 'sampler-select' }, h('span', {}, 'Slot'), slotSelect),
    name,
    h('label', { class: 'sampler-select' }, h('span', {}, 'GM'), program),
    loadButton,
    file,
    remove,
    info,
    close,
  );
  const error = h('p', {
    class: 'sampler-error',
    props: { hidden: true },
    attrs: { role: 'status', 'data-field': 'error' },
  });
  let shownError: string | null = null;
  const showError = (message: string | null): void => {
    shownError = message;
    error.textContent = message ?? '';
    error.hidden = message === null;
  };

  // Waveform ---------------------------------------------------------------------------------
  const canvas = h('canvas', {
    class: 'sampler-wave',
    attrs: {
      'aria-label': 'Waveform: drag the S and E markers to trim, the L markers to set the loop',
      'data-field': 'waveform',
    },
  });
  const empty = h(
    'p',
    { class: 'sampler-empty' },
    'Drop an audio file here or load one (wav, ogg, flac, mp3; up to 10 MB).',
  );
  const wave = h('div', { class: 'sampler-wave-wrap' }, canvas, empty);
  let drawn = '';
  const draw = (): void => {
    const p = samplers.patch(id());
    // Show the canvas first, so it has its size when it is measured.
    empty.hidden = p.sample !== null;
    canvas.hidden = p.sample === null;
    const width = Math.round(canvas.clientWidth);
    const height = Math.round(canvas.clientHeight);
    const ratio = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const theme = document.documentElement.dataset['theme'] ?? '';
    const key = JSON.stringify([
      slot,
      samplers.state(id()),
      p.sample?.savedAt,
      p.start,
      p.end,
      p.loop,
      width,
      height,
      ratio,
      theme,
    ]);
    if (key === drawn) return;
    drawn = key;
    const peaks = width > 0 ? samplers.waveform(id(), width * ratio) : null;
    if (peaks === null || height <= 0) return;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const g = canvas.getContext('2d');
    if (g === null) return;
    drawWaveform(g, peaks, p, width * ratio, height * ratio, themeColours(canvas));
  };
  let dragging: Marker | null = null;
  const frameAt = (event: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    const frames = samplers.patch(id()).sample?.frames ?? 0;
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    return rect.width > 0 ? (x / rect.width) * frames : 0;
  };
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const marker = nearestMarker(samplers.patch(id()), event.clientX - rect.left, rect.width);
    if (marker === null || slot === null) return;
    dragging = marker;
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (dragging !== null && slot !== null) moveMarker(samplers, slot, dragging, frameAt(event));
    else {
      const rect = canvas.getBoundingClientRect();
      const over = nearestMarker(samplers.patch(id()), event.clientX - rect.left, rect.width);
      canvas.classList.toggle('over-marker', over !== null);
    }
  });
  const endDrag = (): void => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Controls ---------------------------------------------------------------------------------
  const root = h('input', {
    class: 'sampler-root',
    props: { type: 'number', min: '0', max: '127', step: '1' },
    attrs: { 'aria-label': 'Root note (MIDI)', 'data-field': 'root' },
  });
  const rootName = h('span', { class: 'sampler-value' });
  root.onchange = () => edit((s) => samplers.setRoot(s, Number(root.value)));
  const detect = h(
    'button',
    {
      props: { type: 'button' },
      attrs: { title: 'Detect the root from the trimmed sample', 'data-field': 'detect' },
    },
    'Detect',
  );
  detect.onclick = () =>
    edit((s) => {
      if (samplers.detectRoot(s) === null) showError('No clear pitch found; set the root by hand.');
      else showError(null);
    });
  const rootControl: Control = {
    el: h(
      'label',
      { class: 'sampler-range sampler-root-row' },
      h('span', {}, 'Root'),
      root,
      rootName,
      detect,
    ),
    sync(p) {
      if (document.activeElement !== root) root.value = String(p.root);
      rootName.textContent = noteLabel(p.root);
      detect.disabled = p.sample === null;
    },
  };
  const r = RANGES;
  const pitch = group(
    'Pitch',
    rootControl,
    range(
      'Tune',
      'tune',
      { min: r.tune.min, max: r.tune.max, step: 1 },
      (p) => p.tune,
      (x) => edit((s) => samplers.setTune(s, x)),
      (p) => `${signed(p.tune)} ct`,
    ),
    range(
      'Keytrack',
      'keytrack',
      { min: 0, max: 100, step: 1 },
      (p) => p.keytrack,
      (x) => edit((s) => samplers.setKeytrack(s, x)),
      (p) => `${Math.round(p.keytrack)}%`,
    ),
    checkbox(
      'Reverse',
      'reverse',
      (p) => p.reverse,
      (on) => edit((s) => samplers.setReverse(s, on)),
    ),
  );
  const loop = group(
    'Loop',
    checkbox(
      'Loop',
      'loop',
      (p) => p.loop.enabled,
      (on) => edit((s) => samplers.setLoop(s, { enabled: on })),
    ),
    select(
      'Mode',
      'loop-mode',
      LOOP_MODES.map((m) => ({ value: m, label: LOOP_LABELS[m] })),
      (p) => p.loop.mode,
      (mode) => edit((s) => samplers.setLoop(s, { mode })),
    ),
    range(
      'X-fade',
      'crossfade',
      { min: 0, max: 500, step: 1 },
      (p) => Math.round((p.loop.crossfade / (p.sample?.sampleRate ?? 48000)) * 1000),
      (ms) =>
        edit((s) =>
          samplers.setLoop(s, {
            crossfade: (ms / 1000) * (samplers.patch(s).sample?.sampleRate ?? 48000),
          }),
        ),
      (p) => secondsLabel(p.loop.crossfade / (p.sample?.sampleRate ?? 48000)),
    ),
  );
  const timeRange = (label: string, field: 'attack' | 'decay' | 'release'): Control =>
    range(
      label,
      field,
      { min: 0, max: LOG_STEPS, step: 1 },
      (p) => toLog(p.envelope[field], r[field].min, r[field].max),
      (x) =>
        edit((s) => samplers.setEnvelope(s, { [field]: fromLog(x, r[field].min, r[field].max) })),
      (p) => secondsLabel(p.envelope[field]),
    );
  const envelope = group(
    'Envelope',
    timeRange('Attack', 'attack'),
    timeRange('Decay', 'decay'),
    range(
      'Sustain',
      'sustain',
      { min: 0, max: 100, step: 1 },
      (p) => Math.round(p.envelope.sustain * 100),
      (x) => edit((s) => samplers.setEnvelope(s, { sustain: x / 100 })),
      (p) => `${Math.round(p.envelope.sustain * 100)}%`,
    ),
    timeRange('Release', 'release'),
  );
  const filter = group(
    'Filter',
    select(
      'Type',
      'filter-type',
      FILTER_TYPES.map((t) => ({ value: t, label: FILTER_LABELS[t] })),
      (p) => p.filter.type,
      (type) => edit((s) => samplers.setFilter(s, { type })),
    ),
    range(
      'Cutoff',
      'cutoff',
      { min: 0, max: LOG_STEPS, step: 1 },
      (p) => toLog(p.filter.cutoff, r.cutoff.min, r.cutoff.max),
      (x) => edit((s) => samplers.setFilter(s, { cutoff: fromLog(x, r.cutoff.min, r.cutoff.max) })),
      (p) => hertzLabel(p.filter.cutoff),
    ),
    range(
      'Reso',
      'resonance',
      { min: 0, max: 100, step: 1 },
      (p) => Math.round(p.filter.resonance),
      (x) => edit((s) => samplers.setFilter(s, { resonance: x })),
      (p) => `${Math.round(p.filter.resonance)}%`,
    ),
    range(
      'Env',
      'env-amount',
      { min: r.envAmount.min, max: r.envAmount.max, step: 1 },
      (p) => Math.round(p.filter.envAmount),
      (x) => edit((s) => samplers.setFilter(s, { envAmount: x })),
      (p) => `${signed(p.filter.envAmount)}%`,
    ),
  );
  const levels = group(
    'Level',
    range(
      'Gain',
      'gain',
      { min: r.gain.min, max: r.gain.max, step: 0.5 },
      (p) => p.gain,
      (x) => edit((s) => samplers.setLevels(s, { gain: x })),
      (p) => `${p.gain > 0 ? '+' : ''}${p.gain.toFixed(1)} dB`,
    ),
    range(
      'Pan',
      'pan',
      { min: -100, max: 100, step: 1 },
      (p) => Math.round(p.pan * 100),
      (x) => edit((s) => samplers.setLevels(s, { pan: x / 100 })),
      (p) => (p.pan === 0 ? 'C' : `${p.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(p.pan) * 100)}`),
    ),
    range(
      'Vel→gain',
      'velocity-gain',
      { min: 0, max: 100, step: 1 },
      (p) => Math.round(p.velocityToGain),
      (x) => edit((s) => samplers.setLevels(s, { velocityToGain: x })),
      (p) => `${Math.round(p.velocityToGain)}%`,
    ),
    range(
      'Vel→cut',
      'velocity-cutoff',
      { min: 0, max: 100, step: 1 },
      (p) => Math.round(p.velocityToCutoff),
      (x) => edit((s) => samplers.setLevels(s, { velocityToCutoff: x })),
      (p) => `${Math.round(p.velocityToCutoff)}%`,
    ),
  );
  const groups = [pitch, loop, envelope, filter, levels];
  const controls = groups.flatMap((g) => g.controls);

  // Audition strip ---------------------------------------------------------------------------
  const keys = h('div', {
    class: 'sampler-keys',
    attrs: { role: 'group', 'aria-label': 'Audition: press a key to hear the sample' },
  });
  let keysFor = -1;
  const sounding = new Map<number, AuditionHandle>();
  const releaseKey = (pointer: number): void => {
    sounding.get(pointer)?.release();
    sounding.delete(pointer);
  };
  const buildKeys = (rootNote: number): void => {
    const base = Math.max(0, Math.min(103, rootNote - (rootNote % 12)));
    if (base === keysFor) return;
    keysFor = base;
    keys.replaceChildren(
      ...Array.from({ length: 25 }, (_, i) => {
        const note = base + i;
        const black = [1, 3, 6, 8, 10].includes(note % 12);
        const key = h('button', {
          class: `sampler-key${black ? ' black' : ''}`,
          props: { type: 'button', tabIndex: -1 },
          attrs: {
            title: noteLabel(note),
            'aria-label': noteLabel(note),
            'data-note': String(note),
          },
        });
        key.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          if (slot === null) return;
          key.setPointerCapture?.(event.pointerId);
          releaseKey(event.pointerId);
          const handle = samplers.audition(slot, note, 100);
          if (handle !== null) sounding.set(event.pointerId, handle);
          key.classList.add('down');
        });
        const up = (event: PointerEvent): void => {
          releaseKey(event.pointerId);
          key.classList.remove('down');
        };
        key.addEventListener('pointerup', up);
        key.addEventListener('pointercancel', up);
        key.addEventListener('lostpointercapture', up);
        return key;
      }),
    );
  };

  // Panel ------------------------------------------------------------------------------------
  const el = h(
    'section',
    { class: 'sampler-panel', attrs: { 'aria-label': 'Sampler', 'data-field': 'sampler' } },
    head,
    error,
    wave,
    h('div', { class: 'sampler-controls' }, ...groups.map((g) => g.el)),
    keys,
  );
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    options.close();
  });
  const loadFile = (picked: File): void => {
    const target = slot;
    if (target === null) return;
    showError(null);
    info.textContent = `Loading ${picked.name}…`;
    samplers.load(target, picked).then(
      () => update(),
      (e: unknown) => {
        showError(`Could not load ${picked.name}: ${loadError(e)}`);
        update();
      },
    );
  };
  file.onchange = () => {
    const picked = file.files?.[0];
    file.value = '';
    if (picked !== undefined) loadFile(picked);
  };
  const hasFiles = (event: DragEvent): boolean =>
    [...(event.dataTransfer?.types ?? [])].includes('Files');
  el.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    el.classList.add('dropping');
  });
  el.addEventListener('dragleave', (event) => {
    if (event.target === el) el.classList.remove('dropping');
  });
  el.addEventListener('drop', (event) => {
    el.classList.remove('dropping');
    const picked = event.dataTransfer?.files[0];
    if (picked === undefined) return;
    event.preventDefault();
    loadFile(picked);
  });

  const update = (): void => {
    if (slot === null) return;
    const p = samplers.patch(slot);
    for (const o of slotSelect.options) {
      const s = SAMPLER_IDS.find((x) => x === o.value);
      if (s !== undefined) o.textContent = `${samplerSlot(s)} · ${samplers.patch(s).name}`;
    }
    slotSelect.value = slot;
    if (document.activeElement !== name) name.value = p.name;
    if (document.activeElement !== program) program.value = String(p.program + 1);
    const state = samplers.state(slot);
    remove.disabled = p.sample === null;
    if (state === 'loading') info.textContent = 'Loading…';
    else if (p.sample === null) info.textContent = 'No sample';
    else {
      const seconds = (p.end - p.start) / p.sample.sampleRate;
      info.textContent = `${p.sample.name} · ${secondsLabel(seconds)}`;
    }
    info.title = p.sample?.name ?? '';
    const failure = state === 'error' ? samplers.error(slot) : null;
    if (failure !== null) showError(`Could not load the sample: ${failure}`);
    else if (shownError?.startsWith('Could not load the sample') === true) showError(null);
    for (const c of controls) c.sync(p);
    buildKeys(p.root);
    for (const key of keys.children) {
      if (key instanceof HTMLElement)
        key.classList.toggle('root', key.dataset['note'] === String(p.root));
    }
    draw();
  };

  // Redraw on resize and on a theme switch (the colours come from the tokens).
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => draw()).observe(canvas);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      drawn = '';
      draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  return {
    el,
    show(next, label) {
      if (slot !== next) {
        for (const pointer of [...sounding.keys()]) releaseKey(pointer);
        showError(null);
      }
      slot = next;
      forLabel.textContent = `for ${label}`;
      update();
    },
    update,
    get slot() {
      return slot;
    },
  };
}
