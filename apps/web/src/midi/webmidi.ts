/** Web MIDI output: device list, chords with timestamps, all-notes-off. */
import type { MidiPortInfo } from '../state';

/** The parts of the Web MIDI API we use (lets tests pass a fake). */
export interface MidiOutputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state?: string;
  send(data: number[], timestamp?: number): void;
  clear?(): void;
}

export interface MidiAccessLike {
  readonly outputs: { forEach(fn: (output: MidiOutputLike) => void): void };
  addEventListener(type: 'statechange', listener: () => void): void;
}

export type RequestMidiAccess = () => Promise<MidiAccessLike>;

export type MidiEnableResult = 'ready' | 'unsupported' | 'denied';

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL_CHANGE = 0xb0;
const ALL_SOUND_OFF = 120;
const ALL_NOTES_OFF = 123;

/** navigator.requestMIDIAccess, or null in browsers without Web MIDI. */
export function browserMidiAccess(): RequestMidiAccess | null {
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    return null;
  }
  return () => navigator.requestMIDIAccess({ sysex: false });
}

export class MidiOut {
  readonly #request: RequestMidiAccess | null;
  #access: MidiAccessLike | null = null;
  #outputId: string | null = null;
  /** Notes sent since the last all-notes-off, so Stop can release them explicitly. */
  #sounding = new Set<number>();

  channel = 0;
  velocity = 96;

  /** Called with the current outputs whenever a device appears or disappears. */
  onOutputsChange: ((outputs: MidiPortInfo[]) => void) | null = null;

  constructor(request: RequestMidiAccess | null) {
    this.#request = request;
  }

  get supported(): boolean {
    return this.#request !== null;
  }

  /** Ask for access (needs a user gesture in some browsers). */
  async enable(): Promise<MidiEnableResult> {
    if (this.#request === null) return 'unsupported';
    if (this.#access !== null) return 'ready';
    try {
      this.#access = await this.#request();
    } catch {
      return 'denied';
    }
    this.#access.addEventListener('statechange', () => this.onOutputsChange?.(this.outputs()));
    return 'ready';
  }

  outputs(): MidiPortInfo[] {
    const list: MidiPortInfo[] = [];
    this.#access?.outputs.forEach((o) => {
      if (o.state !== 'disconnected') list.push({ id: o.id, name: o.name ?? o.id });
    });
    return list;
  }

  select(id: string | null): void {
    if (id !== this.#outputId) this.allNotesOff();
    this.#outputId = id;
  }

  get selected(): string | null {
    return this.#output() === null ? null : this.#outputId;
  }

  /** Note on at `time`, note off `durationMs` later (DOMHighResTimeStamp, performance.now clock). */
  playChord(notes: readonly number[], time: number, durationMs: number): void {
    const out = this.#output();
    if (out === null) return;
    const on = NOTE_ON | this.channel;
    const off = NOTE_OFF | this.channel;
    for (const note of notes) {
      out.send([on, note, this.velocity], time);
      this.#sounding.add(note);
    }
    for (const note of notes) out.send([off, note, 0], time + durationMs);
  }

  /** Drop pending messages, release every note we sent and send All Notes Off (CC 123). */
  allNotesOff(): void {
    const out = this.#output();
    if (out === null) return;
    try {
      out.clear?.();
    } catch {
      // clear() is optional in the spec
    }
    for (const note of this.#sounding) out.send([NOTE_OFF | this.channel, note, 0]);
    this.#sounding.clear();
    out.send([CONTROL_CHANGE | this.channel, ALL_SOUND_OFF, 0]);
    out.send([CONTROL_CHANGE | this.channel, ALL_NOTES_OFF, 0]);
  }

  #output(): MidiOutputLike | null {
    if (this.#outputId === null || this.#access === null) return null;
    let found: MidiOutputLike | null = null;
    this.#access.outputs.forEach((o) => {
      if (o.id === this.#outputId && o.state !== 'disconnected') found = o;
    });
    return found;
  }
}
