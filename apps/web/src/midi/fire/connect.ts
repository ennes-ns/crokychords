/**
 * Akai Fire connection: asks for Web MIDI with SysEx only when the user clicks "Connect Fire",
 * finds the Fire's ports by name, feeds its input to the controller, and paints the pads, LEDs
 * and OLED from the store. Repaints are diffed (only changed pads, in one SysEx; the OLED only
 * when its frame changed, as one full frame) and coalesced to one per animation frame; the OLED
 * is capped at OLED_MAX_FPS. The device is cleared on disconnect and page hide, and the
 * connection re-attaches when the Fire is plugged in again (statechange).
 *
 * This is a second MIDIAccess next to `MidiOut` (the DAW output without SysEx); the two use
 * different ports and do not interfere.
 */
import type { FireStatus, Store } from '../../state';
import type { MidiOutputLike } from '../webmidi';
import type { FireController } from './controller';
import { buttonLeds, followScroll } from './controller';
import { OLED_MAX_FPS, oledModel, oledUpdate, renderOled } from './oled';
import type { OledFrame, Rgb } from './protocol';
import {
  PAD_COUNT,
  PORT_MATCH,
  allLedsOff,
  blankFrame,
  decodeInput,
  ledCc,
  oledSysex,
  padsSysex,
} from './protocol';
import { renderPads } from './view';

export interface FireMessageEvent {
  readonly data: Uint8Array | null;
}

export interface FireInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state?: string;
  addEventListener(type: 'midimessage', listener: (event: FireMessageEvent) => void): void;
  removeEventListener(type: 'midimessage', listener: (event: FireMessageEvent) => void): void;
  open?(): Promise<unknown>;
}

export interface FireAccessLike {
  readonly inputs: { forEach(fn: (input: FireInputLike) => void): void };
  readonly outputs: { forEach(fn: (output: MidiOutputLike) => void): void };
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export type RequestFireAccess = () => Promise<FireAccessLike>;

/** navigator.requestMIDIAccess with SysEx, or null in browsers without Web MIDI. */
export function browserFireAccess(): RequestFireAccess | null {
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    return null;
  }
  return () => navigator.requestMIDIAccess({ sysex: true });
}

export function isFirePort(name: string | null): boolean {
  return name !== null && name.toUpperCase().includes(PORT_MATCH);
}

/** The first connected port whose name says Fire. */
function firstFirePort<T extends { readonly name: string | null; readonly state?: string }>(ports: {
  forEach(fn: (port: T) => void): void;
}): T | null {
  const found: T[] = [];
  ports.forEach((port) => {
    if (isFirePort(port.name) && port.state !== 'disconnected') found.push(port);
  });
  return found[0] ?? null;
}

export interface FireConnectionOptions {
  /** Schedules a repaint (requestAnimationFrame in the browser). */
  schedule?: (paint: () => void) => void;
  /** Milliseconds clock for the OLED rate cap (performance.now in the browser). */
  now?: () => number;
  /** Runs `fn` after `ms` milliseconds (setTimeout in the browser). */
  delay?: (fn: () => void, ms: number) => void;
}

/** Shortest time between two OLED updates. */
const OLED_INTERVAL_MS = 1000 / OLED_MAX_FPS;

export class FireConnection {
  readonly #store: Store;
  readonly #request: RequestFireAccess | null;
  readonly #schedule: (paint: () => void) => void;
  readonly #now: () => number;
  readonly #delay: (fn: () => void, ms: number) => void;
  readonly controller: FireController;
  #access: FireAccessLike | null = null;
  #input: FireInputLike | null = null;
  #output: MidiOutputLike | null = null;
  #pads: Rgb[] | null = null;
  #leds = new Map<number, number>();
  /** The frame on the device (null: unknown, send a full frame next). */
  #oled: OledFrame | null = null;
  /** The frame to show, waiting for the rate cap. */
  #oledNext: OledFrame | null = null;
  #oledKey: string | null = null;
  #oledAt = -Infinity;
  #oledTimer = false;
  #queued = false;
  #wanted = false;
  #unsubscribe: (() => void) | null = null;

  readonly #onMessage = (event: FireMessageEvent): void => {
    if (event.data === null) return;
    const decoded = decodeInput(event.data);
    if (decoded === null) return;
    this.controller.handle(decoded);
    this.#requestPaint();
  };

  readonly #onStateChange = (): void => {
    if (this.#wanted) this.#attach();
  };

  constructor(
    store: Store,
    request: RequestFireAccess | null,
    controller: FireController,
    options: FireConnectionOptions = {},
  ) {
    this.#store = store;
    this.#request = request;
    this.controller = controller;
    this.#schedule =
      options.schedule ??
      ((paint) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => paint());
        else setTimeout(paint, 0);
      });
    this.#now = options.now ?? (() => performance.now());
    this.#delay = options.delay ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Ask for SysEx access (call from the "Connect Fire" click) and attach to the Fire. */
  async connect(): Promise<void> {
    if (this.#request === null) {
      this.#setStatus('unsupported');
      return;
    }
    this.#wanted = true;
    if (this.#access === null) {
      this.#setStatus('pending');
      try {
        this.#access = await this.#request();
      } catch {
        this.#wanted = false;
        this.#setStatus('denied');
        return;
      }
      if (!this.#wanted) return;
      this.#access.addEventListener('statechange', this.#onStateChange);
    }
    this.#unsubscribe ??= this.#store.subscribe(() => this.#requestPaint());
    this.#attach();
  }

  /** Clear the device and stop listening; the access stays for a quick reconnect. */
  disconnect(): void {
    this.#wanted = false;
    this.#detach(true);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#setStatus('off');
  }

  /** Page hidden or unloading: leave the device dark (it keeps the last frame otherwise). */
  suspend(): void {
    if (this.#output !== null) this.#clear(this.#output);
    this.#forget();
  }

  /** Page shown again (back/forward cache): repaint everything. */
  resume(): void {
    if (this.#output === null) return;
    this.#forget();
    this.#requestPaint();
  }

  get connected(): boolean {
    return this.#output !== null;
  }

  #attach(): void {
    const access = this.#access;
    if (access === null) return;
    const input = firstFirePort(access.inputs);
    const output = firstFirePort(access.outputs);
    if (input === this.#input && output === this.#output) {
      this.#setStatus(output === null ? 'waiting' : 'connected');
      return;
    }
    this.#detach(false);
    if (input === null || output === null) {
      this.#setStatus('waiting');
      return;
    }
    this.#attachPorts(input, output);
  }

  #attachPorts(input: FireInputLike, output: MidiOutputLike): void {
    this.#input = input;
    this.#output = output;
    input.addEventListener('midimessage', this.#onMessage);
    void input.open?.().catch(() => undefined);
    this.#send(allLedsOff());
    this.#setStatus('connected');
    this.#requestPaint();
  }

  /** Drop the current ports; `clear` blanks the device first (skipped when it is unplugged). */
  #detach(clear: boolean): void {
    this.#input?.removeEventListener('midimessage', this.#onMessage);
    const output = this.#output;
    if (clear && output !== null && output.state !== 'disconnected') this.#clear(output);
    this.#input = null;
    this.#output = null;
    this.#forget();
    this.controller.reset();
  }

  /** Forget what the device shows, so the next paint sends everything. */
  #forget(): void {
    this.#pads = null;
    this.#leds.clear();
    this.#oled = null;
    this.#oledNext = null;
    this.#oledKey = null;
  }

  #clear(output: MidiOutputLike): void {
    try {
      output.send(
        padsSysex(Array.from({ length: PAD_COUNT }, (_, index) => ({ index, rgb: [0, 0, 0] }))),
      );
      output.send(allLedsOff());
      output.send(oledSysex(blankFrame()));
    } catch {
      // The port vanished while we were clearing it.
    }
  }

  #requestPaint(): void {
    if (this.#queued || this.#output === null) return;
    this.#queued = true;
    this.#schedule(() => {
      this.#queued = false;
      this.paint();
    });
  }

  /** Send what changed since the last paint (tests call this directly). */
  paint(): void {
    if (this.#output === null) return;
    const follow = followScroll(this.#store.state);
    if (follow !== null) this.#store.set({ fire: { ...this.#store.state.fire, scroll: follow } });
    const state = this.#store.state;
    const pads = renderPads(state, this.controller.suggestions(state));
    const changed: { index: number; rgb: Rgb }[] = [];
    pads.forEach((rgb, index) => {
      const old = this.#pads?.[index];
      if (old === undefined || old[0] !== rgb[0] || old[1] !== rgb[1] || old[2] !== rgb[2]) {
        changed.push({ index, rgb });
      }
    });
    this.#pads = pads;
    if (changed.length > 0) this.#send(padsSysex(changed));
    const leds = buttonLeds(state, this.controller);
    for (const [cc, value] of leds) {
      if (this.#leds.get(cc) === value) continue;
      this.#leds.set(cc, value);
      this.#send(ledCc(cc, value));
    }
    const model = oledModel(state, this.controller.suggestions(state), this.controller.touched);
    const key = JSON.stringify(model);
    if (key !== this.#oledKey) {
      this.#oledKey = key;
      this.#oledNext = renderOled(model);
    }
    this.#flushOled();
  }

  /** Send the pending OLED frame if it changed, at most OLED_MAX_FPS times a second. */
  #flushOled(): void {
    const next = this.#oledNext;
    if (next === null || this.#output === null) return;
    const wait = this.#oledAt + OLED_INTERVAL_MS - this.#now();
    if (wait > 0) {
      if (!this.#oledTimer) {
        this.#oledTimer = true;
        this.#delay(() => {
          this.#oledTimer = false;
          this.#flushOled();
        }, wait);
      }
      return;
    }
    this.#oledNext = null;
    const update = oledUpdate(this.#oled, next);
    this.#oled = next;
    if (update === null) return;
    this.#send(update);
    this.#oledAt = this.#now();
  }

  #send(data: number[]): void {
    try {
      this.#output?.send(data);
    } catch {
      // A disconnected port throws; statechange re-attaches when it is back.
    }
  }

  #setStatus(status: FireStatus): void {
    const fire = this.#store.state.fire;
    if (fire.status !== status) this.#store.set({ fire: { ...fire, status } });
  }
}

/** Leave the Fire dark when the page goes away and repaint it when it comes back. */
export function bindFirePageEvents(connection: FireConnection, target: Window): void {
  target.addEventListener('pagehide', () => connection.suspend());
  target.addEventListener('beforeunload', () => connection.suspend());
  target.addEventListener('pageshow', (event) => {
    if (event.persisted) connection.resume();
  });
}
