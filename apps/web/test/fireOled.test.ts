import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { drawText, oledModel, oledUpdate, renderOled, sameFrame } from '../src/midi/fire/oled';
import type { OledFrame } from '../src/midi/fire/protocol';
import { ENC_PAN, ENC_RESONANCE, ENC_VOLUME, blankFrame } from '../src/midi/fire/protocol';
import { initialState } from '../src/state';
import type { AppState } from '../src/state';
import type { SuggestionItem } from '../src/views/suggest';

function state(tokens: [string, number][], patch: Partial<AppState> = {}): AppState {
  const song = createSong({ chords: tokens.map(([token, beats]) => ({ token, beats })) });
  return { ...initialState(song), ...patch };
}

const POP: [string, number][] = [
  ['I', 4],
  ['V', 4],
  ['vi', 4],
  ['IV', 4],
];

const suggestions: SuggestionItem[] = [
  { token: 'IV', name: 'F', probability: 0.39, count: 39 },
  { token: 'V', name: 'G', probability: 0.21, count: 21 },
  { token: 'ii', name: 'Dm', probability: 0.14, count: 14 },
  { token: 'bVII', name: 'Bb', probability: 0.06, count: 6 },
];

/** A frame as 64 lines of '#' and '.', for the golden files. */
function ascii(frame: OledFrame): string {
  const lines: string[] = [];
  for (let y = 0; y < 64; y++) {
    let line = '';
    for (let x = 0; x < 128; x++) line += frame[y * 128 + x] ? '#' : '.';
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

const golden = (name: string) => `./fixtures/fire-oled/${name}.txt`;

describe('Fire OLED model', () => {
  it('shows the selected chord, its position and the suggestions around the cursor', () => {
    const s = state(POP, { selected: 1, fire: { ...initialState().fire, cursor: 2 } });
    const model = oledModel(s, suggestions, null);
    expect(model).toMatchObject({
      mode: 'replace',
      position: '2:1',
      roman: 'V',
      name: 'G',
      detail: '4 beats',
      cursorRow: 1,
      knob: null,
    });
    expect(model.suggestions.map((x) => `${x.token} ${x.percent}`)).toEqual([
      'V 21%',
      'ii 14%',
      'bVII 6%',
    ]);
  });

  it('follows the playhead while playing and shows the "+" slot', () => {
    const s = state(POP, { playing: true, cursor: 9.5, loop: true });
    const model = oledModel(s, [], null);
    expect(model).toMatchObject({ position: '3:2', roman: '+', detail: '4 chords' });
    expect(model.cursorRow).toBeNull();
  });

  it('shows the touched knob', () => {
    const s = state([['V7/1', 2.5]], { selected: 0 });
    expect(oledModel(s, [], ENC_VOLUME).knob).toEqual({
      label: 'Length',
      value: '2.5',
      unit: 'beats',
    });
    expect(oledModel(s, [], ENC_PAN).knob).toMatchObject({ label: 'Inversion', value: '1st' });
    expect(oledModel(s, [], ENC_RESONANCE).knob).toEqual({
      label: 'Tempo',
      value: '120',
      unit: 'BPM',
    });
  });
});

describe('Fire OLED frames (golden)', () => {
  it('Replace mode, chord selected, stopped', async () => {
    const s = state(POP, { selected: 2, fire: { ...initialState().fire, cursor: 0 } });
    await expect(ascii(renderOled(oledModel(s, suggestions, null)))).toMatchFileSnapshot(
      golden('replace-selected'),
    );
  });

  it('Add mode on the "+" slot, playing and looping', async () => {
    const s = state(POP, {
      playing: true,
      loop: true,
      cursor: 13,
      fire: { ...initialState().fire, mode: 'add', cursor: 3 },
    });
    await expect(ascii(renderOled(oledModel(s, suggestions, null)))).toMatchFileSnapshot(
      golden('add-playing'),
    );
  });

  it('knob touched: tempo in big digits', async () => {
    const s = state(POP, { selected: 0 });
    await expect(ascii(renderOled(oledModel(s, suggestions, ENC_RESONANCE)))).toMatchFileSnapshot(
      golden('knob-tempo'),
    );
  });

  it('knob touched: inversion', async () => {
    const s = state([['V7/1', 4]], { selected: 0 });
    await expect(ascii(renderOled(oledModel(s, suggestions, ENC_PAN)))).toMatchFileSnapshot(
      golden('knob-inversion'),
    );
  });
});

describe('Fire OLED updates', () => {
  it('sends one full frame when the frame changed, nothing when it did not', () => {
    const a = blankFrame();
    drawText(a, 'C', 0, 0);
    expect(oledUpdate(null, a)).toHaveLength(1183);
    const b = a.slice();
    expect(sameFrame(a, b)).toBe(true);
    expect(oledUpdate(a, b)).toBeNull();
    drawText(b, 'x', 60, 40);
    expect(sameFrame(a, b)).toBe(false);
    // Always the whole screen: partial-band updates do not display on the device.
    expect(oledUpdate(a, b)?.slice(7, 11)).toEqual([0x00, 0x07, 0x00, 0x7f]);
    expect(oledUpdate(a, b)).toHaveLength(1183);
  });
});
