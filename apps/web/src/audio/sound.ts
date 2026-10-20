/**
 * Sound settings: which sound preset and drum pattern the browser synth uses. A listening
 * preference, kept outside the song (no undo, never in MIDI) and saved in localStorage.
 */
import type { DrumPatternId, SoundPresetId } from './instruments';
import { DEFAULT_SOUND_PRESET, isDrumPatternId, isSoundPresetId, soundPreset } from './instruments';

export const SOUND_KEY = 'crokychords.sound';

export type SoundStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface SoundState {
  preset: SoundPresetId;
  drums: DrumPatternId;
}

export function defaultSound(): SoundState {
  return { preset: DEFAULT_SOUND_PRESET, drums: soundPreset(DEFAULT_SOUND_PRESET).drums };
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
  return { preset: id, drums: isDrumPatternId(drums) ? drums : soundPreset(id).drums };
}

export type SoundListener = (state: SoundState) => void;

export class SoundSettings {
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

  /** Choose a preset; also resets the drums to the preset's default pattern. */
  setPreset(preset: SoundPresetId): void {
    this.#set({ preset, drums: soundPreset(preset).drums });
  }

  setDrums(drums: DrumPatternId): void {
    this.#set({ ...this.#state, drums });
  }

  subscribe(listener: SoundListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: SoundState): void {
    if (next.preset === this.#state.preset && next.drums === this.#state.drums) return;
    this.#state = next;
    try {
      this.#storage?.setItem(SOUND_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the setting still applies for this session.
    }
    for (const listener of [...this.#listeners]) listener(next);
  }
}
