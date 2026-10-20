/**
 * Akai Fire SAMPLE mode (docs/specs/akai-fire-v1.md, "SAMPLE mode"): edit the sampler slots on
 * the device. Row 1 holds the eight slots and the eight newest community samples, rows 2-4 a
 * chromatic keyboard around the slot's root; the four knobs edit one page of the patch (Pitch,
 * Loop, Envelope, Filter; BANK cycles them) and the OLED shows the page. Everything goes through
 * the `Samplers` edit API; nothing plays unless a pad is pressed.
 *
 * The pure parts (`editPatch`, `pageParams`, `renderSamplePads`, `sampleOledModel`,
 * `renderSampleOled`) take plain values; `SampleMode` holds the device-side state (slot, page,
 * held pads, the knob undo history) and turns Fire events into edits.
 */
import type { Degree, Key } from '@crokychords/core';
import { SCALES, noteName, toPitchClass } from '@crokychords/core';
import type { SamplerId } from '../../audio/instruments';
import { SAMPLER_IDS, samplerSlot } from '../../audio/instruments';
import type {
  AuditionHandle,
  SamplerPatch,
  SamplerState,
  WaveformPeaks,
} from '../../audio/sampler';
import { FILTER_TYPES, RANGES, SAMPLER_RATE } from '../../audio/sampler';
import { degreeHue } from '../../music';
import type { CommunityPage, CommunitySample } from '../../sync/community';
import { communityMessage } from '../../sync/community';
import { ICONS, drawIcon, drawText, fillRect, fit, textWidth } from './oled';
import type { OledFrame, Rgb } from './protocol';
import {
  BLACK,
  BTN_BANK,
  BTN_PATTERN,
  BTN_SELECT_PRESS,
  COLS,
  ENC_FILTER,
  ENC_PAN,
  ENC_RESONANCE,
  ENC_SELECT,
  ENC_VOLUME,
  OLED_W,
  PAD_COUNT,
  ROWS,
  blankFrame,
  hueRgb,
} from './protocol';

// --- layout -------------------------------------------------------------------------------

export const SAMPLE_PAGES = ['pitch', 'loop', 'envelope', 'filter'] as const;
export type SamplePage = (typeof SAMPLE_PAGES)[number];
export const PAGE_LABELS: Record<SamplePage, string> = {
  pitch: 'PITCH',
  loop: 'LOOP',
  envelope: 'ENVELOPE',
  filter: 'FILTER',
};

/** Row 1: pads 1-8 are the sampler slots, pads 9-16 the newest community samples. */
export const SLOT_ROW = 0;
export const COMMUNITY_COL = 8;
export const COMMUNITY_PADS = 8;
/** Rows 2-4: a chromatic keyboard of 48 notes, lowest on the bottom row. */
export const KEY_ROWS = ROWS - 1;
/** Index of the root among the 48 keys: row 3, pad 9 (the middle of the keyboard). */
export const ROOT_KEY = 24;

/** The four knobs, left to right. */
export const KNOBS = [ENC_VOLUME, ENC_PAN, ENC_FILTER, ENC_RESONANCE] as const;

/** Pixel theme colours (themes/pixel.ts): accent yellow, brand green, danger red. */
export const ACCENT_HUE = 48;
export const BRAND_HUE = 145;
export const DANGER_HUE = 5;

const WHITE: Rgb = [127, 127, 127];
const SELECTED_EMPTY: Rgb = [30, 30, 30];
const KEY_SCALE: Rgb = [12, 12, 12];
const KEY_OTHER: Rgb = [3, 3, 3];

/** How many knob edits PATTERN can undo. */
export const UNDO_LIMIT = 64;

/** MIDI note of a keyboard pad (rows 1-3), or null outside 0-127 or off the keyboard. */
export function keyNote(root: number, row: number, col: number): number | null {
  if (row <= SLOT_ROW || row >= ROWS || col < 0 || col >= COLS) return null;
  const key = (ROWS - 1 - row) * COLS + col;
  const note = root - ROOT_KEY + key;
  return note >= 0 && note <= 127 ? note : null;
}

/** Scale degree of `note` in `key`, or null when it is not in the scale. */
export function noteDegree(key: Key, note: number): Degree | null {
  const at = SCALES[key.mode].indexOf(toPitchClass(note - key.tonic));
  return at < 0 ? null : ((at + 1) as Degree);
}

/** Note name with octave: 60 → "C4". */
export function noteLabel(note: number): string {
  return `${noteName(toPitchClass(note))}${Math.floor(note / 12) - 1}`;
}

// --- editing ------------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** One knob detent on a logarithmic scale: a quarter octave, a sixteenth with SHIFT. */
function logStep(value: number, sign: number, fine: boolean, perOctave: number): number {
  return value * 2 ** ((sign * (fine ? 1 / 4 : 1)) / perOctave);
}

/**
 * `patch` after one detent of knob `knob` (0-3, left to right) on `page`: coarse, or fine with
 * SHIFT. The result is not clamped (the edit API clamps); positions need a sample.
 */
export function editPatch(
  patch: SamplerPatch,
  page: SamplePage,
  knob: number,
  sign: number,
  fine: boolean,
): SamplerPatch {
  const r = RANGES;
  const frames = patch.sample?.frames ?? 0;
  switch (page) {
    case 'pitch':
      switch (knob) {
        case 0:
          return {
            ...patch,
            gain: round(clamp(patch.gain + sign * (fine ? 0.1 : 1), r.gain.min, r.gain.max), 0.1),
          };
        case 1:
          // Semitones either way; there is nothing finer (Tune is the fine control).
          return { ...patch, root: clamp(patch.root + sign, 0, 127) };
        case 2:
          return { ...patch, keytrack: clamp(patch.keytrack + sign * (fine ? 1 : 5), 0, 100) };
        default:
          return {
            ...patch,
            tune: clamp(patch.tune + sign * (fine ? 1 : 5), r.tune.min, r.tune.max),
          };
      }
    case 'loop': {
      if (frames === 0) return patch;
      const step = Math.max(1, Math.round(frames / (fine ? 1024 : 128)));
      const loop = patch.loop;
      switch (knob) {
        case 0:
          return { ...patch, start: clamp(patch.start + sign * step, 0, frames) };
        case 1:
          return { ...patch, loop: { ...loop, start: clamp(loop.start + sign * step, 0, frames) } };
        case 2:
          return { ...patch, loop: { ...loop, end: clamp(loop.end + sign * step, 0, frames) } };
        default: {
          const ms = (fine ? 1 : 5) * (SAMPLER_RATE / 1000);
          return {
            ...patch,
            loop: { ...loop, crossfade: Math.max(0, loop.crossfade + sign * ms) },
          };
        }
      }
    }
    case 'envelope': {
      const e = patch.envelope;
      switch (knob) {
        case 0:
          return { ...patch, envelope: { ...e, attack: logStep(e.attack, sign, fine, 4) } };
        case 1:
          return { ...patch, envelope: { ...e, decay: logStep(e.decay, sign, fine, 4) } };
        case 2:
          return {
            ...patch,
            envelope: {
              ...e,
              sustain: round(clamp(e.sustain + sign * (fine ? 0.01 : 0.05), 0, 1), 0.01),
            },
          };
        default:
          return { ...patch, envelope: { ...e, release: logStep(e.release, sign, fine, 4) } };
      }
    }
    case 'filter': {
      const f = patch.filter;
      switch (knob) {
        case 0: {
          const at = FILTER_TYPES.indexOf(f.type);
          const type = FILTER_TYPES[clamp(at + sign, 0, FILTER_TYPES.length - 1)] ?? f.type;
          return { ...patch, filter: { ...f, type } };
        }
        case 1:
          return { ...patch, filter: { ...f, cutoff: logStep(f.cutoff, sign, fine, 6) } };
        case 2:
          return {
            ...patch,
            filter: { ...f, resonance: clamp(f.resonance + sign * (fine ? 1 : 5), 0, 100) },
          };
        default:
          return {
            ...patch,
            filter: { ...f, envAmount: clamp(f.envAmount + sign * (fine ? 1 : 5), -100, 100) },
          };
      }
    }
  }
}

// --- values -------------------------------------------------------------------------------

export interface SampleParam {
  label: string;
  value: string;
}

function signed(value: number, digits = 0): string {
  const text = Math.abs(value).toFixed(digits);
  return `${value < 0 && Number(text) !== 0 ? '-' : '+'}${text}`;
}

/** "2 ms", "0.30 s", "12.5 s". */
export function formatTime(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return seconds < 10 ? `${seconds.toFixed(2)} s` : `${seconds.toFixed(1)} s`;
}

/** "440 Hz", "1.25 kHz", "20.0 kHz". */
export function formatHz(hz: number): string {
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  return `${(hz / 1000).toFixed(hz < 10000 ? 2 : 1)} kHz`;
}

/** A frame position in seconds: "0.250", "12.50". */
function formatPosition(frames: number): string {
  const s = frames / SAMPLER_RATE;
  return s < 10 ? s.toFixed(3) : s.toFixed(2);
}

const FILTER_LABELS = { lowpass: 'lowpass', highpass: 'highpass', bandpass: 'bandpass' } as const;

/** The four parameters of `page` (knob order), as label and value text. */
export function pageParams(page: SamplePage, patch: SamplerPatch): SampleParam[] {
  switch (page) {
    case 'pitch':
      return [
        { label: 'Gain', value: `${signed(patch.gain, 1)} dB` },
        { label: 'Root', value: `${noteLabel(patch.root)} ${patch.root}` },
        { label: 'Keytrack', value: `${Math.round(patch.keytrack)}%` },
        { label: 'Tune', value: `${signed(patch.tune)} ct` },
      ];
    case 'loop':
      return [
        { label: 'St', value: formatPosition(patch.start) },
        { label: 'Ls', value: formatPosition(patch.loop.start) },
        { label: 'Le', value: formatPosition(patch.loop.end) },
        { label: 'Xf', value: `${Math.round((patch.loop.crossfade / SAMPLER_RATE) * 1000)}ms` },
      ];
    case 'envelope':
      return [
        { label: 'Attack', value: formatTime(patch.envelope.attack) },
        { label: 'Decay', value: formatTime(patch.envelope.decay) },
        { label: 'Sustain', value: `${Math.round(patch.envelope.sustain * 100)}%` },
        { label: 'Release', value: formatTime(patch.envelope.release) },
      ];
    case 'filter':
      return [
        { label: 'Type', value: FILTER_LABELS[patch.filter.type] },
        { label: 'Cutoff', value: formatHz(patch.filter.cutoff) },
        { label: 'Reso', value: `${Math.round(patch.filter.resonance)}%` },
        { label: 'Env amt', value: `${signed(patch.filter.envAmount)}%` },
      ];
  }
}

// --- pads ---------------------------------------------------------------------------------

export interface SamplePadsInput {
  /** State of every slot, slot 1 first. */
  slots: readonly SamplerState[];
  /** Selected slot, 0-7. */
  slot: number;
  /** The newest community samples (at most eight); fewer or none leave pads dark. */
  community: readonly CommunitySample[];
  /** Community pads (0-7) being held (auditioning). */
  heldCommunity: ReadonlySet<number>;
  /** Root of the selected slot. */
  root: number;
  key: Key;
  /** Notes held on the keyboard. */
  heldNotes: ReadonlySet<number>;
}

function slotRgb(state: SamplerState, selected: boolean): Rgb {
  switch (state) {
    case 'ready':
      return hueRgb(ACCENT_HUE, selected ? 1 : 0.25);
    case 'loading':
      return hueRgb(ACCENT_HUE, selected ? 0.5 : 0.08);
    case 'error':
      return hueRgb(DANGER_HUE, selected ? 1 : 0.25);
    case 'empty':
      return selected ? SELECTED_EMPTY : BLACK;
  }
}

/** Colours of all 64 pads in SAMPLE mode, index = row * 16 + col. */
export function renderSamplePads(input: SamplePadsInput): Rgb[] {
  const pads: Rgb[] = new Array<Rgb>(PAD_COUNT).fill(BLACK);
  input.slots.slice(0, COMMUNITY_COL).forEach((state, i) => {
    pads[SLOT_ROW * COLS + i] = slotRgb(state, i === input.slot);
  });
  input.community.slice(0, COMMUNITY_PADS).forEach((_, i) => {
    pads[SLOT_ROW * COLS + COMMUNITY_COL + i] = hueRgb(
      BRAND_HUE,
      input.heldCommunity.has(i) ? 1 : 0.25,
    );
  });
  const rootDegree = noteDegree(input.key, input.root);
  const rootPc = toPitchClass(input.root);
  for (let row = SLOT_ROW + 1; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const note = keyNote(input.root, row, col);
      if (note === null) continue;
      let rgb: Rgb;
      if (input.heldNotes.has(note)) rgb = WHITE;
      else if (toPitchClass(note) === rootPc) {
        const light = note === input.root ? 1 : 0.3;
        rgb =
          rootDegree === null
            ? [Math.round(60 * light), Math.round(60 * light), Math.round(60 * light)]
            : hueRgb(degreeHue(rootDegree), light);
      } else rgb = noteDegree(input.key, note) === null ? KEY_OTHER : KEY_SCALE;
      pads[row * COLS + col] = rgb;
    }
  }
  return pads;
}

// --- OLED ---------------------------------------------------------------------------------

/** Waveform strip on the Loop page: 26 rows under the status line. */
const STRIP_Y = 11;
export const STRIP_H = 26;
const LINE = 11;

/** The Loop page's waveform strip as plain numbers (equal strips draw equal pixels). */
export interface SampleStrip {
  /** Per column (128): first and last lit row inside the strip, or null for no sample data. */
  columns: [number, number][] | null;
  /** Marker columns (0-127). */
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  loop: boolean;
}

/** Everything the OLED shows in SAMPLE mode, as plain values. */
export interface SampleOledModel {
  page: SamplePage;
  /** 1-8. */
  slot: number;
  name: string;
  playing: boolean;
  params: SampleParam[];
  /** Knob (0-3) being touched, its parameter inverted. */
  touched: number | null;
  /** Bottom line: the sample's state, or the last message. */
  info: string;
  /** Loop page: 'off', 'fwd' or 'pp'. */
  loopMode: string;
  strip: SampleStrip | null;
}

/** Column of frame `at` in a sample of `frames` frames. */
export function markerColumn(at: number, frames: number): number {
  if (frames <= 0) return 0;
  return Math.max(0, Math.min(OLED_W - 1, Math.floor((at * OLED_W) / frames)));
}

/** The strip's columns from waveform peaks (normalised to ±1). */
export function stripColumns(peaks: WaveformPeaks): [number, number][] {
  const mid = (STRIP_H - 1) / 2;
  const scale = (STRIP_H - 2) / 2;
  const row = (v: number): number => clamp(Math.round(mid - v * scale), 0, STRIP_H - 1);
  return Array.from({ length: OLED_W }, (_, x): [number, number] => {
    const top = row(peaks.max[x] ?? 0);
    const bottom = row(peaks.min[x] ?? 0);
    return [Math.min(top, bottom), Math.max(top, bottom)];
  });
}

function sampleInfo(patch: SamplerPatch, state: SamplerState): string {
  switch (state) {
    case 'empty':
      return 'no sample: piano';
    case 'loading':
      return 'loading';
    case 'error':
      return 'load failed: piano';
    case 'ready': {
      const s = patch.sample;
      if (s === null) return '';
      return `${(s.frames / s.sampleRate).toFixed(2)} s ${s.channels === 2 ? 'stereo' : 'mono'}`;
    }
  }
}

export interface SampleOledInput {
  page: SamplePage;
  /** 0-7. */
  slot: number;
  patch: SamplerPatch;
  state: SamplerState;
  playing: boolean;
  touched: number | null;
  message: string | null;
  /** 128 columns of the whole sample, or null (only read on the Loop page). */
  peaks: WaveformPeaks | null;
}

export function sampleOledModel(input: SampleOledInput): SampleOledModel {
  const { patch, page } = input;
  const frames = patch.sample?.frames ?? 0;
  const loop = patch.loop;
  return {
    page,
    slot: input.slot + 1,
    name: patch.name,
    playing: input.playing,
    params: pageParams(page, patch),
    touched: input.touched,
    info: input.message ?? sampleInfo(patch, input.state),
    loopMode:
      page !== 'loop' ? '' : !loop.enabled ? 'off' : loop.mode === 'pingpong' ? 'pp' : 'fwd',
    strip:
      page !== 'loop'
        ? null
        : {
            columns: input.peaks === null || frames === 0 ? null : stripColumns(input.peaks),
            start: markerColumn(patch.start, frames),
            end: markerColumn(patch.end, frames),
            loopStart: markerColumn(loop.start, frames),
            loopEnd: markerColumn(loop.end, frames),
            loop: loop.enabled,
          },
  };
}

function drawStatus(frame: OledFrame, model: SampleOledModel): void {
  const right = OLED_W - 1;
  const badge = PAGE_LABELS[model.page];
  const w = textWidth(badge) + 2;
  fillRect(frame, 0, 0, w, 10);
  drawText(frame, badge, 1, 0, 1, 0);
  drawIcon(frame, model.playing ? ICONS.play : ICONS.stop, right - 7, 2);
  let end = right - 10;
  if (model.loopMode !== '') {
    const x = end - textWidth(model.loopMode);
    drawText(frame, model.loopMode, x, 0);
    end = x - 4;
  }
  const title = fit(`${model.slot} ${model.name}`, end - (w + 4));
  drawText(frame, title, w + 4, 0);
}

function drawLines(frame: OledFrame, model: SampleOledModel): void {
  model.params.forEach((p, i) => {
    const y = 10 + i * LINE;
    const on = model.touched === i ? 0 : 1;
    if (on === 0) fillRect(frame, 0, y, OLED_W, LINE);
    const value = fit(p.value, OLED_W - 2 - textWidth(p.label) - 7);
    drawText(frame, p.label, 1, y, 1, on);
    drawText(frame, value, OLED_W - 1 - textWidth(value), y, 1, on);
  });
  drawText(frame, fit(model.info, OLED_W - 2), 1, 53);
}

function drawStrip(frame: OledFrame, strip: SampleStrip): void {
  const bottom = STRIP_Y + STRIP_H;
  if (strip.columns === null) {
    const text = 'no sample';
    drawText(frame, text, Math.floor((OLED_W - textWidth(text)) / 2), STRIP_Y + 7);
    return;
  }
  strip.columns.forEach(([top, low], x) => {
    const inside = x >= strip.start && x <= strip.end;
    for (let y = top; y <= low; y++) {
      if (inside || y % 2 === 0) fillRect(frame, x, STRIP_Y + y, 1, 1);
    }
  });
  // Trim markers: solid. Loop markers: dashed, joined along the top while the loop is on.
  for (const x of [strip.start, strip.end]) fillRect(frame, x, STRIP_Y, 1, STRIP_H);
  for (const x of [strip.loopStart, strip.loopEnd]) {
    for (let y = STRIP_Y; y < bottom; y++) fillRect(frame, x, y, 1, 1, y % 2 === 0 ? 1 : 0);
  }
  if (strip.loop) fillRect(frame, strip.loopStart, STRIP_Y, strip.loopEnd - strip.loopStart + 1, 2);
}

function drawCells(frame: OledFrame, model: SampleOledModel): void {
  const half = OLED_W / 2;
  model.params.forEach((p, i) => {
    const x = (i % 2) * half;
    const y = STRIP_Y + STRIP_H + 1 + Math.floor(i / 2) * LINE;
    const on = model.touched === i ? 0 : 1;
    if (on === 0) fillRect(frame, x, y, half, LINE);
    drawText(frame, fit(`${p.label} ${p.value}`, half - 2), x + 1, y, 1, on);
  });
}

export function renderSampleOled(model: SampleOledModel): OledFrame {
  const frame = blankFrame();
  drawStatus(frame, model);
  if (model.strip !== null) {
    drawStrip(frame, model.strip);
    drawCells(frame, model);
  } else {
    drawLines(frame, model);
  }
  return frame;
}

// --- the mode -----------------------------------------------------------------------------

/** The part of the `Samplers` edit API the mode uses. */
export interface FireSamplers {
  patch(id: SamplerId): SamplerPatch;
  state(id: SamplerId): SamplerState;
  waveform(id: SamplerId, columns: number): WaveformPeaks | null;
  audition(id: SamplerId, note: number, velocity?: number, track?: string): AuditionHandle | null;
  preview(
    key: string,
    load: () => Promise<ArrayBuffer>,
    root: number,
    velocity?: number,
  ): Promise<AuditionHandle | null>;
  detectRoot(id: SamplerId): number | null;
  setPatch(id: SamplerId, patch: SamplerPatch): void;
  subscribe(listener: (id: SamplerId) => void): () => void;
}

/** The community bank, when sync is on (`CommunitySync` fits). */
export interface FireCommunity {
  readonly client: {
    browse(options: { cursor?: string | null }): Promise<CommunityPage>;
    bytes(id: string): Promise<ArrayBuffer>;
  };
  take(slot: SamplerId, sample: CommunitySample): Promise<void>;
}

interface UndoStep {
  id: SamplerId;
  before: SamplerPatch;
  after: SamplerPatch;
}

/** Pending key of a SELECT turn (the filter type), beside the knobs 0-3. */
const SELECT_KEY = -1;

export class SampleMode {
  readonly #samplers: FireSamplers;
  readonly #community: FireCommunity | null;
  readonly #listeners = new Set<() => void>();
  #active = false;
  #slot = 0;
  #page = 0;
  #recent: CommunitySample[] = [];
  #browse = 0;
  /** Keyboard notes sounding, by pad index. */
  readonly #notes = new Map<number, { note: number; handle: AuditionHandle | null }>();
  /** Community auditions, by community pad (0-7). */
  readonly #previews = new Map<number, { handle: AuditionHandle | null }>();
  #touched: number | null = null;
  /** A knob edit in progress: one undo step when the knob is let go or another control is used. */
  #pending: { key: number; id: SamplerId; base: SamplerPatch } | null = null;
  #undo: UndoStep[] = [];
  #redo: UndoStep[] = [];
  #message: string | null = null;

  constructor(samplers: FireSamplers, community: FireCommunity | null = null) {
    this.#samplers = samplers;
    this.#community = community;
    samplers.subscribe(() => {
      if (this.#active) this.#emit();
    });
  }

  get active(): boolean {
    return this.#active;
  }

  /** Selected slot, 0-7. */
  get slot(): number {
    return this.#slot;
  }

  /** Knob page, 0-3 (index into SAMPLE_PAGES). */
  get page(): number {
    return this.#page;
  }

  get id(): SamplerId {
    return SAMPLER_IDS[this.#slot] ?? 'sampler-1';
  }

  get touched(): number | null {
    return this.#touched;
  }

  get recent(): readonly CommunitySample[] {
    return this.#recent;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  /** Called after anything the pads, LEDs or OLED show changed. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  enter(): void {
    if (this.#active) return;
    this.#active = true;
    this.#message = null;
    this.#loadRecent();
    this.#emit();
  }

  /** Back to STEP mode: commit the open edit, stop every held note. */
  leave(): void {
    this.#flush();
    this.#releaseAll();
    this.#touched = null;
    if (!this.#active) return;
    this.#active = false;
    this.#emit();
  }

  // --- input --------------------------------------------------------------------------------

  /** A pad press or release; `track` is the bus auditions play through. */
  pad(row: number, col: number, down: boolean, shift: boolean, track: string | null): void {
    this.#flush();
    const index = row * COLS + col;
    if (row === SLOT_ROW) {
      if (col < COMMUNITY_COL) {
        if (down) this.#select(col);
        return;
      }
      this.#communityPad(col - COMMUNITY_COL, down, shift);
      return;
    }
    this.#release(index);
    if (!down) {
      this.#emit();
      return;
    }
    const note = keyNote(this.#samplers.patch(this.id).root, row, col);
    if (note === null) return;
    const handle = this.#samplers.audition(this.id, note, 100, track ?? undefined);
    this.#notes.set(index, { note, handle });
    this.#emit();
  }

  /** A button the mode handles (BANK, SELECT press, PATTERN); false for any other. */
  button(note: number, shift: boolean): boolean {
    switch (note) {
      case BTN_BANK:
        this.#flush();
        this.#page = (this.#page + (shift ? SAMPLE_PAGES.length - 1 : 1)) % SAMPLE_PAGES.length;
        this.#emit();
        return true;
      case BTN_SELECT_PRESS:
        this.#flush();
        this.#selectPress(shift);
        return true;
      case BTN_PATTERN:
        this.#flush();
        if (shift) this.redo();
        else this.undo();
        return true;
      default:
        return false;
    }
  }

  /** Knob touch (note on) or release (note off) of VOLUME..RESONANCE. */
  touch(encoder: number, down: boolean): void {
    const knob = KNOBS.findIndex((k) => k === encoder);
    if (knob < 0) return;
    if (down) this.#touched = knob;
    else {
      if (this.#touched === knob) this.#touched = null;
      if (this.#pending?.key === knob) this.#flush();
    }
    this.#emit();
  }

  turn(encoder: number, delta: number, shift: boolean): void {
    const sign = delta > 0 ? 1 : -1;
    const page = SAMPLE_PAGES[this.#page] ?? 'pitch';
    if (encoder === ENC_SELECT) {
      if (page === 'filter') {
        this.#edit(SELECT_KEY, (p) => editPatch(p, page, 0, sign, shift));
        return;
      }
      this.#flush();
      this.#select(clamp(this.#slot + sign, 0, SAMPLER_IDS.length - 1));
      return;
    }
    const knob = KNOBS.findIndex((k) => k === encoder);
    if (knob < 0) return;
    this.#edit(knob, (p) => editPatch(p, page, knob, sign, shift));
  }

  undo(): void {
    this.#flush();
    const step = this.#pop(this.#undo);
    if (step === null) return;
    this.#samplers.setPatch(step.id, step.before);
    this.#redo.push(step);
    this.#message = `undo: slot ${samplerSlot(step.id)}`;
    this.#emit();
  }

  redo(): void {
    this.#flush();
    const step = this.#pop(this.#redo);
    if (step === null) return;
    this.#samplers.setPatch(step.id, step.after);
    this.#undo.push(step);
    this.#message = `redo: slot ${samplerSlot(step.id)}`;
    this.#emit();
  }

  // --- output -------------------------------------------------------------------------------

  pads(key: Key): Rgb[] {
    return renderSamplePads({
      slots: SAMPLER_IDS.map((id) => this.#samplers.state(id)),
      slot: this.#slot,
      community: this.#recent,
      heldCommunity: new Set(this.#previews.keys()),
      root: this.#samplers.patch(this.id).root,
      key,
      heldNotes: new Set([...this.#notes.values()].map((n) => n.note)),
    });
  }

  oled(playing: boolean): SampleOledModel {
    const page = SAMPLE_PAGES[this.#page] ?? 'pitch';
    return sampleOledModel({
      page,
      slot: this.#slot,
      patch: this.#samplers.patch(this.id),
      state: this.#samplers.state(this.id),
      playing,
      touched: this.#touched,
      message: this.#message,
      peaks: page === 'loop' ? this.#samplers.waveform(this.id, OLED_W) : null,
    });
  }

  // --- helpers ------------------------------------------------------------------------------

  #select(slot: number): void {
    if (slot === this.#slot) return;
    this.#slot = slot;
    this.#message = null;
    this.#emit();
  }

  #selectPress(shift: boolean): void {
    const page = SAMPLE_PAGES[this.#page];
    const id = this.id;
    const before = this.#samplers.patch(id);
    if (page === 'pitch') {
      const note = this.#samplers.detectRoot(id);
      this.#message = note === null ? 'no clear pitch' : `root ${noteLabel(note)}`;
    } else if (page === 'loop') {
      const loop = before.loop;
      const next = shift
        ? { ...loop, mode: loop.mode === 'pingpong' ? ('forward' as const) : ('pingpong' as const) }
        : { ...loop, enabled: !loop.enabled };
      this.#samplers.setPatch(id, { ...before, loop: next });
    } else return;
    this.#record(id, before);
    this.#emit();
  }

  #communityPad(index: number, down: boolean, shift: boolean): void {
    const community = this.#community;
    const sample = this.#recent[index];
    if (!down) {
      const preview = this.#previews.get(index);
      this.#previews.delete(index);
      preview?.handle?.release();
      this.#emit();
      return;
    }
    if (community === null || sample === undefined) return;
    if (shift) {
      // Add it to the selected slot (loads, never plays).
      const id = this.id;
      this.#message = `adding ${sample.name}`;
      this.#emit();
      community.take(id, sample).then(
        () => this.#say(`added to slot ${samplerSlot(id)}`),
        (e: unknown) => this.#say(`not added: ${communityMessage(e)}`),
      );
      return;
    }
    const entry: { handle: AuditionHandle | null } = { handle: null };
    this.#previews.set(index, entry);
    this.#emit();
    this.#samplers
      .preview(sample.id, () => community.client.bytes(sample.id), sample.root)
      .then(
        (handle) => {
          if (this.#previews.get(index) === entry) entry.handle = handle;
          else handle?.release();
        },
        (e: unknown) => this.#say(`cannot play: ${communityMessage(e)}`),
      );
  }

  #loadRecent(): void {
    const community = this.#community;
    if (community === null) return;
    const ask = ++this.#browse;
    community.client.browse({}).then(
      (page) => {
        if (ask !== this.#browse) return;
        this.#recent = page.samples.slice(0, COMMUNITY_PADS);
        this.#emit();
      },
      () => {
        if (ask !== this.#browse) return;
        this.#recent = [];
        this.#emit();
      },
    );
  }

  #edit(key: number, change: (patch: SamplerPatch) => SamplerPatch): void {
    const id = this.id;
    if (this.#pending !== null && (this.#pending.key !== key || this.#pending.id !== id)) {
      this.#flush();
    }
    const patch = this.#samplers.patch(id);
    this.#pending ??= { key, id, base: patch };
    this.#message = null;
    this.#samplers.setPatch(id, change(patch));
    this.#emit();
  }

  /** Commit the open knob edit as one undo step. */
  #flush(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#record(pending.id, pending.base);
  }

  #record(id: SamplerId, before: SamplerPatch): void {
    const after = this.#samplers.patch(id);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    this.#undo.push({ id, before, after });
    if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
    this.#redo = [];
  }

  /** The newest step whose slot still holds the same sample (others are dropped). */
  #pop(stack: UndoStep[]): UndoStep | null {
    for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
      if (this.#samplers.patch(step.id).sample?.savedAt === step.before.sample?.savedAt) {
        return step;
      }
    }
    return null;
  }

  #release(index: number): void {
    const held = this.#notes.get(index);
    if (held === undefined) return;
    this.#notes.delete(index);
    held.handle?.release();
  }

  #releaseAll(): void {
    for (const index of [...this.#notes.keys()]) this.#release(index);
    for (const preview of this.#previews.values()) preview.handle?.release();
    this.#previews.clear();
  }

  #say(message: string): void {
    this.#message = message;
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
