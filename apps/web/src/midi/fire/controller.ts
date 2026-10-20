/**
 * Akai Fire gestures (docs/specs/akai-fire-v1.md section 3): turns decoded Fire events into
 * the editor's existing `Actions`, and computes the button LEDs. No MIDI I/O here.
 */
import type { Song } from '@crokychords/core';
import { totalBeats } from '@crokychords/core';
import type { Actions } from '../../actions';
import { songTracks } from '../../band';
import { MIN_BEATS, chordStart, moveSelection } from '../../edit';
import type { AppState, FireState, Store } from '../../state';
import type { SuggestionItem } from '../../views/suggest';
import { computeSuggestions } from '../../views/suggest';
import { TEMPO_MAX, TEMPO_MIN } from '../../views/toolbar';
import type { FireEvent } from './protocol';
import {
  BTN_ALT,
  BTN_BROWSER,
  BTN_GRID_LEFT,
  BTN_GRID_RIGHT,
  BTN_PATTERN,
  BTN_PAT_DOWN,
  BTN_PAT_UP,
  BTN_PLAY,
  BTN_REC,
  BTN_SELECT_PRESS,
  BTN_SHIFT,
  BTN_SOLO,
  BTN_STEP,
  BTN_STOP,
  ENC_FILTER,
  ENC_PAN,
  ENC_RESONANCE,
  ENC_SELECT,
  ENC_VOLUME,
  LED_ROW,
  ROW_LED_GREEN,
  ROW_LED_OFF,
  ROW_LED_RED,
} from './protocol';
import {
  PALETTE_ROW,
  ROW_BEATS,
  TIMELINE_ROWS,
  chordAtBeat,
  cursorLimit,
  maxScroll,
  padBeat,
  paletteToken,
} from './view';

/** Encoders whose touch notes end a coalesced edit. */
const TOUCH_NOTES = new Set([ENC_VOLUME, ENC_PAN, ENC_FILTER, ENC_RESONANCE]);

interface Held {
  row: number;
  col: number;
  index: number;
  /** The chord was already selected on press: releasing without a resize deselects it. */
  wasSelected: boolean;
  resized: boolean;
}

/** Suggestions for the palette and the SELECT encoder, memoised on their inputs. */
export class SuggestionCache {
  #key: unknown[] = [];
  #items: SuggestionItem[] = [];

  get(state: AppState): SuggestionItem[] {
    const { song, selected, suggestMode, diatonicOnly, table, ngrams } = state;
    const key = [song, selected, suggestMode, diatonicOnly, table, ngrams];
    if (key.some((v, i) => v !== this.#key[i])) {
      this.#key = key;
      this.#items = computeSuggestions(state).items;
    }
    return this.#items;
  }
}

export class FireController {
  readonly #store: Store;
  readonly #actions: Actions;
  readonly #suggestions: SuggestionCache;
  #shift = false;
  #alt = false;
  #held: Held | null = null;
  /** An encoder edit in progress: previewed per detent, committed as one undo step. */
  #pending: { encoder: number; base: Song } | null = null;

  constructor(store: Store, actions: Actions, suggestions = new SuggestionCache()) {
    this.#store = store;
    this.#actions = actions;
    this.#suggestions = suggestions;
  }

  get shift(): boolean {
    return this.#shift;
  }

  get alt(): boolean {
    return this.#alt;
  }

  suggestions(state: AppState = this.#store.state): SuggestionItem[] {
    return this.#suggestions.get(state);
  }

  /** Forget held modifiers and pads (device unplugged), committing any open encoder edit. */
  reset(): void {
    this.#flush();
    this.#shift = false;
    this.#alt = false;
    this.#held = null;
  }

  handle(event: FireEvent): void {
    switch (event.type) {
      case 'pad':
        this.#flush();
        if (event.row === PALETTE_ROW) {
          if (event.down) this.#palette(event.col);
        } else if (event.down) this.#padDown(event.row, event.col);
        else this.#padUp(event.row, event.col);
        break;
      case 'button':
        this.#button(event.note, event.down);
        break;
      case 'turn':
        this.#turn(event.encoder, event.delta);
        break;
    }
  }

  // --- pads ---------------------------------------------------------------------------------

  #palette(col: number): void {
    const state = this.#store.state;
    const token = paletteToken(state, this.suggestions(state), col);
    if (token === null) return;
    // Same rule as the Next chord panel: replace the selected chord, add on the "+" slot (no
    // selection); SHIFT inserts after the selected chord instead.
    this.#actions.place(token, this.#shift);
    this.#setFire({ cursor: 0 });
    this.#audition(token);
  }

  #padDown(row: number, col: number): void {
    const { song, selected, fire } = this.#store.state;
    const beat = padBeat(fire.scroll, row, col);
    const index = chordAtBeat(song, beat);
    const held = this.#held;
    if (held !== null) {
      // Hold a chord and tap another pad: the chord now ends on that beat (longer or shorter).
      const start = chordStart(song, held.index);
      const chord = song.chords[held.index];
      if (chord !== undefined && beat > start) {
        this.#actions.select(held.index);
        this.#actions.resizeSelected(Math.max(MIN_BEATS, beat + 1 - start) - chord.beats);
        held.resized = true;
      }
      return;
    }
    if (index === null) {
      if (beat >= totalBeats(song)) {
        this.#actions.appendDefault();
        this.#setFire({ cursor: 0 });
        this.#auditionSelected();
      }
      return;
    }
    if (this.#alt) {
      this.#actions.select(index);
      this.#actions.removeSelected();
      return;
    }
    this.#held = { row, col, index, wasSelected: selected === index, resized: false };
    if (selected !== index) {
      this.#actions.select(index);
      this.#setFire({ cursor: 0 });
    }
    this.#auditionSelected();
  }

  #padUp(row: number, col: number): void {
    const held = this.#held;
    if (held === null || held.row !== row || held.col !== col) return;
    this.#held = null;
    if (held.wasSelected && !held.resized) this.#actions.select(null);
  }

  // --- buttons ------------------------------------------------------------------------------

  #button(note: number, down: boolean): void {
    if (note === BTN_SHIFT) {
      this.#shift = down;
      return;
    }
    if (note === BTN_ALT) {
      this.#alt = down;
      return;
    }
    if (TOUCH_NOTES.has(note)) {
      if (!down && this.#pending?.encoder === note) this.#flush();
      return;
    }
    if (!down) return;
    this.#flush();
    const state = this.#store.state;
    const { song, selected } = state;
    const solo = BTN_SOLO.findIndex((n) => n === note);
    if (solo >= 0) {
      const track = songTracks(song)[solo];
      if (track === undefined) return;
      if (this.#shift) this.#actions.selectTrack(track.id);
      else this.#actions.toggleMute(track.id);
      return;
    }
    switch (note) {
      case BTN_PLAY:
        this.#actions.togglePlay();
        break;
      case BTN_STOP:
        this.#actions.stop();
        this.#setFire({ scroll: 0 });
        break;
      case BTN_REC:
        this.#actions.setLoop(!state.loop);
        break;
      case BTN_PATTERN:
        if (this.#shift) this.#actions.redo();
        else this.#actions.undo();
        break;
      case BTN_GRID_LEFT:
      case BTN_GRID_RIGHT: {
        const delta = note === BTN_GRID_LEFT ? -1 : 1;
        this.#select(moveSelection(selected, delta, song.chords.length));
        break;
      }
      case BTN_PAT_UP:
      case BTN_PAT_DOWN: {
        const max = maxScroll(song);
        const up = note === BTN_PAT_UP;
        const scroll = this.#shift
          ? up
            ? 0
            : max
          : Math.max(0, Math.min(max, state.fire.scroll + (up ? -1 : 1)));
        this.#setFire({ scroll });
        break;
      }
      case BTN_BROWSER:
        if (this.#shift) this.#store.set({ diatonicOnly: !state.diatonicOnly });
        else
          this.#store.set({ suggestMode: state.suggestMode === 'context' ? 'popular' : 'context' });
        this.#setFire({ cursor: 0 });
        break;
      case BTN_SELECT_PRESS: {
        const item = this.suggestions(state)[state.fire.cursor];
        if (item === undefined) break;
        if (!this.#shift) {
          this.#actions.place(item.token);
          this.#setFire({ cursor: 0 });
        }
        this.#audition(item.token);
        break;
      }
    }
  }

  // --- encoders -----------------------------------------------------------------------------

  #turn(encoder: number, delta: number): void {
    const sign = delta > 0 ? 1 : -1;
    const state = this.#store.state;
    if (encoder === ENC_SELECT) {
      this.#flush();
      if (this.#shift) {
        this.#select(moveSelection(state.selected, sign, state.song.chords.length));
        return;
      }
      const limit = cursorLimit(this.suggestions(state));
      const cursor = Math.max(0, Math.min(limit - 1, state.fire.cursor + sign));
      if (limit > 0 && cursor !== state.fire.cursor) this.#setFire({ cursor });
      return;
    }
    if (encoder === ENC_VOLUME) {
      const { selected } = state;
      if (selected === null) return;
      const step = this.#shift ? MIN_BEATS : 1;
      this.#edit(encoder, (song) => {
        const chord = song.chords[selected];
        if (chord === undefined) return song;
        const beats = Math.max(MIN_BEATS, chord.beats + sign * step);
        const chords = [...song.chords];
        chords[selected] = { ...chord, beats };
        return { ...song, chords };
      });
      return;
    }
    if (encoder === ENC_RESONANCE) {
      const step = this.#shift ? 5 : 1;
      this.#edit(encoder, (song) => {
        const tempo = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, song.tempo + sign * step));
        return tempo === song.tempo ? song : { ...song, tempo };
      });
    }
    // PAN and FILTER (inversions, extensions) are v2.
  }

  #edit(encoder: number, change: (song: Song) => Song): void {
    if (this.#pending !== null && this.#pending.encoder !== encoder) this.#flush();
    const song = this.#store.state.song;
    if (this.#pending === null) this.#pending = { encoder, base: song };
    const next = change(song);
    if (next !== song) this.#actions.previewSong(next);
  }

  /** Commit the open encoder edit as one undo step. */
  #flush(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    const song = this.#store.state.song;
    if (song !== pending.base) this.#actions.updateSong(song, pending.base);
  }

  // --- helpers ------------------------------------------------------------------------------

  #select(index: number | null): void {
    this.#actions.select(index);
    this.#setFire({ cursor: 0 });
    this.#auditionSelected();
  }

  #auditionSelected(): void {
    const { song, selected } = this.#store.state;
    const chord = selected === null ? undefined : song.chords[selected];
    if (chord !== undefined) this.#audition(chord.token);
  }

  #audition(token: string): void {
    if (!this.#store.state.playing) this.#actions.audition(token);
  }

  #setFire(patch: Partial<FireState>): void {
    const fire = this.#store.state.fire;
    const next = { ...fire, ...patch };
    if (next.scroll !== fire.scroll || next.cursor !== fire.cursor || next.status !== fire.status) {
      this.#store.set({ fire: next });
    }
  }
}

/** Scroll that keeps the playhead visible while playing (null = leave it). */
export function followScroll(state: Pick<AppState, 'playing' | 'cursor' | 'fire'>): number | null {
  if (!state.playing) return null;
  const row = Math.floor(Math.floor(state.cursor) / ROW_BEATS);
  const { scroll } = state.fire;
  if (row >= scroll && row < scroll + TIMELINE_ROWS) return null;
  return row;
}

/** Button and row LED values by CC number. */
export function buttonLeds(
  state: Pick<AppState, 'song' | 'playing' | 'loop'>,
  modifiers: { shift: boolean; alt: boolean },
): Map<number, number> {
  const leds = new Map<number, number>([
    [BTN_PLAY, state.playing ? 2 : 1],
    [BTN_STOP, 1],
    [BTN_REC, state.loop ? 2 : 0],
    [BTN_SHIFT, modifiers.shift ? 2 : 1],
    [BTN_ALT, modifiers.alt ? 2 : 1],
    [BTN_STEP, 2],
    [BTN_PATTERN, 1],
    [BTN_PAT_UP, 1],
    [BTN_PAT_DOWN, 1],
    [BTN_GRID_LEFT, 1],
    [BTN_GRID_RIGHT, 1],
    [BTN_BROWSER, 1],
  ]);
  const tracks = songTracks(state.song);
  LED_ROW.forEach((cc, i) => {
    const track = tracks[i];
    leds.set(cc, track === undefined ? ROW_LED_OFF : track.muted ? ROW_LED_RED : ROW_LED_GREEN);
  });
  return leds;
}
