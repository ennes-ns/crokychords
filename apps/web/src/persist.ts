import type { Song } from '@crokychords/core';
import { deserializeSong, serializeSong } from '@crokychords/core';
import type { MasterMode } from './audio/graph';
import { VOLUME_DEFAULT, isMasterMode } from './audio/graph';

/** The legacy single-song key; migrated into the SaveStore once (store/session.ts). */
export const STORAGE_KEY = 'crokychords.song';
/** Autosave delay after the last change (used by the SaveSession). */
export const SAVE_DEBOUNCE_MS = 250;

export type SongStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved song, or null when there is none or it is invalid. */
export function loadSong(storage: SongStorage | null): Song | null {
  if (storage === null) return null;
  let json: string | null;
  try {
    json = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (json === null) return null;
  try {
    return deserializeSong(json);
  } catch (e) {
    console.warn('Ignoring the saved song:', e);
    return null;
  }
}

export function saveSong(storage: SongStorage | null, song: Song): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, serializeSong(song));
  } catch (e) {
    console.warn('Could not save the song:', e);
  }
}

/** window.localStorage, or null when it is unavailable (privacy mode, sandboxed iframe). */
export function browserStorage(): SongStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const BAND_OPEN_KEY = 'crokychords.bandOpen';

/** Whether the Band panel is expanded (default: open). */
export function loadBandOpen(storage: SongStorage | null): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(BAND_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveBandOpen(storage: SongStorage | null, open: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(BAND_OPEN_KEY, String(open));
  } catch {
    // Not worth a warning: the panel just opens in its default state next time.
  }
}

export const MELODY_TONES_KEY = 'crokychords.melodyChordTones';

/** Whether the melody lane tints the chord-tone rows (default: on). */
export function loadMelodyTones(storage: SongStorage | null): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(MELODY_TONES_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveMelodyTones(storage: SongStorage | null, on: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(MELODY_TONES_KEY, String(on));
  } catch {
    // A view preference: the tint just shows in its default state next time.
  }
}

export const MASTER_KEY = 'crokychords.master';

/** Master section: output protection and volume. A local listening setting, never in the song. */
export interface MasterState {
  mode: MasterMode;
  /** 0–100, whole percent. */
  volume: number;
}

export function defaultMaster(): MasterState {
  return { mode: 'off', volume: VOLUME_DEFAULT };
}

function clampVolume(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Parse saved master settings; anything invalid falls back to the default field by field. */
export function parseMaster(json: string | null): MasterState {
  const fallback = defaultMaster();
  if (json === null) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fallback;
  }
  if (typeof raw !== 'object' || raw === null) return fallback;
  const mode: unknown = Reflect.get(raw, 'mode');
  const volume: unknown = Reflect.get(raw, 'volume');
  return {
    mode: isMasterMode(mode) ? mode : fallback.mode,
    volume:
      typeof volume === 'number' && Number.isFinite(volume) ? clampVolume(volume) : fallback.volume,
  };
}

export type MasterListener = (state: MasterState) => void;

/** The master settings, loaded from and saved to `storage`, with change listeners. */
export class MasterSettings {
  readonly #storage: SongStorage | null;
  readonly #listeners = new Set<MasterListener>();
  #state: MasterState;

  constructor(storage: SongStorage | null = null) {
    this.#storage = storage;
    let json: string | null = null;
    try {
      json = storage?.getItem(MASTER_KEY) ?? null;
    } catch {
      json = null;
    }
    this.#state = parseMaster(json);
  }

  get state(): MasterState {
    return this.#state;
  }

  setMode(mode: MasterMode): void {
    this.#set({ ...this.#state, mode });
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.#set({ ...this.#state, volume: clampVolume(volume) });
  }

  subscribe(listener: MasterListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: MasterState): void {
    if (next.mode === this.#state.mode && next.volume === this.#state.volume) return;
    this.#state = next;
    try {
      this.#storage?.setItem(MASTER_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the setting still applies for this session.
    }
    for (const listener of [...this.#listeners]) listener(next);
  }
}
