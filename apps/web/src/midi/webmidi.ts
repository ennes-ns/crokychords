/** Web MIDI output: device list, notes per channel with timestamps, all-notes-off. */
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
  /** Notes sent per channel since the last all-notes-off, so Stop can release them explicitly. */
  #sounding = new Map<number, Set<number>>();

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

  /** Switch ports; the old port gets an all-notes-off on every channel we played on. */
  select(id: string | null): void {
    if (id !== this.#outputId) this.allNotesOff();
    this.#outputId = id;
  }

  get selected(): string | null {
    return this.#output() === null ? null : this.#outputId;
  }

  /** Channels (0-15) that received note-ons since the last all-notes-off, ascending. */
  get usedChannels(): number[] {
    return [...this.#sounding.keys()].sort((a, b) => a - b);
  }

  /**
   * Note on at `time`, note off `durationMs` later (DOMHighResTimeStamp, performance.now
   * clock), on MIDI channel `channel` (0-15) with `velocity` (1-127).
   */
  playNote(
    channel: number,
    note: number,
    velocity: number,
    time: number,
    durationMs: number,
  ): void {
    const out = this.#output();
    if (out === null) return;
    const ch = channel & 0x0f;
    out.send([NOTE_ON | ch, note & 0x7f, Math.min(127, Math.max(1, Math.round(velocity)))], time);
    out.send([NOTE_OFF | ch, note & 0x7f, 0], time + durationMs);
    let notes = this.#sounding.get(ch);
    if (notes === undefined) {
      notes = new Set();
      this.#sounding.set(ch, notes);
    }
    notes.add(note & 0x7f);
  }

  /**
   * Silence one channel now without dropping other pending messages (a track changed channel
   * or was muted while playing): note-offs for the notes we sent there, All Sound Off (CC 120)
   * and All Notes Off (CC 123).
   */
  channelOff(channel: number): void {
    const out = this.#output();
    if (out === null) return;
    this.#channelOff(out, channel & 0x0f);
  }

  /**
   * Loop wrap at `time` (DOMHighResTimeStamp): without dropping pending messages, release the
   * notes we sent and send All Notes Off (CC 123) on those channels plus `channels`, timestamped
   * so they land before the notes of the next pass (sent after this, at the same time).
   */
  notesOffAt(channels: Iterable<number>, time: number): void {
    const out = this.#output();
    if (out === null) return;
    const all = new Set([...this.#sounding.keys(), ...[...channels].map((c) => c & 0x0f)]);
    for (const ch of [...all].sort((a, b) => a - b)) {
      for (const note of this.#sounding.get(ch) ?? []) out.send([NOTE_OFF | ch, note, 0], time);
      out.send([CONTROL_CHANGE | ch, ALL_NOTES_OFF, 0], time);
    }
    this.#sounding.clear();
  }

  /**
   * Stop: drop pending messages, then on every channel we sent notes on plus `channels` (the
   * song's track channels) release our notes and send CC 120 and CC 123.
   */
  allNotesOff(channels: Iterable<number> = []): void {
    const out = this.#output();
    if (out === null) {
      this.#sounding.clear();
      return;
    }
    try {
      out.clear?.();
    } catch {
      // clear() is optional in the spec
    }
    const all = new Set([...this.#sounding.keys(), ...[...channels].map((c) => c & 0x0f)]);
    for (const ch of [...all].sort((a, b) => a - b)) this.#channelOff(out, ch);
    this.#sounding.clear();
  }

  #channelOff(out: MidiOutputLike, ch: number): void {
    for (const note of this.#sounding.get(ch) ?? []) out.send([NOTE_OFF | ch, note, 0]);
    this.#sounding.delete(ch);
    out.send([CONTROL_CHANGE | ch, ALL_SOUND_OFF, 0]);
    out.send([CONTROL_CHANGE | ch, ALL_NOTES_OFF, 0]);
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
