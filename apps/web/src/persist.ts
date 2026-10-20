import type { Song } from '@crokychords/core';
import { deserializeSong, serializeSong } from '@crokychords/core';

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
