/**
 * Sound settings: the sound preset, the drum pattern, the instrument of every track, the
 * melody lane's listening settings (docs/specs/soundfonts-v1.md §8) and the sampler slots'
 * patches (docs/specs/sampler-v1.md §2). A listening preference,
 * kept outside the song (no undo, never in MIDI except the export's Program Changes) and saved in
 * localStorage.
 */
import type { Song, Track, TrackRole } from '@crokychords/core';
import { MELODY_TRACK_ID, MELODY_VELOCITY } from '@crokychords/core';
import type { DrumPatternId, InstrumentId, SamplerId, SoundPresetId } from './instruments';
import {
  DEFAULT_SOUND_PRESET,
  gmProgram,
  isDrumPatternId,
  isInstrumentId,
  isSamplerId,
  isSoundPresetId,
  presetChoice,
  soundPreset,
} from './instruments';
import type { SamplerPatch, SamplerPatches } from './sampler';
import { clampPatch, defaultSamplers, parseSamplers } from './sampler';

export const SOUND_KEY = 'crokychords.sound';

export type SoundStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Octave shift of the melody lane's browser sound. */
export const MELODY_SHIFT_MIN = -2;
export const MELODY_SHIFT_MAX = 2;

/** The melody lane's browser-sound settings (not in the song, not in MIDI). */
export interface MelodySound {
  /** Octave shift, MELODY_SHIFT_MIN..MELODY_SHIFT_MAX. */
  octave: number;
  /** Velocity 1–127 of the browser playback. */
  velocity: number;
}

export interface SoundState {
  preset: SoundPresetId;
  drums: DrumPatternId;
  /** Per-track instrument (track id, or 'melody'); absent = the preset's choice for the role. */
  instruments: Readonly<Record<string, InstrumentId>>;
  melody: MelodySound;
  /** The patch of every sampler slot (the samples themselves are in IndexedDB). */
  samplers: Readonly<Record<SamplerId, SamplerPatch>>;
}

/** What plays a track in the browser: its instrument and listening tweaks. */
export interface TrackVoice {
  instrument: InstrumentId;
  /** Semitones added to every note (the melody's octave shift). */
  transpose: number;
  /** Replaces the note velocity when set (the melody's velocity). */
  velocity?: number;
}

export function defaultMelodySound(): MelodySound {
  return { octave: 0, velocity: MELODY_VELOCITY };
}

export function defaultSound(): SoundState {
  return {
    preset: DEFAULT_SOUND_PRESET,
    drums: soundPreset(DEFAULT_SOUND_PRESET).drums,
    instruments: {},
    melody: defaultMelodySound(),
    samplers: defaultSamplers(),
  };
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function parseInstruments(raw: unknown): Record<string, InstrumentId> {
  const out: Record<string, InstrumentId> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [track, id] of Object.entries(raw)) {
    if (track !== '' && isInstrumentId(id)) out[track] = id;
  }
  return out;
}

function parseMelody(raw: unknown): MelodySound {
  const fallback = defaultMelodySound();
  if (typeof raw !== 'object' || raw === null) return fallback;
  return {
    octave:
      intIn(Reflect.get(raw, 'octave'), MELODY_SHIFT_MIN, MELODY_SHIFT_MAX) ?? fallback.octave,
    velocity: intIn(Reflect.get(raw, 'velocity'), 1, 127) ?? fallback.velocity,
  };
}

/** Parse saved settings; anything invalid falls back to the defaults field by field. */
export function parseSound(json: string | null): SoundState {
  const fallback = defaultSound();
  if (json === null) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fallback;
  }
  if (typeof raw !== 'object' || raw === null) return fallback;
  const preset: unknown = Reflect.get(raw, 'preset');
  const drums: unknown = Reflect.get(raw, 'drums');
  const id = isSoundPresetId(preset) ? preset : fallback.preset;
  return {
    preset: id,
    drums: isDrumPatternId(drums) ? drums : soundPreset(id).drums,
    instruments: parseInstruments(Reflect.get(raw, 'instruments')),
    melody: parseMelody(Reflect.get(raw, 'melody')),
    samplers: parseSamplers(Reflect.get(raw, 'samplers')),
  };
}

/** The instrument of `track` (a track id, or 'melody' with `role` null) under `state`. */
export function instrumentOf(
  state: SoundState,
  track: string,
  role: TrackRole | null,
): InstrumentId {
  return state.instruments[track] ?? presetChoice(state.preset, role);
}

/** Ids of the tracks of `song` (and 'melody') that have their own instrument choice. */
export function customTracks(state: SoundState, song: Song): string[] {
  const ids = [...(song.tracks ?? []).map((t) => t.id), MELODY_TRACK_ID];
  return ids.filter((id) => state.instruments[id] !== undefined);
}

/** General MIDI program of `id` under `state` (a sampler slot's comes from its patch). */
export function programOf(state: SoundState, id: InstrumentId): number {
  return isSamplerId(id) ? state.samplers[id].program : gmProgram(id);
}

/** General MIDI program per track id (and 'melody') of `song`, for the .mid export. */
export function trackPrograms(state: SoundState, song: Song): Record<string, number> {
  const programs: Record<string, number> = {};
  for (const track of song.tracks ?? []) {
    programs[track.id] = programOf(state, instrumentOf(state, track.id, track.role));
  }
  programs[MELODY_TRACK_ID] = programOf(state, instrumentOf(state, MELODY_TRACK_ID, null));
  return programs;
}

export type SoundListener = (state: SoundState) => void;

export class SoundSettings implements SamplerPatches {
  readonly #storage: SoundStorage | null;
  readonly #listeners = new Set<SoundListener>();
  #state: SoundState;

  constructor(storage: SoundStorage | null = null) {
    this.#storage = storage;
    let json: string | null = null;
    try {
      json = storage?.getItem(SOUND_KEY) ?? null;
    } catch {
      json = null;
    }
    this.#state = parseSound(json);
  }

  get state(): SoundState {
    return this.#state;
  }

  get preset(): SoundPresetId {
    return this.#state.preset;
  }

  get drums(): DrumPatternId {
    return this.#state.drums;
  }

  get melody(): MelodySound {
    return this.#state.melody;
  }

  /** Choose a preset: its drums, and every track back to the preset's instruments. */
  setPreset(preset: SoundPresetId): void {
    this.#set({ ...this.#state, preset, drums: soundPreset(preset).drums, instruments: {} });
  }

  setDrums(drums: DrumPatternId): void {
    this.#set({ ...this.#state, drums });
  }

  /**
   * Give `track` (an id, or 'melody' with `role` null) its own instrument; choosing the preset's
   * instrument for the role removes the entry again.
   */
  setInstrument(track: string, role: TrackRole | null, id: InstrumentId): void {
    const instruments = { ...this.#state.instruments };
    if (id === presetChoice(this.#state.preset, role)) delete instruments[track];
    else instruments[track] = id;
    this.#set({ ...this.#state, instruments });
  }

  /** The instrument of a band track. */
  trackInstrument(track: Pick<Track, 'id' | 'role'>): InstrumentId {
    return instrumentOf(this.#state, track.id, track.role);
  }

  /** The instrument of the melody lane. */
  melodyInstrument(): InstrumentId {
    return instrumentOf(this.#state, MELODY_TRACK_ID, null);
  }

  setMelodyOctave(octave: number): void {
    if (!Number.isFinite(octave)) return;
    const value = Math.min(MELODY_SHIFT_MAX, Math.max(MELODY_SHIFT_MIN, Math.round(octave)));
    this.#set({ ...this.#state, melody: { ...this.#state.melody, octave: value } });
  }

  setMelodyVelocity(velocity: number): void {
    if (!Number.isFinite(velocity)) return;
    const value = Math.min(127, Math.max(1, Math.round(velocity)));
    this.#set({ ...this.#state, melody: { ...this.#state.melody, velocity: value } });
  }

  /** The patch of a sampler slot. */
  sampler(id: SamplerId): SamplerPatch {
    return this.#state.samplers[id];
  }

  /** Replace a sampler slot's patch (clamped). */
  setSampler(id: SamplerId, patch: SamplerPatch): void {
    this.#set({
      ...this.#state,
      samplers: { ...this.#state.samplers, [id]: clampPatch(patch, id) },
    });
  }

  /** What plays `track` in the browser (`role` null for the melody lane). */
  voice(track: string, role: TrackRole | null): TrackVoice {
    const instrument = instrumentOf(this.#state, track, role);
    if (track !== MELODY_TRACK_ID) return { instrument, transpose: 0 };
    const { octave, velocity } = this.#state.melody;
    return { instrument, transpose: octave * 12, velocity };
  }

  subscribe(listener: SoundListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: SoundState): void {
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next;
    try {
      this.#storage?.setItem(SOUND_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the setting still applies for this session.
    }
    for (const listener of [...this.#listeners]) listener(next);
  }
}
