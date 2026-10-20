/**
 * Suspends the AudioContext while nothing sounds, so an idle tab costs no audio-thread CPU
 * (issue #82). The engine calls `touch()` on every sign of use (start, Stop); after `IDLE_MS`
 * without playback and without live voices the context is suspended. `wake()` resumes it before
 * anything is scheduled again; the scheduler's lookahead covers the resume latency. A suspended
 * context renders nothing, so suspending only when every voice has finished cannot click.
 */

/** Quiet time after Stop (or the last note) before the context is suspended (ms). */
export const IDLE_MS = 3000;

/** The part of an AudioContext the idle logic drives. */
export interface SuspendableContext {
  readonly state: string;
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

export interface IdleTimer {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export class IdleSuspender {
  readonly #ctx: () => SuspendableContext | null;
  readonly #busy: () => boolean;
  readonly #timer: IdleTimer;
  #timerId: number | null = null;
  /** True from the moment we ask for a suspend until the next wake. */
  #suspended = false;

  /** `busy` is true while something plays or sounds (playback, live voices, slices). */
  constructor(ctx: () => SuspendableContext | null, busy: () => boolean, timer?: IdleTimer) {
    this.#ctx = ctx;
    this.#busy = busy;
    this.#timer = timer ?? {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    };
  }

  /** The context was suspended for idling (and not woken since). */
  get suspended(): boolean {
    return this.#suspended;
  }

  /** Something happened: suspend `IDLE_MS` from now unless the audio is busy then. */
  touch(): void {
    if (this.#timerId !== null) this.#timer.clearTimeout(this.#timerId);
    this.#timerId = this.#timer.setTimeout(() => {
      this.#timerId = null;
      this.check();
    }, IDLE_MS);
  }

  /** Suspend now when nothing plays or sounds, else check again later (tab hidden, timer). */
  check(): void {
    const ctx = this.#ctx();
    if (ctx === null || ctx.state !== 'running' || this.#suspended) return;
    if (this.#busy()) {
      this.touch();
      return;
    }
    this.#suspended = true;
    void ctx.suspend().catch(() => {
      this.#suspended = false;
    });
  }

  /**
   * Resume a context we suspended, before notes are scheduled; resolves to whether it runs. A
   * resume after a pending suspend is ordered after it, so the context ends up running.
   */
  async wake(): Promise<boolean> {
    const ctx = this.#ctx();
    if (ctx === null) return false;
    const resume = this.#suspended || ctx.state === 'suspended';
    this.#suspended = false;
    this.touch();
    if (resume) {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
  }
}
