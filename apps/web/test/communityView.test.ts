/**
 * The Share toggle and the Community tab of the Sampler panel (docs/specs/community-v1.md §4.3,
 * §4.4) in jsdom against the in-memory bank. Decoding is injected; nothing is played (the
 * preview hook is a spy).
 */
import { createSong, createTrack } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import type { SamplerBuffer } from '../src/audio/sampler';
import { SAMPLER_RATE } from '../src/audio/sampler';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import { MemorySampleStore } from '../src/store/samples';
import { CommunityError, LICENCE_TEXT } from '../src/sync/community';
import { CommunitySync } from '../src/sync/communitySync';
import { mountBand } from '../src/views/band';
import { parseTags, shareStatus } from '../src/views/community';
import { FakeCommunity, listed } from './fakeCommunity';

function tone(seconds = 0.5): SamplerBuffer {
  const length = Math.round(seconds * SAMPLER_RATE);
  const data = new Float32Array(length).map(
    (_, i) => 0.4 * Math.sin((2 * Math.PI * 330 * i) / SAMPLER_RATE),
  );
  return {
    numberOfChannels: 1,
    length,
    sampleRate: SAMPLER_RATE,
    duration: seconds,
    getChannelData: () => data,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const digest = (bytes: ArrayBuffer): Promise<string> =>
  Promise.resolve([...new Uint8Array(bytes)].join('-'));

async function setup(options: { community?: boolean } = {}) {
  const song = createSong({
    chords: [{ token: 'I', beats: 4 }],
    tracks: [createTrack('chords', { id: 'trk-a', channel: 0 })],
  });
  const store = new Store(initialState(song));
  const audio = new AudioEngine(null, { decodeSampler: () => Promise.resolve(tone()) });
  await audio.samplers.attach(new MemorySampleStore());
  const preview = vi.spyOn(audio, 'preview').mockImplementation(() => ({ release: vi.fn() }));
  const api = new FakeCommunity();
  const sync = new CommunitySync({ client: api, samplers: audio.samplers, digest });
  sync.start();
  const actions = createActions(store, audio, new MidiOut(null));
  const root = document.createElement('section');
  document.body.append(root);
  mountBand(root, store, actions, null, audio.sound, null, {
    samplers: audio.samplers,
    community: options.community === false ? null : { sync, samplers: audio.samplers },
  });
  const panel = (): HTMLElement => {
    const el = root.querySelector<HTMLElement>('.sampler-panel');
    if (el === null) throw new Error('no panel');
    return el;
  };
  const field = <T extends HTMLElement>(name: string, scope: ParentNode = panel()): T => {
    const el = scope.querySelector<T>(`[data-field="${name}"]`);
    if (el === null) throw new Error(`no ${name}`);
    return el;
  };
  const select = root.querySelector<HTMLSelectElement>(
    '[data-track="trk-a"] [data-field="instrument"]',
  );
  if (select === null) throw new Error('no instrument select');
  select.value = 'sampler-1';
  select.dispatchEvent(new Event('change'));
  return { audio, api, sync, root, panel, field, preview };
}

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

function check(el: HTMLInputElement, on: boolean): void {
  el.checked = on;
  el.dispatchEvent(new Event('change'));
}

function file(seed: number): File {
  return new File([new Uint8Array([82, 73, 70, 70, seed])], `Kick ${seed}.wav`, {
    type: 'audio/wav',
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('without sync', () => {
  it('shows neither the tabs nor the Share toggle', async () => {
    const { panel } = await setup({ community: false });
    expect(panel().querySelector('[data-field="tab-community"]')).toBeNull();
    expect(panel().querySelector('[data-field="share"]')).toBeNull();
  });
});

describe('Share toggle', () => {
  it('is hidden without an own sample and shares through the licence form', async () => {
    const { audio, api, field } = await setup();
    const bar = field('share').closest<HTMLElement>('.share-bar');
    expect(bar?.hidden).toBe(true);
    await audio.samplers.load('sampler-1', file(1));
    await settle();
    expect(bar?.hidden).toBe(false);
    expect(field<HTMLInputElement>('share').checked).toBe(false);

    check(field<HTMLInputElement>('share'), true);
    const form = field<HTMLFormElement>('share-form');
    expect(form.hidden).toBe(false);
    expect(field<HTMLInputElement>('share-name').value).toBe('Kick 1');
    expect(form.textContent).toContain(LICENCE_TEXT);
    const submit = field<HTMLButtonElement>('share-submit');
    expect(submit.disabled).toBe(true);
    // Submitting without the licence does nothing.
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(api.named('share')).toHaveLength(0);

    type(field<HTMLInputElement>('share-tags'), 'Drums, kick kick');
    check(field<HTMLInputElement>('share-licence'), true);
    expect(submit.disabled).toBe(false);
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(api.named('share')[0]?.args[1]).toEqual({
      licence: true,
      name: 'Kick 1',
      tags: ['drums', 'kick'],
    });
    expect(form.hidden).toBe(true);
    expect(field<HTMLInputElement>('share').checked).toBe(true);
    expect(field('share-status').textContent).toBe('Checking…');
  });

  it('Cancel closes the form; unticking a live share unshares it', async () => {
    const { audio, api, field } = await setup();
    await audio.samplers.load('sampler-1', file(2));
    await settle();
    check(field<HTMLInputElement>('share'), true);
    field<HTMLButtonElement>('share-cancel').click();
    expect(field<HTMLFormElement>('share-form').hidden).toBe(true);
    expect(field<HTMLInputElement>('share').checked).toBe(false);

    const id = audio.samplers.patch('sampler-1').sample?.remote?.id ?? '';
    await api.share(id, { licence: true });
    const own = api.own.get(id);
    if (own?.share) own.share.state = 'listed';
    // Another slot and back: the own list is read again.
    audio.sound.setInstrument('trk-a', 'chords', 'sampler-2');
    await settle();
    audio.sound.setInstrument('trk-a', 'chords', 'sampler-1');
    await settle();
    expect(field('share-status').textContent).toBe('Shared');
    check(field<HTMLInputElement>('share'), false);
    await settle();
    expect(api.named('unshare').map((c) => c.args[0])).toEqual([id]);
    expect(field('share-status').textContent).toBe('Unshared: who already has it keeps it.');
    expect(field<HTMLInputElement>('share').checked).toBe(false);
  });

  it('shows a rejection with its category and disables the toggle; errors stay in the form', async () => {
    const { audio, api, field } = await setup();
    await audio.samplers.load('sampler-1', file(3));
    await settle();
    check(field<HTMLInputElement>('share'), true);
    check(field<HTMLInputElement>('share-licence'), true);
    api.fail.set(
      'share',
      new CommunityError(
        'rejected',
        'This sample was not accepted for the community bank.',
        'share_rejected',
      ),
    );
    field<HTMLFormElement>('share-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(field('share-error').hidden).toBe(false);
    expect(field('share-error').textContent).toContain('not accepted');

    const id = audio.samplers.patch('sampler-1').sample?.remote?.id ?? '';
    await api.share(id, { licence: true });
    const own = api.own.get(id);
    if (own?.share) {
      own.share.state = 'rejected';
      own.share.reason = 'speech';
    }
    field<HTMLButtonElement>('share-cancel').click();
    audio.sound.setInstrument('trk-a', 'chords', 'sampler-2');
    await settle();
    audio.sound.setInstrument('trk-a', 'chords', 'sampler-1');
    await settle();
    expect(field('share-status').textContent).toBe('Not listed: speech');
    expect(field<HTMLInputElement>('share').disabled).toBe(true);
  });
});

describe('Community tab', () => {
  async function open() {
    const t = await setup();
    t.api.bank = [
      listed('Dusty pad', { tags: ['pads'], root: 50 }),
      listed('Kick 808', { tags: ['drums', 'kick'], owner: 'beatsmith' }),
    ];
    for (const s of t.api.bank) t.api.files.set(s.id, new Uint8Array([7, s.root]).buffer);
    t.field<HTMLButtonElement>('tab-community').click();
    await settle();
    return t;
  }

  const names = (list: HTMLElement): string[] =>
    [...list.querySelectorAll('.community-name')].map((n) => n.textContent ?? '');

  it('lists the bank with owners and tags, hides the edit view and shows the handle', async () => {
    const { field, panel } = await open();
    expect(field('community').hidden).toBe(false);
    expect(panel().querySelector('.sampler-controls')?.classList.contains('tab-hidden')).toBe(true);
    const list = field('community-list');
    expect(names(list)).toEqual(['Dusty pad', 'Kick 808']);
    expect(list.textContent).toContain('by beatsmith');
    expect(field('handle').textContent).toBe('alice');
    expect([...list.querySelectorAll('[data-field="add"]')].map((b) => b.textContent)).toEqual([
      'Add to slot 1',
      'Add to slot 1',
    ]);
    field<HTMLButtonElement>('tab-edit').click();
    expect(field('community').hidden).toBe(true);
    expect(panel().querySelector('.sampler-controls')?.classList.contains('tab-hidden')).toBe(
      false,
    );
  });

  it('searches by name, filters by a clicked tag and pages with More', async () => {
    const { api, field } = await open();
    type(field<HTMLInputElement>('community-search'), 'kick');
    field<HTMLFormElement>('community-search')
      .closest('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(api.named('browse').at(-1)?.args[0]).toMatchObject({ q: 'kick', tag: '' });
    expect(names(field('community-list'))).toEqual(['Kick 808']);
    field<HTMLButtonElement>('tab-edit').click();
    field<HTMLButtonElement>('tab-community').click();
    type(field<HTMLInputElement>('community-search'), '');
    const drums = field('community-list').querySelector<HTMLButtonElement>('[data-tag="drums"]');
    drums?.click();
    await settle();
    expect(api.named('browse').at(-1)?.args[0]).toMatchObject({ tag: 'drums' });
    expect(field<HTMLInputElement>('community-tag').value).toBe('drums');

    api.bank = Array.from({ length: 30 }, (_, i) => listed(`Loop ${i}`));
    type(field<HTMLInputElement>('community-tag'), '');
    field('community-go').click();
    await settle();
    expect(field('community-list').children).toHaveLength(24);
    expect(field('more').hidden).toBe(false);
    field<HTMLButtonElement>('more').click();
    await settle();
    expect(field('community-list').children).toHaveLength(30);
    expect(field('more').hidden).toBe(true);
  });

  it('auditions through the sampler voice while held; the first press downloads', async () => {
    // jsdom has no AudioBuffer; the preview prepares its buffers with one.
    vi.stubGlobal(
      'AudioBuffer',
      class {
        readonly numberOfChannels: number;
        readonly length: number;
        readonly sampleRate: number;
        readonly #data: Float32Array[];
        constructor(o: { numberOfChannels: number; length: number; sampleRate: number }) {
          this.numberOfChannels = o.numberOfChannels;
          this.length = o.length;
          this.sampleRate = o.sampleRate;
          this.#data = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
        }
        get duration(): number {
          return this.length / this.sampleRate;
        }
        getChannelData(c: number): Float32Array {
          return this.#data[c] ?? new Float32Array(this.length);
        }
      },
    );
    const { api, field, preview } = await open();
    const play =
      field('community-list').querySelector<HTMLButtonElement>('[data-field="audition"]');
    if (play === null) throw new Error('no audition button');
    play.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(field('community-status').textContent).toBe('');
    expect(api.named('bytes')).toHaveLength(1);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[1]).toBe(50);
    const handle = preview.mock.results[0]?.value as { release: () => void };
    play.dispatchEvent(new Event('pointerup'));
    expect(handle.release).toHaveBeenCalled();
    play.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(api.named('bytes')).toHaveLength(1);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('Add to slot takes the sample, fills the slot and switches back to Edit', async () => {
    const { audio, api, field } = await open();
    const add =
      field('community-list').querySelectorAll<HTMLButtonElement>('[data-field="add"]')[1];
    add?.click();
    await settle();
    expect(api.named('take')[0]?.args[1]).toBe('sampler-1');
    const sample = audio.samplers.patch('sampler-1').sample;
    expect(sample?.remote).toMatchObject({ community: true, owner: 'beatsmith' });
    expect(field('community').hidden).toBe(true);
    expect(field('info').textContent).toContain('community · by beatsmith');
    // A community sample cannot be shared again.
    expect(field('share').closest<HTMLElement>('.share-bar')?.hidden).toBe(true);
  });

  it('says why a take failed', async () => {
    const { api, field } = await open();
    api.bank = [];
    field('community-list').querySelector<HTMLButtonElement>('[data-field="add"]')?.click();
    await settle();
    expect(field('community-status').textContent).toBe(
      'This sample is no longer in the community bank.',
    );
    expect(field('community-status').classList.contains('error')).toBe(true);
  });

  it('lists Your shares with their state and unshares from there', async () => {
    const t = await setup();
    await t.audio.samplers.load('sampler-1', file(4));
    await t.audio.samplers.load('sampler-2', file(5));
    await settle();
    const [a, b] = [...t.api.own.keys()];
    await t.api.share(a ?? '', { licence: true, name: 'Pending one' });
    await t.api.share(b ?? '', { licence: true, name: 'Listed one' });
    const listedOwn = t.api.own.get(b ?? '');
    if (listedOwn?.share) listedOwn.share.state = 'listed';
    t.field<HTMLButtonElement>('tab-community').click();
    await settle();
    const mine = t.field('mine');
    expect(names(mine).sort()).toEqual(['Listed one', 'Pending one']);
    expect(mine.textContent).toContain('Checking…');
    expect(mine.textContent).toContain('Shared');
    mine.querySelector<HTMLButtonElement>(`[data-id="${b ?? ''}"] [data-field="unshare"]`)?.click();
    await settle();
    expect(t.api.named('unshare').map((c) => c.args[0])).toEqual([b]);
    expect(t.field('mine').textContent).toContain('Not shared');
  });

  it('changes the handle and shows sign-in problems', async () => {
    const { api, field } = await open();
    field<HTMLButtonElement>('handle-edit').click();
    type(field<HTMLInputElement>('handle-input'), 'dusty_loops');
    field<HTMLButtonElement>('handle-edit').click();
    await settle();
    expect(api.named('setHandle')[0]?.args[0]).toBe('dusty_loops');
    expect(field('handle').textContent).toBe('dusty_loops');
    api.fail.set(
      'browse',
      new CommunityError(
        'signed-out',
        'Sign in again to use the community bank (reload the page).',
      ),
    );
    field('community-go').click();
    await settle();
    expect(field('community-status').textContent).toContain('Sign in again');
  });
});

describe('helpers', () => {
  it('parses tags and words the share states', () => {
    expect(parseTags(' Drums, kick  808,kick, a b c d e f')).toEqual([
      'drums',
      'kick',
      '808',
      'a',
      'b',
    ]);
    expect(parseTags('no_under!scores')).toEqual(['nounderscores']);
    expect(shareStatus(null).text).toBe('');
    const base = { reason: null, shared_at: '', listed_at: null, unlisted_at: null };
    expect(shareStatus({ ...base, state: 'pending' }).text).toBe('Checking…');
    expect(shareStatus({ ...base, state: 'listed' }).text).toBe('Shared');
    expect(shareStatus({ ...base, state: 'unlisted' }).text).toBe('Not shared');
    expect(shareStatus({ ...base, state: 'rejected', reason: 'hate' }).text).toBe(
      'Not listed: hate',
    );
  });
});
