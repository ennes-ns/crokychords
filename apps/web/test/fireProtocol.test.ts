import { describe, expect, it } from 'vitest';
import {
  BTN_SHIFT,
  ENC_SELECT,
  ENC_VOLUME,
  allLedsOff,
  blankFrame,
  decodeInput,
  hueRgb,
  ledCc,
  oledSysex,
  padFromNote,
  padNote,
  padsSysex,
  relative,
  titleFrame,
} from '../src/midi/fire/protocol';
import reference from './fixtures/fire-reference.json';

// Fixtures come from tools/fire/fire.py via test/fixtures/fire_reference.py.

describe('Fire protocol vs the Python reference', () => {
  it('pad SysEx matches byte for byte', () => {
    expect(padsSysex([{ index: 0, rgb: [127, 0, 0] }])).toEqual(reference.padsSingle);
    expect(
      padsSysex([
        { index: 5, rgb: [1, 2, 3] },
        { index: 63, rgb: [127, 64, 0] },
        { index: 17, rgb: [0, 0, 127] },
      ]),
    ).toEqual(reference.padsMixed);
    const allOff = padsSysex(Array.from({ length: 64 }, (_, index) => ({ index, rgb: [0, 0, 0] })));
    expect(allOff).toEqual(reference.padsAllOff);
    expect(allOff).toHaveLength(264);
  });

  it('hue to 7-bit RGB matches for every degree hue, brightness and saturation', () => {
    for (const { hue, light, sat, rgb } of reference.hueRgb) {
      expect([hue, light, sat, hueRgb(hue, light, sat)]).toEqual([hue, light, sat, rgb]);
    }
  });

  it('OLED SysEx matches for a blank frame and a pattern', () => {
    expect(oledSysex(blankFrame())).toEqual(reference.oledBlank);
    const frame = blankFrame();
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const lit = (x * 7 + y * 3) % 5 === 0 || x === y || y === 63 - Math.floor(x / 2);
        if (lit) frame[y * 128 + x] = 1;
      }
    }
    const sysex = oledSysex(frame);
    expect(sysex).toHaveLength(1183);
    expect(sysex).toEqual(reference.oledPattern);
  });

  it('pad notes and relative encoder values match', () => {
    for (const [key, note] of Object.entries(reference.padNotes)) {
      const [row, col] = key.split(',').map(Number);
      expect(padNote(row ?? -1, col ?? -1)).toBe(note);
      expect(padFromNote(note)).toEqual({ row, col });
    }
    for (const [value, delta] of Object.entries(reference.relative)) {
      expect(relative(Number(value))).toBe(delta);
    }
  });
});

describe('Fire protocol', () => {
  it('encodes LED CCs and all-off', () => {
    expect(ledCc(0x33, 2)).toEqual([0xb0, 0x33, 2]);
    expect(allLedsOff()).toEqual([0xb0, 0x7f, 0]);
  });

  it('decodes pads, buttons and encoders', () => {
    expect(decodeInput([0x90, 0x36, 0x7f])).toEqual({ type: 'pad', row: 0, col: 0, down: true });
    expect(decodeInput([0x80, 0x75, 0])).toEqual({ type: 'pad', row: 3, col: 15, down: false });
    expect(decodeInput([0x90, 0x36 + 16 + 3, 0])).toEqual({
      type: 'pad',
      row: 1,
      col: 3,
      down: false,
    });
    expect(decodeInput([0x90, BTN_SHIFT, 0x7f])).toEqual({
      type: 'button',
      note: BTN_SHIFT,
      down: true,
    });
    expect(decodeInput([0x90, ENC_VOLUME, 0x7f])).toEqual({
      type: 'button',
      note: ENC_VOLUME,
      down: true,
    });
    expect(decodeInput([0xb0, ENC_SELECT, 0x7f])).toEqual({
      type: 'turn',
      encoder: ENC_SELECT,
      delta: -1,
    });
    expect(decodeInput([0xb0, ENC_VOLUME, 0x01])).toEqual({
      type: 'turn',
      encoder: ENC_VOLUME,
      delta: 1,
    });
    expect(decodeInput([0xf8])).toBeNull();
    expect(decodeInput([0xe0, 0, 64])).toBeNull();
  });

  it('draws the static title on the OLED', () => {
    const frame = titleFrame();
    const lit = frame.reduce((n, p) => n + p, 0);
    expect(lit).toBeGreaterThan(300);
    // Nothing in the outer rows: the title is centred.
    expect(frame.slice(0, 128 * 5).every((p) => p === 0)).toBe(true);
    expect(oledSysex(frame)).toHaveLength(1183);
  });
});
