/**
 * `window.croky` (docs/specs/assistant-v1.md §A3–A4): the editor as a JSON API for agents and the
 * assistant panel. Commands are validated with the core contract, dry-run on a copy, then applied
 * through the store (one undo step each, or one for the batch) and the app's audio, MIDI and saves.
 */
import type {
  Command,
  CommandError,
  CommandInfo,
  CommandOp,
  Song,
  TrackRole,
} from '@crokychords/core';
import {
  COMMANDS_SCHEMA_VERSION,
  COMMAND_INFO,
  COMMAND_OPS,
  commandJsonSchema,
  parseCommands,
  serializeSong,
} from '@crokychords/core';
import type { AppState, Store } from '../state';
import { activeTable } from '../state';
import { computeSuggestions } from '../views/suggest';
import type { CommandResult, Effect, EngineEnv, EngineState } from './engine';
import { step } from './engine';

export type ApplyResult =
  | { ok: true; applied: number; results: CommandResult[] }
  | { ok: false; applied: number; results: CommandResult[]; error: CommandError };

export interface ApplyOptions {
  /** 'each' (default): one undo step per song edit; 'batch': one for the whole call. */
  undo?: 'each' | 'batch';
}

/** What `window.croky` needs from the app besides the store. */
export interface CrokyHost {
  env: EngineEnv;
  /** Start playback; false when it did not start. */
  play(from?: number): Promise<boolean>;
  stop(): void;
  audition(token: string): void;
  setInstrument(track: string, role: TrackRole | null, instrument: string): void;
  /** The song as a .mid file with the current sound settings' programs. */
  midi(song: Song): { bytes: Uint8Array; fileName: string };
  save(): Promise<void>;
}

export interface SuggestionQuery {
  /** A chord index, or null for the "+" slot; default: the selection. */
  at?: number | null;
  limit?: number;
  popular?: boolean;
  diatonicOnly?: boolean;
}

export interface CrokyState {
  selected: number | null;
  playing: boolean;
  cursor: number;
  loop: { enabled: boolean; range: { start: number; end: number } | null };
  canUndo: boolean;
  canRedo: boolean;
  table: { status: AppState['tableStatus']; name: string };
  audioReady: boolean;
}

export interface CommandList {
  version: number;
  ops: (CommandInfo & { op: CommandOp })[];
  schema: Record<string, unknown>;
}

export interface Croky {
  readonly version: number;
  getSong(): Song;
  getState(): CrokyState;
  suggestions(query?: SuggestionQuery): {
    context: string;
    items: { token: string; name: string; probability: number | null }[];
  };
  commands(): CommandList;
  applyCommands(commands: unknown, options?: ApplyOptions): Promise<ApplyResult>;
  exportMidi(): Uint8Array;
}

declare global {
  interface Window {
    croky?: Croky;
  }
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The store's state as the engine sees it. */
export function engineState(store: Store): EngineState {
  const { song, selected, loop, loopRange } = store.state;
  return { song, selected, loop, loopRange, ...store.history };
}

/** The song exactly as `serializeSong` writes it, as a plain object. */
export function songJson(song: Song): Song {
  return JSON.parse(serializeSong(song)) as Song;
}

/**
 * Validate and dry-run `input` against the current state: the commands, or the first error.
 * Used by `applyCommands` and by the assistant panel to show a proposal.
 */
export function prepare(
  store: Store,
  env: EngineEnv,
  input: unknown,
  options: ApplyOptions = {},
  allowed: readonly CommandOp[] = COMMAND_OPS,
): { ok: true; commands: Command[]; preview: EngineState } | { ok: false; error: CommandError } {
  const parsed = parseCommands(input, allowed);
  if (!parsed.ok) return parsed;
  let sim = engineState(store);
  for (const [index, command] of parsed.commands.entries()) {
    if (options.undo === 'batch' && (command.op === 'undo' || command.op === 'redo')) {
      const message = `"${command.op}" cannot be part of a batch with one undo step`;
      return { ok: false, error: { code: 'invalid', index, op: command.op, path: 'op', message } };
    }
    const r = step(sim, command, env);
    if (!r.ok) return { ok: false, error: { ...r.error, index, op: command.op } };
    sim = r.state;
  }
  return { ok: true, commands: parsed.commands, preview: sim };
}

export function createCroky(store: Store, host: CrokyHost): Croky {
  let queue: Promise<unknown> = Promise.resolve();

  const runEffect = async (effect: Effect, result: CommandResult): Promise<string | null> => {
    switch (effect.type) {
      case 'play':
        return (await host.play(effect.from)) ? null : 'playback did not start';
      case 'stop':
        host.stop();
        return null;
      case 'audition':
        host.audition(effect.token);
        return null;
      case 'setInstrument':
        host.setInstrument(effect.track, effect.role, effect.instrument);
        return null;
      case 'exportMidi': {
        const { bytes, fileName } = host.midi(store.state.song);
        Object.assign(result, { fileName, bytes: bytes.length, base64: base64(bytes) });
        return null;
      }
      case 'save':
        try {
          await host.save();
          return null;
        } catch (e) {
          return `saving failed: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
  };

  const apply = async (input: unknown, options: ApplyOptions): Promise<ApplyResult> => {
    const prepared = prepare(store, host.env, input, options);
    if (!prepared.ok) return { ok: false, applied: 0, results: [], error: prepared.error };
    const batch = options.undo === 'batch';
    const base = store.state.song;
    const results: CommandResult[] = [];
    let failure: CommandError | null = null;
    for (const [index, command] of prepared.commands.entries()) {
      const live = engineState(store);
      const r = step(live, command, host.env);
      if (!r.ok) {
        failure = { ...r.error, index, op: command.op };
        break;
      }
      const { song, selected, loop, loopRange } = r.state;
      if (command.op === 'undo') store.undo();
      else if (command.op === 'redo') store.redo();
      else if (song !== live.song) {
        if (batch) store.preview(song, { selected, loop, loopRange });
        else store.commit(song, { selected, loop, loopRange });
      } else if (selected !== live.selected || loop !== live.loop || loopRange !== live.loopRange) {
        store.set({ selected, loop, loopRange });
      }
      const result = { ...r.result };
      for (const effect of r.effects) {
        const message = await runEffect(effect, result);
        if (message !== null) {
          failure = { code: 'failed', index, op: command.op, path: '', message };
          break;
        }
      }
      if (failure !== null) break;
      results.push(result);
    }
    if (batch && store.state.song !== base) store.commit(store.state.song, {}, { base });
    if (failure !== null) return { ok: false, applied: results.length, results, error: failure };
    return { ok: true, applied: results.length, results };
  };

  return {
    version: COMMANDS_SCHEMA_VERSION,

    getSong: () => songJson(store.state.song),

    getState() {
      const s = store.state;
      return {
        selected: s.selected,
        playing: s.playing,
        cursor: s.cursor,
        loop: { enabled: s.loop, range: s.loopRange === null ? null : { ...s.loopRange } },
        canUndo: store.canUndo,
        canRedo: store.canRedo,
        table: { status: s.tableStatus, name: activeTable(s).source.name },
        audioReady: s.audioReady,
      };
    },

    suggestions(query = {}) {
      const s = store.state;
      const at = query.at === undefined ? s.selected : query.at;
      const view = computeSuggestions({
        ...s,
        selected: at,
        suggestMode: query.popular === true ? 'popular' : 'context',
        diatonicOnly: query.diatonicOnly ?? s.diatonicOnly,
      });
      const limit = Math.max(1, Math.min(query.limit ?? view.items.length, view.items.length));
      return {
        context: view.contextLabel,
        items: view.items
          .slice(0, limit)
          .map(({ token, name, probability }) => ({ token, name, probability })),
      };
    },

    commands: () => ({
      version: COMMANDS_SCHEMA_VERSION,
      ops: COMMAND_OPS.map((op) => ({ op, ...COMMAND_INFO[op] })),
      schema: commandJsonSchema(),
    }),

    applyCommands(input, options = {}) {
      const run = queue.then(() => apply(input, options));
      queue = run.catch(() => undefined);
      return run;
    },

    exportMidi: () => host.midi(store.state.song).bytes,
  };
}
