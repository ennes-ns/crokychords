import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import type { FireAccessLike, FireInputLike, FireMessageEvent } from '../src/midi/fire/connect';
import { FireConnection, isFirePort } from '../src/midi/fire/connect';
import { FireController } from '../src/midi/fire/controller';
import type { MidiOutputLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';

class FakeInput implements FireInputLike {
  state = 'connected';
  listener: ((event: FireMessageEvent) => void) | null = null;
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  addEventListener(_type: 'midimessage', listener: (event: FireMessageEvent) => void): void {
    this.listener = listener;
  }
  removeEventListener(): void {
    this.listener = null;
  }
  emit(...bytes: number[]): void {
    this.listener?.({ data: new Uint8Array(bytes) });
  }
}

class FakeOutput implements MidiOutputLike {
  state = 'connected';
  sent: number[][] = [];
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  send(data: number[]): void {
    this.sent.push(data);
  }
}

function fakeAccess() {
  const inputs: FakeInput[] = [new FakeInput('in-daw', 'Virtual Synth')];
  const outputs: FakeOutput[] = [new FakeOutput('out-daw', 'Virtual Synth')];
  let onChange: (() => void) | null = null;
  const access: FireAccessLike = {
    inputs: { forEach: (fn) => inputs.forEach(fn) },
    outputs: { forEach: (fn) => outputs.forEach(fn) },
    addEventListener: (_t, l) => {
      onChange = l;
    },
    removeEventListener: () => {
      onChange = null;
    },
  };
  const plug = () => {
    const input = new FakeInput('in-fire', 'FL STUDIO FIRE Jack 1');
    const output = new FakeOutput('out-fire', 'FL STUDIO FIRE Jack 1');
    inputs.push(input);
    outputs.push(output);
    onChange?.();
    return { input, output };
  };
  const unplug = () => {
    for (const p of [...inputs, ...outputs]) if (isFirePort(p.name)) p.state = 'disconnected';
    onChange?.();
  };
  return { access, plug, unplug, outputs };
}

function setup(request: (() => Promise<FireAccessLike>) | null) {
  const song = createSong({ chords: ['I', 'V'].map((token) => ({ token, beats: 4 })) });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const queue: (() => void)[] = [];
  const clock = { now: 0, timers: [] as { at: number; fn: () => void }[] };
  const connection = new FireConnection(store, request, new FireController(store, actions), {
    schedule: (paint) => queue.push(paint),
    now: () => clock.now,
    delay: (fn, ms) => clock.timers.push({ at: clock.now + ms, fn }),
  });
  const flush = () => queue.splice(0).forEach((paint) => paint());
  /** Advance the fake clock and run the timers that are due. */
  const advance = (ms: number) => {
    clock.now += ms;
    const due = clock.timers.filter((t) => t.at <= clock.now);
    clock.timers = clock.timers.filter((t) => t.at > clock.now);
    due.forEach((t) => t.fn());
  };
  return { store, connection, queue, flush, advance, clock, actions };
}

const sysexPads = (m: number[]) => m[0] === 0xf0 && m[4] === 0x65;
const padCount = (m: number[]) => (((m[5] ?? 0) << 7) | (m[6] ?? 0)) / 4;
const sysexOled = (m: number[]) => m[0] === 0xf0 && m[4] === 0x0e;

describe('FireConnection', () => {
  it('says unsupported without Web MIDI and denied when SysEx is refused', async () => {
    const a = setup(null);
    await a.connection.connect();
    expect(a.store.state.fire.status).toBe('unsupported');
    const b = setup(() => Promise.reject(new Error('SecurityError')));
    await b.connection.connect();
    expect(b.store.state.fire.status).toBe('denied');
  });

  it('waits for a Fire, then paints the OLED, LEDs and all pads in one SysEx', async () => {
    const fake = fakeAccess();
    const { store, connection, flush, queue } = setup(() => Promise.resolve(fake.access));
    await connection.connect();
    expect(store.state.fire.status).toBe('waiting');
    const { output } = fake.plug();
    expect(store.state.fire.status).toBe('connected');
    expect(output.sent[0]).toEqual([0xb0, 0x7f, 0]);
    expect(queue).toHaveLength(1);
    flush();
    const pads = output.sent.filter(sysexPads);
    expect(pads).toHaveLength(1);
    expect(padCount(pads[0] ?? [])).toBe(64);
    const oled = output.sent.filter(sysexOled);
    expect(oled.map((m) => m.length)).toEqual([1183]); // one full frame
    expect(output.sent).toContainEqual([0xb0, 0x1b, 0x11]); // BANK LED 1: Replace
    // The DAW port is untouched.
    expect(fake.outputs[0]?.sent).toEqual([]);
  });

  it('turns pad presses into edits and repaints only what changed, once per frame', async () => {
    const fake = fakeAccess();
    const { store, connection, flush, queue } = setup(() => Promise.resolve(fake.access));
    await connection.connect();
    const { input, output } = fake.plug();
    flush();
    output.sent = [];
    input.emit(0x90, 0x36 + 4, 0x7f); // tap the V pad
    input.emit(0x80, 0x36 + 4, 0);
    expect(store.state.selected).toBe(1);
    expect(queue.length).toBeLessThanOrEqual(1);
    flush();
    const pads = output.sent.filter(sysexPads);
    expect(pads).toHaveLength(1);
    // V's four beats, plus the suggestion row that follows the selection.
    expect(padCount(pads[0] ?? [])).toBeLessThan(64);
    expect(padCount(pads[0] ?? [])).toBeGreaterThanOrEqual(4);
    output.sent = [];
    connection.paint();
    expect(output.sent).toEqual([]);
  });

  it('clears the device on disconnect and page hide, and re-attaches after a replug', async () => {
    const fake = fakeAccess();
    const { store, connection, flush } = setup(() => Promise.resolve(fake.access));
    await connection.connect();
    let { output } = fake.plug();
    flush();
    output.sent = [];
    connection.suspend();
    expect(output.sent.map((m) => m.length)).toEqual([264, 3, 1183]);
    expect(output.sent[0]?.slice(7).filter((_, i) => i % 4 !== 0)).toEqual(
      new Array<number>(192).fill(0),
    );

    fake.unplug();
    expect(store.state.fire.status).toBe('waiting');
    ({ output } = fake.plug());
    expect(store.state.fire.status).toBe('connected');
    flush();
    output.sent = [];
    connection.disconnect();
    expect(store.state.fire.status).toBe('off');
    expect(output.sent.map((m) => m.length)).toEqual([264, 3, 1183]);
    output.sent = [];
    store.set({ selected: 0 });
    flush();
    expect(output.sent).toEqual([]);
  });

  it('sends a full OLED frame only when it changed, at most 30 frames a second', async () => {
    const fake = fakeAccess();
    const { store, connection, flush, advance, clock } = setup(() => Promise.resolve(fake.access));
    await connection.connect();
    const { input, output } = fake.plug();
    flush();
    output.sent = [];
    // BANK toggles Add mode: the badge on the OLED changes.
    input.emit(0x90, 0x1a, 0x7f);
    input.emit(0x80, 0x1a, 0);
    expect(store.state.fire.mode).toBe('add');
    flush();
    // Within 1/30 s of the first frame: nothing yet, a timer sends it when the interval is over.
    expect(output.sent.filter(sysexOled)).toEqual([]);
    expect(output.sent).toContainEqual([0xb0, 0x1b, 0x12]); // BANK LED 2: Add
    expect(clock.timers).toHaveLength(1);
    advance(40);
    const first = output.sent.filter(sysexOled);
    expect(first.map((m) => m.length)).toEqual([1183]);
    // Two changes inside one interval coalesce into one update with the latest state.
    output.sent = [];
    input.emit(0x90, 0x1a, 0x7f);
    flush();
    input.emit(0x90, 0x1a, 0x7f);
    flush();
    expect(store.state.fire.mode).toBe('add');
    expect(output.sent.filter(sysexOled)).toEqual([]); // back where the device already is
    advance(40);
    expect(output.sent.filter(sysexOled)).toEqual([]);
    // Nothing changed: nothing sent.
    connection.paint();
    expect(output.sent.filter(sysexOled)).toEqual([]);
  });
});
