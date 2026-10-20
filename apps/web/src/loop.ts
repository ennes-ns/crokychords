/**
 * Loop points (docs/specs/loop-v1.md): the loop range in beats, the helpers the grid, the keyboard
 * and the scheduler share, and the per-song persistence of the loop as UI state (not part of the
 * song schema).
 */

/** A loop range in beats: `start` inclusive, `end` exclusive, `0 <= start < end`. */
export interface LoopRange {
  start: number;
  end: number;
}

const EPSILON = 1e-9;

/**
 * The part of the song that loops: `range` clipped to the song, or the whole song when there is
 * no range or nothing of it is left inside the song.
 */
export function loopBounds(range: LoopRange | null, total: number): LoopRange {
  if (range !== null) {
    const start = Math.max(0, range.start);
    const end = Math.min(range.end, total);
    if (end - start > EPSILON) return { start, end };
  }
  return { start: 0, end: total };
}

/** Where Play starts: the loop start when looping (a range or the whole song), else beat 0. */
export function playStart(loop: boolean, range: LoopRange | null, total: number): number {
  return loop ? loopBounds(range, total).start : 0;
}

/** Bar `bar` (0-based) as a range. */
export function barRange(barBeats: number, bar: number): LoopRange {
  return { start: bar * barBeats, end: (bar + 1) * barBeats };
}

/** Bars `a` to `b` inclusive, in either order. */
export function spanBars(barBeats: number, a: number, b: number): LoopRange {
  return { start: Math.min(a, b) * barBeats, end: (Math.max(a, b) + 1) * barBeats };
}

/**
 * Shift+click on a bar number: move the nearer edge of the range so it includes `bar` (a bar
 * before the start moves the start, any other bar sets the end to that bar's end). Without a
 * range it loops just that bar.
 */
export function extendRange(range: LoopRange | null, barBeats: number, bar: number): LoopRange {
  const clicked = barRange(barBeats, bar);
  if (range === null) return clicked;
  if (clicked.start < range.start) return { start: clicked.start, end: range.end };
  return { start: range.start, end: clicked.end };
}

/**
 * `Alt+[`: the loop starts at `beat`. The end stays when it is after `beat`, else it becomes the
 * end of the song (`total`).
 */
export function withLoopStart(range: LoopRange | null, beat: number, total: number): LoopRange {
  const end = range !== null && range.end > beat + EPSILON ? range.end : Math.max(total, beat + 1);
  return { start: beat, end };
}

/** `Alt+]`: the loop ends at `beat`. The start stays when it is before `beat`, else it is 0. */
export function withLoopEnd(range: LoopRange | null, beat: number): LoopRange {
  const start = range !== null && range.start < beat - EPSILON ? range.start : 0;
  return { start, end: beat };
}

/** Short toolbar text for a range: `bars 2–3` on bar boundaries, else `bar.beat` positions. */
export function loopLabel(range: LoopRange, barBeats: number): string {
  const aligned = (beat: number): boolean =>
    Math.abs(beat / barBeats - Math.round(beat / barBeats)) < EPSILON;
  if (aligned(range.start) && aligned(range.end)) {
    const first = Math.round(range.start / barBeats) + 1;
    const last = Math.round(range.end / barBeats);
    return first === last ? `bar ${first}` : `bars ${first}–${last}`;
  }
  const position = (beat: number): string => {
    const bar = Math.floor(beat / barBeats + EPSILON);
    const inBar = Math.round((beat - bar * barBeats + 1) * 100) / 100;
    return `${bar + 1}.${inBar}`;
  };
  return `${position(range.start)}–${position(range.end)}`;
}

// ---------------------------------------------------------------------------------------------
// Persistence: one localStorage entry per saved progression (keyed by its record id).

export const LOOP_KEY_PREFIX = 'crokychords.loop.';
export const LOOP_SCHEMA_VERSION = 1;

/** The stored form; `startBeat`/`endBeat` are both null when no range is set. */
export interface StoredLoop {
  schema_version: typeof LOOP_SCHEMA_VERSION;
  enabled: boolean;
  startBeat: number | null;
  endBeat: number | null;
}

export interface LoopState {
  loop: boolean;
  loopRange: LoopRange | null;
}

export type LoopStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function serializeLoop(state: LoopState): string {
  const stored: StoredLoop = {
    schema_version: LOOP_SCHEMA_VERSION,
    enabled: state.loop,
    startBeat: state.loopRange?.start ?? null,
    endBeat: state.loopRange?.end ?? null,
  };
  return JSON.stringify(stored);
}

/** The loop state in `json`, or null when it is not a valid StoredLoop. */
export function parseLoop(json: string): LoopState | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root['schema_version'] !== LOOP_SCHEMA_VERSION) return null;
  const enabled = root['enabled'];
  const start = root['startBeat'];
  const end = root['endBeat'];
  if (typeof enabled !== 'boolean') return null;
  if (start === null && end === null) return { loop: enabled, loopRange: null };
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { loop: enabled, loopRange: { start, end } };
}

export function loadLoop(storage: LoopStorage | null, id: string): LoopState | null {
  try {
    const json = storage?.getItem(LOOP_KEY_PREFIX + id) ?? null;
    return json === null ? null : parseLoop(json);
  } catch {
    return null;
  }
}

export function saveLoop(storage: LoopStorage | null, id: string, state: LoopState): void {
  try {
    storage?.setItem(LOOP_KEY_PREFIX + id, serializeLoop(state));
  } catch {
    // UI state only: the loop is just not restored next time.
  }
}

export function sameRange(a: LoopRange | null, b: LoopRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

/** The parts of the Store and the SaveSession the persistence needs. */
export interface LoopStoreLike {
  readonly state: LoopState & { song: unknown };
  set(patch: Partial<LoopState>): void;
  subscribe(
    listener: (
      state: LoopState & { song: unknown },
      previous: LoopState & { song: unknown },
    ) => void,
  ): () => void;
}

export interface LoopSessionLike {
  readonly currentId: string | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Keep the loop of the open progression in `storage`. A loop change is written at once under the
 * open record's id. When the session opens a record (or the open record gets a new id: its first
 * save, a conflict copy), the stored loop of that id is applied; a record without a stored loop
 * takes the current one. `Store.load` clears the range, so a progression without a stored loop
 * opens without one. Returns the unsubscribe function.
 */
export function bindLoopPersistence(
  store: LoopStoreLike,
  session: LoopSessionLike,
  storage: LoopStorage | null,
): () => void {
  const sync = (): void => {
    const id = session.currentId;
    if (id === null) return;
    const stored = loadLoop(storage, id);
    const { loop, loopRange } = store.state;
    if (stored === null) {
      saveLoop(storage, id, { loop, loopRange });
      return;
    }
    if (stored.loop !== loop || !sameRange(stored.loopRange, loopRange)) {
      store.set({ loop: stored.loop, loopRange: stored.loopRange });
    }
  };
  const offStore = store.subscribe((state, previous) => {
    // A changed song with the loop is an opened record: the session applies its stored loop.
    if (state.song !== previous.song) return;
    if (state.loop === previous.loop && state.loopRange === previous.loopRange) return;
    const id = session.currentId;
    if (id !== null) saveLoop(storage, id, state);
  });
  const offSession = session.subscribe(sync);
  sync();
  return () => {
    offStore();
    offSession();
  };
}
