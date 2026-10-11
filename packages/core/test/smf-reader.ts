/**
 * Tiny Standard MIDI File reader, used only by the tests to check what songToMidi writes.
 * Rejects running status on purpose: the writer must emit a status byte for every event.
 */

export interface SmfEvent {
  /** Absolute tick. */
  tick: number;
  /** Delta ticks as stored in the file. */
  delta: number;
  /** Status byte (0xff for meta). */
  status: number;
  /** Meta type for meta events. */
  metaType?: number;
  data: number[];
}

export interface SmfTrack {
  /** Declared byte length of the track chunk. */
  length: number;
  events: SmfEvent[];
}

export interface Smf {
  format: number;
  trackCount: number;
  ppq: number;
  /** Declared byte length of the first track chunk. */
  trackLength: number;
  /** Events of the first track. */
  events: SmfEvent[];
  /** Every track chunk, in file order. */
  tracks: SmfTrack[];
}

class Reader {
  pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.pos];
    if (b === undefined) throw new Error(`Unexpected end of data at ${this.pos}`);
    this.pos += 1;
    return b;
  }

  take(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.byte());
    return out;
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.take(n));
  }

  uint(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.byte();
    return v;
  }

  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('VLQ longer than 4 bytes');
  }
}

function readTrack(r: Reader): SmfTrack {
  if (r.ascii(4) !== 'MTrk') throw new Error('Missing MTrk');
  const length = r.uint(4);
  const end = r.pos + length;
  const events: SmfEvent[] = [];
  let tick = 0;
  while (r.pos < end) {
    const delta = r.vlq();
    tick += delta;
    const status = r.byte();
    if (status < 0x80) throw new Error(`Running status at byte ${r.pos - 1}`);
    if (status === 0xff) {
      const metaType = r.byte();
      const data = r.take(r.vlq());
      events.push({ tick, delta, status, metaType, data });
      if (metaType === 0x2f) break;
    } else if (status === 0xf0 || status === 0xf7) {
      events.push({ tick, delta, status, data: r.take(r.vlq()) });
    } else {
      const kind = status & 0xf0;
      const size = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      events.push({ tick, delta, status, data: r.take(size) });
    }
  }
  if (r.pos !== end) throw new Error('Track length mismatch');
  const last = events[events.length - 1];
  if (last?.metaType !== 0x2f) throw new Error('Track does not end with End of Track');
  return { length, events };
}

/** Read a format 0 or format 1 file; every declared track chunk must be present and exact. */
export function readSmf(bytes: Uint8Array): Smf {
  const r = new Reader(bytes);
  if (r.ascii(4) !== 'MThd') throw new Error('Missing MThd');
  if (r.uint(4) !== 6) throw new Error('Header length must be 6');
  const format = r.uint(2);
  const trackCount = r.uint(2);
  const ppq = r.uint(2);
  if (format === 0 && trackCount !== 1) throw new Error('Format 0 must have one track');
  const tracks: SmfTrack[] = [];
  for (let i = 0; i < trackCount; i++) tracks.push(readTrack(r));
  if (r.pos !== bytes.length) throw new Error('Trailing bytes after the last track');
  const first = tracks[0];
  if (first === undefined) throw new Error('No tracks');
  return { format, trackCount, ppq, trackLength: first.length, events: first.events, tracks };
}

/** Decode a VLQ from a byte array (exported for testing the writer's encoder). */
export function decodeVlq(bytes: readonly number[]): number {
  return new Reader(Uint8Array.from(bytes)).vlq();
}
