import { createSong } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import type { SamplerBuffer } from '../src/audio/sampler';
import { SAMPLER_RATE, SamplerBank, Samplers } from '../src/audio/sampler';
import { SoundSettings } from '../src/audio/sound';
import { AudioEngine } from '../src/audio/synth';
import type { FireAccessLike, FireMessageEvent } from '../src/midi/fire/connect';
import { FireConnection } from '../src/midi/fire/connect';
import { FireController, LED_DRUM_ON, buttonLeds } from '../src/midi/fire/controller';
import type { OledFrame } from '../src/midi/fire/protocol';
import {
  BTN_BANK,
  BTN_DRUM,
  BTN_PATTERN,
  BTN_PLAY,
  BTN_SELECT_PRESS,
  BTN_SHIFT,
  BTN_SOLO,
  BTN_STEP,
  CC_BANK_LEDS,
  ENC_FILTER,
  ENC_PAN,
  ENC_RESONANCE,
  ENC_SELECT,
  ENC_VOLUME,
  hueRgb,
  oledSysex,
} from '../src/midi/fire/protocol';
import type { FireEvent } from '../src/midi/fire/protocol';
import type { FireCommunity } from '../src/midi/fire/sampleMode';
import {
  ACCENT_HUE,
  BRAND_HUE,
  SampleMode,
  editPatch,
  keyNote,
  noteDegree,
  renderSampleOled,
  sampleOledModel,
} from '../src/midi/fire/sampleMode';
import { degreeHue } from '../src/music';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import { MemorySampleStore } from '../src/store/samples';
import type { CommunitySample } from '../src/sync/community';
import { listed } from './fakeCommunity';

const RATE = SAMPLER_RATE;
const FRAMES = RATE / 2;

function buffer(length: number): SamplerBuffer {
  const data = new Float32Array(length);
  return {
    numberOfChannels: 1,
    length,
    sampleRate: RATE,
    duration: length / RATE,
    getChannelData: () => data,
  };
}

/** Half a second of a 440 Hz sine that decays (the waveform strip has a shape). */
function tone(): SamplerBuffer {
  const b = buffer(FRAMES);
  const d = b.getChannelData(0);
  for (let i = 0; i < FRAMES; i++) {
    d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) * Math.exp((-3 * i) / FRAMES);
  }
  return b;
}

function fakeCommunity(samples: CommunitySample[]) {
  const take = vi.fn(() => Promise.resolve());
  const bytes = vi.fn(() => Promise.resolve(new ArrayBuffer(8)));
  const community: FireCommunity = {
    client: { browse: () => Promise.resolve({ samples, next: null }), bytes },
    take,
  };
  return { community, take, bytes };
}

async function setup(options: { community?: FireCommunity | null; load?: boolean } = {}) {
  const song = createSong({ chords: ['I', 'V'].map((token) => ({ token, beats: 4 })) });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  let stamp = 0;
  const bank = new SamplerBank({
    decode: () => Promise.resolve(tone()),
    create: (_c, length) => buffer(length),
    now: () => `t${++stamp}`,
  });
  const release = vi.fn();
  const audition = vi.fn((..._args: unknown[]) => ({ release }));
  const play = vi.fn((..._args: unknown[]) => ({ release }));
  const samplers = new Samplers(new SoundSettings(), bank, audition, play);
  await samplers.attach(new MemorySampleStore());
  if (options.load !== false) {
    await samplers.load('sampler-1', new File([new Uint8Array(32)], 'tone.wav'));
  }
  const mode = new SampleMode(samplers, options.community ?? null);
  const fire = new FireController(store, actions, undefined, mode);
  const send = (...events: FireEvent[]) => events.forEach((e) => fire.handle(e));
  const patch = () => samplers.patch(mode.id);
  return { store, actions, samplers, mode, fire, send, patch, audition, play, release };
}

const pad = (row: number, col: number, down = true): FireEvent => ({ type: 'pad', row, col, down });
const tap = (row: number, col: number): FireEvent[] => [pad(row, col), pad(row, col, false)];
const btn = (note: number, down = true): FireEvent => ({ type: 'button', note, down });
const press = (note: number): FireEvent[] => [btn(note), btn(note, false)];
const turn = (encoder: number, delta: number): FireEvent => ({ type: 'turn', encoder, delta });
/** Touch a knob, turn it `delta` detents one at a time, let go: one undo step. */
const knob = (encoder: number, delta: number): FireEvent[] => [
  btn(encoder),
  ...Array.from({ length: Math.abs(delta) }, () => turn(encoder, Math.sign(delta))),
  btn(encoder, false),
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SAMPLE mode: enter and leave', () => {
  it('DRUM enters, DRUM or STEP leaves; the LEDs follow', async () => {
    const { send, mode, fire, store } = await setup();
    const leds = () => buttonLeds(store.state, fire);
    expect(leds().get(BTN_DRUM)).toBe(0);
    send(...press(BTN_DRUM));
    expect(mode.active).toBe(true);
    expect(leds().get(BTN_DRUM)).toBe(LED_DRUM_ON);
    expect(leds().get(BTN_STEP)).toBe(1);
    expect(leds().get(CC_BANK_LEDS)).toBe(0x11); // page 1
    send(...press(BTN_DRUM));
    expect(mode.active).toBe(false);
    expect(leds().get(BTN_STEP)).toBe(2);
    send(...press(BTN_DRUM), ...press(BTN_STEP));
    expect(mode.active).toBe(false);
  });

  it('pads and knobs edit the sampler, not the song, while it is on', async () => {
    const { send, store } = await setup();
    const song = store.state.song;
    send(...press(BTN_DRUM), ...tap(0, 4), ...knob(ENC_RESONANCE, 3), ...press(BTN_PATTERN));
    expect(store.state.song).toBe(song);
    expect(store.state.selected).toBeNull();
  });

  it('PLAY still plays the song so edits are heard in context', async () => {
    const { send, actions, mode } = await setup();
    const toggle = vi.spyOn(actions, 'togglePlay');
    send(...press(BTN_DRUM), ...press(BTN_PLAY));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(mode.active).toBe(true);
  });
});

describe('SAMPLE mode: pads', () => {
  it('row 1 pads 1-8 select a slot without playing it', async () => {
    const { send, mode, audition } = await setup();
    send(...press(BTN_DRUM), ...tap(0, 2));
    expect(mode.slot).toBe(2);
    expect(mode.id).toBe('sampler-3');
    expect(audition).not.toHaveBeenCalled();
  });

  it('the keyboard plays the slot around its root through the selected track, until let go', async () => {
    const { send, audition, release, store } = await setup();
    send(...press(BTN_DRUM), pad(2, 8));
    expect(audition).toHaveBeenLastCalledWith('sampler-1', 69, 100, undefined); // the root
    send(pad(2, 8, false));
    expect(release).toHaveBeenCalledTimes(1);
    // SHIFT + SOLO 1 selects track 1: auditions play on its bus.
    send(btn(BTN_SHIFT), ...press(BTN_SOLO[0]), btn(BTN_SHIFT, false));
    const track = store.state.song.tracks?.[0]?.id;
    send(...tap(3, 0), ...tap(1, 15));
    expect(audition.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      [69, undefined],
      [69 - 24, track],
      [69 + 23, track],
    ]);
  });

  it('keyNote: 48 chromatic keys, lowest on the bottom row, root on row 3 pad 9', () => {
    expect(keyNote(60, 2, 8)).toBe(60);
    expect(keyNote(60, 3, 0)).toBe(36);
    expect(keyNote(60, 1, 15)).toBe(83);
    expect(keyNote(10, 3, 0)).toBeNull(); // below MIDI 0
    expect(keyNote(60, 0, 0)).toBeNull(); // the slot row
  });

  it('pad colours: slots in the accent (bright = selected), root in its degree hue, held keys white', async () => {
    const { send, mode, store } = await setup();
    send(...press(BTN_DRUM));
    const key = { tonic: 0 as const, mode: 'major' as const };
    let pads = mode.pads(key);
    expect(pads[0]).toEqual(hueRgb(ACCENT_HUE, 1)); // slot 1: sample, selected
    expect(pads[1]).toEqual([0, 0, 0]); // slot 2: empty
    // Root A4 (69) is degree 6 in C major.
    expect(noteDegree(key, 69)).toBe(6);
    expect(pads[2 * 16 + 8]).toEqual(hueRgb(degreeHue(6), 1));
    expect(pads[3 * 16 + 12]).toEqual(hueRgb(degreeHue(6), 0.3)); // an octave down
    expect(pads.slice(8, 16).every((rgb) => rgb.every((c) => c === 0))).toBe(true);
    send(...tap(0, 1));
    pads = mode.pads(key);
    expect(pads[0]).toEqual(hueRgb(ACCENT_HUE, 0.25));
    expect(pads[1]).toEqual([30, 30, 30]); // selected, but empty
    send(pad(2, 0));
    expect(mode.pads(key)[2 * 16]).toEqual([127, 127, 127]);
    expect(store.state.song.chords).toHaveLength(2);
  });

  it('pads 9-16 show the newest community samples: hold to listen, SHIFT + tap adds to the slot', async () => {
    const samples = Array.from({ length: 10 }, (_, i) => listed(`s${i}`, { root: 50 + i }));
    const fake = fakeCommunity(samples);
    const { send, mode, play, release } = await setup({ community: fake.community });
    send(...press(BTN_DRUM));
    await settle();
    expect(mode.recent.map((s) => s.name)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
    ]);
    const key = { tonic: 0 as const, mode: 'major' as const };
    expect(mode.pads(key)[8]).toEqual(hueRgb(BRAND_HUE, 0.25));
    send(pad(0, 9));
    expect(mode.pads(key)[9]).toEqual(hueRgb(BRAND_HUE, 1));
    await settle();
    await settle();
    expect(fake.bytes).toHaveBeenCalledWith(samples[1]?.id);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0]?.[1]).toBe(51); // the sample's root
    send(pad(0, 9, false));
    expect(release).toHaveBeenCalledTimes(1);
    send(...tap(0, 1), btn(BTN_SHIFT), ...tap(0, 10), btn(BTN_SHIFT, false));
    expect(fake.take).toHaveBeenCalledWith('sampler-2', samples[2]);
    await settle();
    expect(mode.oled(false).info).toBe('added to slot 2');
    expect(play).toHaveBeenCalledTimes(1); // adding never plays
  });

  it('without the community bank pads 9-16 stay dark and do nothing', async () => {
    const { send, mode, play } = await setup();
    send(...press(BTN_DRUM), ...tap(0, 12));
    expect(play).not.toHaveBeenCalled();
    const pads = mode.pads({ tonic: 0, mode: 'major' });
    expect(pads.slice(8, 16).every((rgb) => rgb.every((c) => c === 0))).toBe(true);
  });
});

describe('SAMPLE mode: knob pages', () => {
  it('BANK cycles the four pages, SHIFT + BANK goes back; the BANK LEDs show the page', async () => {
    const { send, mode, store, fire } = await setup();
    send(...press(BTN_DRUM));
    const pages: number[] = [];
    for (let i = 0; i < 4; i++) {
      pages.push(mode.page);
      send(...press(BTN_BANK));
    }
    expect(pages).toEqual([0, 1, 2, 3]);
    expect(mode.page).toBe(0);
    send(btn(BTN_SHIFT), ...press(BTN_BANK), btn(BTN_SHIFT, false));
    expect(mode.page).toBe(3);
    expect(buttonLeds(store.state, fire).get(CC_BANK_LEDS)).toBe(0x18);
    expect(store.state.fire.mode).toBe('replace'); // BANK does not touch Replace / Add here
  });

  it('page 1 Pitch: gain, root (SELECT press detects), keytrack, fine tune; SHIFT is fine', async () => {
    const { send, patch } = await setup();
    send(...press(BTN_DRUM), ...knob(ENC_VOLUME, 2));
    expect(patch().gain).toBe(2);
    send(btn(BTN_SHIFT), ...knob(ENC_VOLUME, -3), btn(BTN_SHIFT, false));
    expect(patch().gain).toBeCloseTo(1.7);
    send(...knob(ENC_PAN, -9));
    expect(patch().root).toBe(60);
    send(...press(BTN_SELECT_PRESS));
    expect(patch().root).toBe(69);
    send(...knob(ENC_FILTER, -2));
    expect(patch().keytrack).toBe(90);
    send(
      ...knob(ENC_RESONANCE, 3),
      btn(BTN_SHIFT),
      ...knob(ENC_RESONANCE, -1),
      btn(BTN_SHIFT, false),
    );
    expect(patch().tune).toBe(14);
    send(...knob(ENC_RESONANCE, 20));
    expect(patch().tune).toBe(50);
  });

  it('page 2 Loop: start, loop start, loop end, crossfade; SELECT toggles loop, SHIFT + SELECT ping-pong', async () => {
    const { send, patch } = await setup();
    send(...press(BTN_DRUM), ...press(BTN_BANK));
    const step = Math.round(FRAMES / 128);
    const before = patch();
    send(...knob(ENC_VOLUME, 2), ...knob(ENC_PAN, -1), ...knob(ENC_FILTER, 1));
    send(...knob(ENC_RESONANCE, 2));
    expect(patch().start).toBe(2 * step);
    expect(patch().loop.start).toBe(before.loop.start - step);
    expect(patch().loop.end).toBe(before.loop.end + step);
    expect(patch().loop.crossfade).toBe(before.loop.crossfade + 2 * 240);
    send(btn(BTN_SHIFT), ...knob(ENC_VOLUME, -1), btn(BTN_SHIFT, false));
    expect(patch().start).toBe(2 * step - Math.round(FRAMES / 1024));
    expect(patch().loop.enabled).toBe(false);
    send(...press(BTN_SELECT_PRESS));
    expect(patch().loop.enabled).toBe(true);
    send(btn(BTN_SHIFT), ...press(BTN_SELECT_PRESS), btn(BTN_SHIFT, false));
    expect(patch().loop.mode).toBe('pingpong');
  });

  it('page 3 Envelope: A / D / S / R', async () => {
    const { send, patch } = await setup();
    send(...press(BTN_DRUM), ...press(BTN_BANK), ...press(BTN_BANK));
    send(...knob(ENC_VOLUME, 4), ...knob(ENC_PAN, -4), ...knob(ENC_FILTER, -2));
    send(...knob(ENC_RESONANCE, 8));
    expect(patch().envelope.attack).toBeCloseTo(0.004);
    expect(patch().envelope.decay).toBeCloseTo(0.15);
    expect(patch().envelope.sustain).toBeCloseTo(0.9);
    expect(patch().envelope.release).toBeCloseTo(0.32);
  });

  it('page 4 Filter: type on SELECT (and VOLUME), cutoff, resonance, env amount', async () => {
    const { send, patch } = await setup();
    send(...press(BTN_DRUM), btn(BTN_SHIFT), ...press(BTN_BANK), btn(BTN_SHIFT, false));
    send(turn(ENC_SELECT, 1));
    expect(patch().filter.type).toBe('highpass');
    send(...knob(ENC_VOLUME, 5));
    expect(patch().filter.type).toBe('bandpass');
    send(...knob(ENC_PAN, -6));
    expect(patch().filter.cutoff).toBeCloseTo(10000);
    send(...knob(ENC_FILTER, 4), ...knob(ENC_RESONANCE, -3));
    expect(patch().filter.resonance).toBe(20);
    expect(patch().filter.envAmount).toBe(-15);
  });

  it('SELECT turns pick the slot on the other pages', async () => {
    const { send, mode } = await setup();
    send(...press(BTN_DRUM), turn(ENC_SELECT, 1), turn(ENC_SELECT, 1));
    expect(mode.slot).toBe(2);
    send(...Array.from({ length: 5 }, () => turn(ENC_SELECT, -1)));
    expect(mode.slot).toBe(0);
  });

  it('Samplers.setPatch replaces the settings in one change, clamped, keeping the sample', async () => {
    const { samplers, patch } = await setup();
    const listener = vi.fn();
    samplers.subscribe(listener);
    const before = patch();
    samplers.setPatch('sampler-1', { ...before, sample: null, gain: 99, root: 40 });
    expect(patch()).toMatchObject({ sample: before.sample, gain: 12, root: 40 });
    expect(listener).toHaveBeenCalledTimes(1);
    samplers.setPatch('sampler-1', patch());
    expect(listener).toHaveBeenCalledTimes(1); // no change, no call
  });

  it('editPatch leaves positions alone without a sample', async () => {
    const { patch } = await setup({ load: false });
    const p = patch();
    expect(editPatch(p, 'loop', 0, 1, false)).toBe(p);
  });
});

describe('SAMPLE mode: undo', () => {
  it('every touch is one undo step: PATTERN undoes it, SHIFT + PATTERN redoes it', async () => {
    const { send, patch, mode, store } = await setup();
    send(...press(BTN_DRUM), ...knob(ENC_VOLUME, 3), ...knob(ENC_RESONANCE, 2));
    expect([patch().gain, patch().tune]).toEqual([3, 10]);
    send(...press(BTN_PATTERN));
    expect([patch().gain, patch().tune]).toEqual([3, 0]);
    send(...press(BTN_PATTERN));
    expect([patch().gain, patch().tune]).toEqual([0, 0]);
    expect(mode.canUndo).toBe(false);
    send(btn(BTN_SHIFT), ...press(BTN_PATTERN), btn(BTN_SHIFT, false));
    expect(patch().gain).toBe(3);
    // The song's undo is untouched.
    expect(store.history.past).toHaveLength(0);
  });

  it('turning without touching commits when another control is used', async () => {
    const { send, patch } = await setup();
    send(...press(BTN_DRUM), turn(ENC_VOLUME, 1), turn(ENC_VOLUME, 1), turn(ENC_PAN, 1));
    send(...press(BTN_PATTERN));
    expect([patch().gain, patch().root]).toEqual([2, 69]);
    send(...press(BTN_PATTERN));
    expect(patch().gain).toBe(0);
  });

  it('leaving the mode releases held notes', async () => {
    const { send, release } = await setup();
    send(...press(BTN_DRUM), pad(2, 3), pad(3, 3), ...press(BTN_DRUM));
    expect(release).toHaveBeenCalledTimes(2);
  });
});

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

describe('SAMPLE mode OLED', () => {
  it('model: page name, slot, the four parameters, the sample info', async () => {
    const { send, mode } = await setup();
    send(...press(BTN_DRUM), btn(ENC_PAN));
    const model = mode.oled(true);
    expect(model).toMatchObject({
      page: 'pitch',
      slot: 1,
      name: 'Sampler 1',
      playing: true,
      touched: 1,
      info: '0.50 s mono',
      strip: null,
    });
    expect(model.params.map((p) => `${p.label} ${p.value}`)).toEqual([
      'Gain +0.0 dB',
      'Root A4 69',
      'Keytrack 100%',
      'Tune +0 ct',
    ]);
  });

  it('golden: Pitch page with the root knob touched', async () => {
    const { send, mode } = await setup();
    send(...press(BTN_DRUM), ...knob(ENC_VOLUME, -3), btn(ENC_PAN));
    await expect(ascii(renderSampleOled(mode.oled(false)))).toMatchFileSnapshot(
      golden('sample-pitch'),
    );
  });

  it('golden: Loop page with the waveform strip, trim and loop markers', async () => {
    const { send, mode } = await setup();
    send(
      ...press(BTN_DRUM),
      ...press(BTN_BANK),
      ...knob(ENC_VOLUME, 6),
      ...press(BTN_SELECT_PRESS),
    );
    send(btn(ENC_FILTER));
    const model = mode.oled(true);
    expect(model.loopMode).toBe('fwd');
    expect(model.strip?.columns).toHaveLength(128);
    await expect(ascii(renderSampleOled(model))).toMatchFileSnapshot(golden('sample-loop'));
  });

  it('golden: Envelope and Filter pages', async () => {
    const { send, mode } = await setup();
    send(...press(BTN_DRUM), ...press(BTN_BANK), ...press(BTN_BANK));
    await expect(ascii(renderSampleOled(mode.oled(false)))).toMatchFileSnapshot(
      golden('sample-envelope'),
    );
    send(...press(BTN_BANK), ...knob(ENC_PAN, -12), btn(ENC_RESONANCE));
    await expect(ascii(renderSampleOled(mode.oled(false)))).toMatchFileSnapshot(
      golden('sample-filter'),
    );
  });

  it('golden: an empty slot (Loop page says so, Pitch page names the stand-in)', async () => {
    const { send, mode } = await setup({ load: false });
    send(...press(BTN_DRUM));
    expect(mode.oled(false).info).toBe('no sample: piano');
    send(...press(BTN_BANK));
    await expect(ascii(renderSampleOled(mode.oled(false)))).toMatchFileSnapshot(
      golden('sample-empty-loop'),
    );
  });

  it('equal models draw equal frames', () => {
    const input = {
      page: 'pitch' as const,
      slot: 0,
      patch: { ...new SoundSettings().sampler('sampler-1') },
      state: 'empty' as const,
      playing: false,
      touched: null,
      message: null,
      peaks: null,
    };
    expect(sampleOledModel(input)).toEqual(sampleOledModel({ ...input }));
  });
});

describe('SAMPLE mode on the connection', () => {
  it('paints the SAMPLE pads and OLED, and repaints when a patch changes', async () => {
    const { store, fire, mode, samplers } = await setup();
    const sent: number[][] = [];
    const output = {
      id: 'out',
      name: 'FL STUDIO FIRE',
      state: 'connected',
      send: (d: number[]) => sent.push(d),
    };
    const input = {
      id: 'in',
      name: 'FL STUDIO FIRE',
      state: 'connected',
      listener: null as ((e: FireMessageEvent) => void) | null,
      addEventListener(_t: 'midimessage', l: (e: FireMessageEvent) => void) {
        this.listener = l;
      },
      removeEventListener() {
        this.listener = null;
      },
    };
    const access: FireAccessLike = {
      inputs: { forEach: (fn) => fn(input) },
      outputs: { forEach: (fn) => fn(output) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const queue: (() => void)[] = [];
    const clock = { now: 0 };
    const connection = new FireConnection(store, () => Promise.resolve(access), fire, {
      schedule: (paint) => queue.push(paint),
      now: () => clock.now,
      delay: () => undefined,
    });
    await connection.connect();
    const flush = () => queue.splice(0).forEach((paint) => paint());
    flush();
    sent.length = 0;
    input.listener?.({ data: new Uint8Array([0x90, BTN_DRUM, 0x7f]) });
    input.listener?.({ data: new Uint8Array([0x80, BTN_DRUM, 0]) });
    clock.now += 100;
    flush();
    expect(mode.active).toBe(true);
    expect(sent).toContainEqual([0xb0, BTN_DRUM, LED_DRUM_ON]);
    const oled = sent.filter((m) => m[0] === 0xf0 && m[4] === 0x0e);
    expect(oled).toHaveLength(1);
    expect(oled[0]).toEqual(oledSysex(renderSampleOled(mode.oled(false))));
    // A change from elsewhere (the Sampler panel) repaints the device.
    sent.length = 0;
    samplers.setLevels('sampler-1', { gain: -6 });
    expect(queue).toHaveLength(1);
    clock.now += 100;
    flush();
    expect(sent.filter((m) => m[0] === 0xf0 && m[4] === 0x0e)).toHaveLength(1);
    connection.disconnect();
  });
});
