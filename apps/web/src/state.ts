import type { NgramTable, Song } from '@crokychords/core';
import { createSong, seedTable } from '@crokychords/core';
import { clampSelection } from './edit';

export interface MidiPortInfo {
  id: string;
  name: string;
}

export type TableStatus = 'loading' | 'seed-only' | 'loaded' | 'error';
export type MidiStatus = 'off' | 'pending' | 'ready' | 'unsupported' | 'denied';
export type SuggestMode = 'context' | 'popular';

export interface AppState {
  song: Song;
  /** Chord index. */
  selected: number | null;
  /** Id of the track selected in the Band panel (target of `M` and of auditions). */
  selectedTrack: string | null;
  /** Beat position of the playhead. */
  cursor: number;
  playing: boolean;
  loop: boolean;
  /** Web MIDI output id. */
  midiOut: string | null;
  midiStatus: MidiStatus;
  midiOutputs: readonly MidiPortInfo[];
  /** Which suggestion table is active. */
  table: 'seed' | 'ngrams';
  tableStatus: TableStatus;
  tableError: string | null;
  /** The loaded `/data/ngrams.json`, if any. */
  ngrams: NgramTable | null;
  suggestMode: SuggestMode;
  diatonicOnly: boolean;
  /** The AudioContext exists and is running (it needs a user gesture). */
  audioReady: boolean;
}

export function initialState(song: Song = createSong()): AppState {
  return {
    song,
    selected: null,
    selectedTrack: null,
    cursor: 0,
    playing: false,
    loop: false,
    midiOut: null,
    midiStatus: 'off',
    midiOutputs: [],
    table: 'seed',
    tableStatus: 'loading',
    tableError: null,
    ngrams: null,
    suggestMode: 'context',
    diatonicOnly: false,
    audioReady: false,
  };
}

/** The suggestion table currently in use. */
export function activeTable(state: Pick<AppState, 'table' | 'ngrams'>): NgramTable {
  return state.table === 'ngrams' && state.ngrams !== null ? state.ngrams : seedTable;
}

export const HISTORY_LIMIT = 50;

export type Listener = (state: AppState, previous: AppState) => void;
export type StatePatch = Partial<Omit<AppState, 'song'>>;

export interface CommitOptions {
  /** Song to record in the undo history instead of the current one (for drags that preview). */
  base?: Song;
}

/** The track selection if that track still exists in `song`, else null. */
export function clampTrackSelection(selectedTrack: string | null, song: Song): string | null {
  if (selectedTrack === null) return null;
  return (song.tracks ?? []).some((t) => t.id === selectedTrack) ? selectedTrack : null;
}

/**
 * Single store with subscribe/update; undo/redo covers `song` only (50 steps), which includes
 * the tracks (the band).
 */
export class Store {
  #state: AppState;
  #past: Song[] = [];
  #future: Song[] = [];
  #listeners = new Set<Listener>();

  constructor(state: AppState) {
    this.#state = state;
  }

  get state(): AppState {
    return this.#state;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Update non-song fields (no history). */
  set(patch: StatePatch): void {
    this.#emit({ ...this.#state, ...patch });
  }

  /** Replace the song without recording history (live previews, e.g. while dragging). */
  preview(song: Song, patch: StatePatch = {}): void {
    this.#emit({ ...this.#state, ...patch, song });
  }

  /** Replace the song and record the previous one for undo. */
  commit(song: Song, patch: StatePatch = {}, options: CommitOptions = {}): void {
    const base = options.base ?? this.#state.song;
    if (song === base) {
      this.#emit({ ...this.#state, ...patch, song });
      return;
    }
    this.#past.push(base);
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
    this.#emit({ ...this.#state, ...patch, song });
  }

  undo(): boolean {
    const song = this.#past.pop();
    if (song === undefined) return false;
    this.#future.push(this.#state.song);
    this.#restore(song);
    return true;
  }

  redo(): boolean {
    const song = this.#future.pop();
    if (song === undefined) return false;
    this.#past.push(this.#state.song);
    this.#restore(song);
    return true;
  }

  #restore(song: Song): void {
    const selected = clampSelection(this.#state.selected, song.chords.length);
    const selectedTrack = clampTrackSelection(this.#state.selectedTrack, song);
    this.#emit({ ...this.#state, song, selected, selectedTrack });
  }

  #emit(next: AppState): void {
    const previous = this.#state;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener(next, previous);
  }
}
