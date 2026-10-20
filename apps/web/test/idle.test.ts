import { describe, expect, it } from 'vitest';
import type { IdleTimer, SuspendableContext } from '../src/audio/idle';
import { IDLE_MS, IdleSuspender } from '../src/audio/idle';

class FakeTimer implements IdleTimer {
  #next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): number {
    const id = this.#next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(id: number): void {
    this.pending.delete(id);
  }
  /** Run every pending timeout once. */
  fire(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of due) t.fn();
  }
}

class FakeCtx implements SuspendableContext {
  state = 'running';
  calls: string[] = [];
  suspend(): Promise<void> {
    this.calls.push('suspend');
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.calls.push('resume');
    this.state = 'running';
    return Promise.resolve();
  }
}

function setup(busy = false) {
  const ctx = new FakeCtx();
  const timer = new FakeTimer();
  const state = { busy };
  const idle = new IdleSuspender(
    () => ctx,
    () => state.busy,
    timer,
  );
  return { ctx, timer, state, idle };
}

describe('IdleSuspender', () => {
  it('suspends IDLE_MS after the last touch when nothing plays or sounds', () => {
    const { ctx, timer, idle } = setup();
    idle.touch();
    idle.touch(); // re-arms: still one timer
    expect(timer.pending.size).toBe(1);
    expect([...timer.pending.values()][0]?.ms).toBe(IDLE_MS);
    expect(ctx.calls).toEqual([]);
    timer.fire();
    expect(ctx.calls).toEqual(['suspend']);
    expect(idle.suspended).toBe(true);
  });

  it('keeps running while busy and checks again later', () => {
    const { ctx, timer, state, idle } = setup(true);
    idle.touch();
    timer.fire();
    expect(ctx.calls).toEqual([]);
    expect(timer.pending.size).toBe(1);
    state.busy = false;
    timer.fire();
    expect(ctx.calls).toEqual(['suspend']);
  });

  it('suspends at once on check (tab hidden) unless busy', () => {
    const busy = setup(true);
    busy.idle.check();
    expect(busy.ctx.calls).toEqual([]);
    const quiet = setup();
    quiet.idle.check();
    expect(quiet.ctx.calls).toEqual(['suspend']);
    quiet.idle.check(); // already suspended: no second call
    expect(quiet.ctx.calls).toEqual(['suspend']);
  });

  it('wakes a suspended context before anything is scheduled', async () => {
    const { ctx, idle } = setup();
    idle.check();
    expect(await idle.wake()).toBe(true);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
    expect(idle.suspended).toBe(false);
    // A running context is not resumed again.
    expect(await idle.wake()).toBe(true);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
  });

  it('resumes after a suspend that is still pending', async () => {
    // Like a real context, calls settle in order: the resume waits for the pending suspend.
    const ctx = new FakeCtx();
    let queue = Promise.resolve();
    let settle: () => void = () => undefined;
    ctx.suspend = () => {
      ctx.calls.push('suspend');
      queue = new Promise<void>((resolve) => {
        settle = () => {
          ctx.state = 'suspended';
          resolve();
        };
      });
      return queue;
    };
    ctx.resume = async () => {
      ctx.calls.push('resume');
      await queue;
      ctx.state = 'running';
    };
    const idle = new IdleSuspender(
      () => ctx,
      () => false,
      new FakeTimer(),
    );
    idle.check();
    expect(ctx.state).toBe('running'); // the suspend has not settled yet
    const woken = idle.wake();
    settle();
    expect(await woken).toBe(true);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
  });

  it('does nothing without a context', async () => {
    const idle = new IdleSuspender(
      () => null,
      () => false,
      new FakeTimer(),
    );
    idle.check();
    expect(await idle.wake()).toBe(false);
  });
});
