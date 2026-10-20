/**
 * Akai Fire protocol: pure encoders (pad SysEx, button LED CCs, OLED bitmap) and the input
 * decoder. A 1:1 port of `tools/fire/fire.py`; byte fixtures in apps/web/test/fixtures keep the
 * two in step. Protocol notes and sources: docs/specs/akai-fire-v1.md, section 1.
 */

/** Substring of the Web MIDI port name ("FL STUDIO FIRE", "FL STUDIO FIRE Jack 1", …). */
export const PORT_MATCH = 'FIRE';

export const SYSEX_HEADER = [0xf0, 0x47, 0x7f, 0x43] as const; // Akai, all-call, Fire
export const CMD_PADS = 0x65;
export const CMD_OLED = 0x0e;

export const ROWS = 4;
export const COLS = 16;
export const PAD_COUNT = ROWS * COLS;
/** Note of the top-left pad; note = PAD_NOTE_FIRST + row * 16 + col. */
export const PAD_NOTE_FIRST = 0x36;

// Encoders: turning sends a relative CC, touching sends note on/off on the same number.
export const ENC_VOLUME = 0x10;
export const ENC_PAN = 0x11;
export const ENC_FILTER = 0x12;
export const ENC_RESONANCE = 0x13;
export const ENC_SELECT = 0x76;

// Buttons: note on (0x7F) on press, note off on release. Their LEDs are CCs on the same number.
export const BTN_SELECT_PRESS = 0x19;
export const BTN_BANK = 0x1a;
export const BTN_PAT_UP = 0x1f;
export const BTN_PAT_DOWN = 0x20;
export const BTN_BROWSER = 0x21;
export const BTN_GRID_LEFT = 0x22;
export const BTN_GRID_RIGHT = 0x23;
export const BTN_SOLO = [0x24, 0x25, 0x26, 0x27] as const;
export const BTN_STEP = 0x2c;
export const BTN_NOTE = 0x2d;
export const BTN_DRUM = 0x2e;
export const BTN_PERFORM = 0x2f;
export const BTN_SHIFT = 0x30;
export const BTN_ALT = 0x31;
export const BTN_PATTERN = 0x32;
export const BTN_PLAY = 0x33;
export const BTN_STOP = 0x34;
export const BTN_REC = 0x35;

/** Rectangular LEDs between the SOLO buttons and the pads: 0 off, 1/3 red, 2/4 green. */
export const LED_ROW = [0x28, 0x29, 0x2a, 0x2b] as const;
export const ROW_LED_OFF = 0;
export const ROW_LED_DULL_RED = 1;
export const ROW_LED_DULL_GREEN = 2;
export const ROW_LED_RED = 3;
export const ROW_LED_GREEN = 4;
/** The four LEDs next to BANK (CHANNEL, MIXER, USER 1, USER 2): CC 0x1B, value 0x10 | mask. */
export const CC_BANK_LEDS = 0x1b;
/** CC 0x7F value 0: every LED off (pads and buttons). */
export const CC_ALL_OFF = 0x7f;

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;

/** 7-bit pad colour. */
export type Rgb = readonly [number, number, number];
export const BLACK: Rgb = [0, 0, 0];

export function padNote(row: number, col: number): number {
  return PAD_NOTE_FIRST + row * COLS + col;
}

export function padIndex(row: number, col: number): number {
  return row * COLS + col;
}

export function padFromNote(note: number): { row: number; col: number } | null {
  const i = note - PAD_NOTE_FIRST;
  if (i < 0 || i >= PAD_COUNT) return null;
  return { row: Math.floor(i / COLS), col: i % COLS };
}

/** Relative encoder value (7-bit two's complement): 1..63 clockwise, 127..64 counter-clockwise. */
export function relative(value: number): number {
  return value >= 64 ? value - 128 : value;
}

function len14(n: number): [number, number] {
  return [(n >> 7) & 0x7f, n & 0x7f];
}

/** One pad colour: pad index 0..63 (row * 16 + col) and 7-bit channels. */
export interface PadColor {
  index: number;
  rgb: Rgb;
}

/** SysEx that sets any subset of pads (all 64 = one 263-byte message). */
export function padsSysex(pads: Iterable<PadColor>): number[] {
  const body: number[] = [];
  for (const { index, rgb } of pads) {
    body.push(index & 0x3f, rgb[0] & 0x7f, rgb[1] & 0x7f, rgb[2] & 0x7f);
  }
  return [...SYSEX_HEADER, CMD_PADS, ...len14(body.length), ...body, 0xf7];
}

/** Button or row LED: CC on the button's own number. */
export function ledCc(number: number, value: number): number[] {
  return [CONTROL_CHANGE, number & 0x7f, value & 0x7f];
}

/** BANK LEDs: bit 0 = LED 1 (CHANNEL) … bit 3 = LED 4 (USER 2). */
export function bankLeds(mask: number): number[] {
  return ledCc(CC_BANK_LEDS, 0x10 | (mask & 0x0f));
}

export function allLedsOff(): number[] {
  return ledCc(CC_ALL_OFF, 0);
}

/** Python's round(): halves go to the even neighbour (keeps colours identical to fire.py). */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** colorsys.hsv_to_rgb with h, s, v in 0..1. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v, v, v];
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Hue in degrees to 7-bit pad RGB; `light` 0..1 scales brightness, `sat` 0..1 whitens. */
export function hueRgb(hue: number, light = 1, sat = 1): Rgb {
  const h = (((hue % 360) + 360) % 360) / 360;
  const [r, g, b] = hsvToRgb(h, sat, 1);
  const scale = (c: number): number => roundHalfEven(c * 127 * light);
  return [scale(r), scale(g), scale(b)];
}

// --- OLED: 128x64, 8 bands of 8 rows, 7 pixels per byte in a shuffled bit order -------------

export const OLED_W = 128;
export const OLED_H = 64;
const OLED_BYTES = 1171; // ceil(128 * 64 / 7)
const BIT_MUTATE: readonly (readonly number[])[] = [
  [13, 19, 25, 31, 37, 43, 49],
  [0, 20, 26, 32, 38, 44, 50],
  [1, 7, 27, 33, 39, 45, 51],
  [2, 8, 14, 34, 40, 46, 52],
  [3, 9, 15, 21, 41, 47, 53],
  [4, 10, 16, 22, 28, 48, 54],
  [5, 11, 17, 23, 29, 35, 55],
  [6, 12, 18, 24, 30, 36, 42],
];

/** A 128x64 frame, row-major: `pixels[y * 128 + x]` truthy = lit. */
export type OledFrame = Uint8Array;

export function blankFrame(): OledFrame {
  return new Uint8Array(OLED_W * OLED_H);
}

/**
 * SysEx that writes a full OLED frame (1183 bytes): bands 0-7, columns 0-127. Only full frames
 * are sent: partial-band updates did not display on the device (spec, "v2 as built").
 */
export function oledSysex(pixels: OledFrame): number[] {
  const data = new Array<number>(OLED_BYTES).fill(0);
  for (let y = 0; y < OLED_H; y++) {
    const mutate = BIT_MUTATE[y % 8] ?? [];
    for (let x = 0; x < OLED_W; x++) {
      if (!pixels[y * OLED_W + x]) continue;
      const col = x + OLED_W * Math.floor(y / 8);
      const bit = mutate[col % 7] ?? 0;
      const at = Math.floor(col / 7) * 8 + Math.floor(bit / 7);
      data[at] = (data[at] ?? 0) | (1 << (bit % 7));
    }
  }
  const payload = [0x00, 0x07, 0x00, 0x7f, ...data]; // bands 0..7, columns 0..127
  return [...SYSEX_HEADER, CMD_OLED, ...len14(payload.length), ...payload, 0xf7];
}

// --- Input -------------------------------------------------------------------------------------

export type FireEvent =
  | { type: 'pad'; row: number; col: number; down: boolean }
  | { type: 'button'; note: number; down: boolean }
  | { type: 'turn'; encoder: number; delta: number };

/** Decode one incoming MIDI message (channel 1); null for anything the Fire does not send. */
export function decodeInput(data: ArrayLike<number>): FireEvent | null {
  const status = data[0];
  const a = data[1];
  const b = data[2] ?? 0;
  if (status === undefined || a === undefined) return null;
  const kind = status & 0xf0;
  if (kind === NOTE_ON || kind === NOTE_OFF) {
    const down = kind === NOTE_ON && b > 0;
    const pad = padFromNote(a);
    return pad === null ? { type: 'button', note: a, down } : { type: 'pad', ...pad, down };
  }
  if (kind === CONTROL_CHANGE) {
    const delta = relative(b);
    return delta === 0 ? null : { type: 'turn', encoder: a, delta };
  }
  return null;
}
