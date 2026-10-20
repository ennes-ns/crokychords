/**
 * Own samples on the server and the sampler's community hooks (docs/specs/community-v1.md §4.2,
 * §4.4): background upload, the id written back, stale uploads dropped, deletes on replace, the
 * download of missing bytes, share and take flows, the preview. Decoding is injected; nothing
 * is played.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SamplerBuffer } from '../src/audio/sampler';
import {
  SAMPLER_RATE,
  SamplerBank,
  Samplers,
  defaultPatch,
  parsePatch,
} from '../src/audio/sampler';
import { AudioEngine } from '../src/audio/synth';
import { MemorySampleStore } from '../src/store/samples';
import { CommunityError } from '../src/sync/community';
import { CommunitySync } from '../src/sync/communitySync';
import { FakeCommunity, fakeId, listed } from './fakeCommunity';

function tone(seconds = 0.5): SamplerBuffer {
  const length = Math.round(seconds * SAMPLER_RATE);
  const data = new Float32Array(length).map(
    (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SAMPLER_RATE),
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
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function file(seed: number, name = `kick-${seed}.wav`): File {
  return new File([new Uint8Array([82, 73, 70, 70, seed, seed + 1])], name, { type: 'audio/wav' });
}

/** Content-derived fake digest (Web Crypto is not needed for these tests). */
const digest = (bytes: ArrayBuffer): Promise<string> =>
  Promise.resolve([...new Uint8Array(bytes)].join('-'));

async function setup(options: { start?: boolean } = {}) {
  const audio = new AudioEngine(null, { decodeSampler: () => Promise.resolve(tone()) });
  const store = new MemorySampleStore();
  await audio.samplers.attach(store);
  const api = new FakeCommunity();
  const sync = new CommunitySync({ client: api, samplers: audio.samplers, digest });
  if (options.start !== false) sync.start();
  return { audio, samplers: audio.samplers, store, api, sync };
}

describe('CommunitySync: own samples to the server', () => {
  it('uploads a loaded sample once and writes its id into the patch', async () => {
    const { samplers, api } = await setup();
    await samplers.load('sampler-1', file(1));
    samplers.setTune('sampler-1', 5);
    samplers.setTune('sampler-1', 6);
    await settle();
    const uploads = api.named('upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args[1]).toMatchObject({
      name: 'kick-1.wav',
      channels: 1,
      type: 'audio/wav',
      duration: 0.5,
    });
    const remote = samplers.patch('sampler-1').sample?.remote;
    expect(remote).toEqual({ id: [...api.own.keys()][0], community: false });
    // The id survives the sound settings round trip.
    expect(
      parsePatch(JSON.parse(JSON.stringify(samplers.patch('sampler-1'))), 'sampler-1').sample
        ?.remote,
    ).toEqual(remote);
  });

  it('uploads what was loaded before it started', async () => {
    const { samplers, api, sync } = await setup({ start: false });
    await samplers.load('sampler-2', file(2));
    expect(api.named('upload')).toHaveLength(0);
    sync.start();
    await settle();
    expect(api.named('upload')).toHaveLength(1);
    expect(samplers.patch('sampler-2').sample?.remote?.community).toBe(false);
  });

  it('drops an upload whose slot got another sample meanwhile', async () => {
    const { samplers, api } = await setup();
    let release: () => void = () => undefined;
    const original = api.upload.bind(api);
    api.upload = (bytes, meta) =>
      new Promise((resolve) => {
        release = () => resolve(original(bytes, meta));
      });
    await samplers.load('sampler-1', file(1));
    await settle();
    api.upload = original;
    await samplers.load('sampler-1', file(9));
    await settle();
    const second = samplers.patch('sampler-1').sample?.remote?.id;
    release();
    await settle();
    expect(samplers.patch('sampler-1').sample?.remote?.id).toBe(second);
    // The late upload of the first file is deleted again, not left orphaned.
    const ids = [...api.own.keys()];
    expect(ids).toEqual([second]);
    expect(api.named('remove')).toHaveLength(1);
  });

  it('a slot that drops a taken sample releases its ref', async () => {
    const { samplers, api, sync } = await setup();
    const sample = listed('Pad');
    api.bank = [sample];
    api.files.set(sample.id, new Uint8Array([4, 4]).buffer);
    await sync.take('sampler-6', sample);
    await settle();
    expect(api.named('release')).toHaveLength(0);
    await samplers.load('sampler-6', file(6));
    await settle();
    expect(api.named('release').map((c) => c.args)).toEqual([[sample.id, 'sampler-6']]);
    // A community sample is never deleted by the taker.
    expect(api.named('remove')).toHaveLength(0);
    expect(sync.inUse(sample.id)).toBe(false);
  });

  it('a failed download is not retried on every edit', async () => {
    const api = new FakeCommunity();
    const audio = new AudioEngine(null, { decodeSampler: () => Promise.resolve(tone()) });
    const sync = new CommunitySync({ client: api, samplers: audio.samplers, digest });
    audio.samplerBank.setRemote((id) => sync.download(id));
    audio.sound.setSampler('sampler-2', {
      ...defaultPatch('sampler-2'),
      sample: {
        name: 'gone.wav',
        frames: tone().length,
        sampleRate: SAMPLER_RATE,
        channels: 1,
        savedAt: '2026-10-21T10:00:00.000Z',
        remote: { id: fakeId(), community: true, owner: 'dusty' },
      },
      end: tone().length,
    });
    await audio.samplers.attach(new MemorySampleStore());
    expect(audio.samplers.state('sampler-2')).toBe('error');
    audio.samplers.setTune('sampler-2', 7);
    audio.samplers.setTune('sampler-2', 8);
    await settle();
    expect(api.named('bytes')).toHaveLength(1);
  });

  it('a failed background upload is not retried on every edit', async () => {
    const { samplers, api } = await setup();
    api.fail.set('upload', new CommunityError('rejected', 'limit', 'sample_limit_reached'));
    await samplers.load('sampler-1', file(1));
    await settle();
    samplers.setTune('sampler-1', 3);
    samplers.setTune('sampler-1', 4);
    await settle();
    expect(api.named('upload')).toHaveLength(1);
    expect(samplers.patch('sampler-1').sample?.remote).toBeUndefined();
  });

  it('deletes an upload once no slot uses it', async () => {
    const { samplers, api } = await setup();
    await samplers.load('sampler-1', file(1));
    await samplers.load('sampler-2', file(1));
    await settle();
    const id = samplers.patch('sampler-1').sample?.remote?.id;
    expect(samplers.patch('sampler-2').sample?.remote?.id).toBe(id);
    await samplers.clear('sampler-1');
    await settle();
    expect(api.named('remove')).toHaveLength(0);
    await samplers.load('sampler-2', file(3));
    await settle();
    expect(api.named('remove').map((c) => c.args[0])).toEqual([id]);
  });

  it('downloads the bytes of a slot whose local copy is gone', async () => {
    const api = new FakeCommunity();
    const remoteId = fakeId();
    api.files.set(remoteId, new Uint8Array([1, 2, 3]).buffer);
    const audio = new AudioEngine(null, { decodeSampler: () => Promise.resolve(tone()) });
    const sync = new CommunitySync({ client: api, samplers: audio.samplers, digest });
    audio.samplerBank.setRemote((id) => sync.download(id));
    audio.sound.setSampler('sampler-4', {
      ...defaultPatch('sampler-4'),
      sample: {
        name: 'pad.wav',
        frames: tone().length,
        sampleRate: SAMPLER_RATE,
        channels: 1,
        savedAt: '2026-10-21T10:00:00.000Z',
        remote: { id: remoteId, community: true, owner: 'dusty' },
      },
      end: tone().length,
    });
    const store = new MemorySampleStore();
    await audio.samplers.attach(store);
    expect(audio.samplers.state('sampler-4')).toBe('ready');
    expect(api.named('bytes').map((c) => c.args[0])).toEqual([remoteId]);
    expect((await store.get('sampler-4'))?.saved_at).toBe('2026-10-21T10:00:00.000Z');
  });
});

describe('CommunitySync: share and take', () => {
  it('share uploads first when needed, and again when the server copy has gone', async () => {
    const { samplers, api, sync } = await setup({ start: false });
    await samplers.load('sampler-1', file(1));
    const shared = await sync.share('sampler-1', { name: 'Kick', tags: ['drums'] });
    expect(shared.share?.state).toBe('pending');
    expect(api.named('share')[0]?.args[1]).toEqual({
      licence: true,
      name: 'Kick',
      tags: ['drums'],
    });
    const first = samplers.patch('sampler-1').sample?.remote?.id ?? '';
    api.own.delete(first);
    const again = await sync.share('sampler-1', { name: 'Kick', tags: [] });
    expect(again.id).not.toBe(first);
    expect(samplers.patch('sampler-1').sample?.remote?.id).toBe(again.id);
    await expect(sync.share('sampler-5', { name: 'x', tags: [] })).rejects.toThrow('no own sample');
  });

  it('take loads the bank sample into the slot with its owner and root', async () => {
    const { samplers, api, sync } = await setup();
    const sample = listed('Dusty pad', { root: 45 });
    api.bank = [sample];
    api.files.set(sample.id, new Uint8Array([9, 9, 9]).buffer);
    await samplers.load('sampler-3', file(3));
    await settle();
    await sync.take('sampler-3', sample);
    await settle();
    expect(api.named('take')[0]?.args).toEqual([sample.id, 'sampler-3']);
    const patch = samplers.patch('sampler-3');
    expect(patch.root).toBe(45);
    expect(patch.sample).toMatchObject({
      name: 'Dusty pad',
      remote: { id: sample.id, community: true, owner: 'dusty' },
    });
    // The own sample it replaced is released; the community one is never uploaded.
    expect(api.named('remove')).toHaveLength(1);
    expect(api.named('upload')).toHaveLength(1);
    api.bank = [];
    await expect(sync.take('sampler-2', sample)).rejects.toThrow('no longer');
  });
});

describe('Samplers: preview and remote ids', () => {
  it('previews a sample in no slot through the play hook, decoding it once', async () => {
    const decode = vi.fn(() => Promise.resolve(tone()));
    const bank = new SamplerBank({
      decode,
      create: (channels, length, sampleRate) => {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (c) => data[c] ?? new Float32Array(length),
        };
      },
    });
    const sound = new AudioEngine(null).sound;
    const play = vi.fn(() => ({ release: vi.fn() }));
    const samplers = new Samplers(sound, bank, null, play);
    const load = vi.fn(() => Promise.resolve(new ArrayBuffer(8)));
    const handle = await samplers.preview('id-1', load, 50);
    expect(handle).not.toBeNull();
    await samplers.preview('id-1', load, 50);
    expect(load).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    const [ready, note] = (play.mock.calls[0] ?? []) as unknown as [
      { patch: { root: number } },
      number,
    ];
    expect(note).toBe(50);
    expect(ready.patch.root).toBe(50);
    // A slot is untouched.
    expect(samplers.patch('sampler-1').sample).toBeNull();
    const failing = () => Promise.reject(new Error('offline'));
    await expect(samplers.preview('id-2', failing, 60)).rejects.toThrow('offline');
    expect(await new Samplers(sound, bank).preview('id-1', load, 50)).toBeNull();
  });

  it('setRemote writes only while the slot holds that sample; parsing drops bad ids', async () => {
    const { samplers } = await setup({ start: false });
    await samplers.load('sampler-1', file(1));
    const savedAt = samplers.patch('sampler-1').sample?.savedAt ?? '';
    const id = fakeId();
    expect(samplers.setRemote('sampler-1', 'stale', { id, community: false })).toBe(false);
    expect(samplers.setRemote('sampler-1', savedAt, { id, community: false })).toBe(true);
    expect(samplers.patch('sampler-1').sample?.remote).toEqual({ id, community: false });
    expect(samplers.setRemote('sampler-1', savedAt, null)).toBe(true);
    expect(samplers.patch('sampler-1').sample?.remote).toBeUndefined();
    const raw = JSON.parse(JSON.stringify(samplers.patch('sampler-1'))) as {
      sample: Record<string, unknown>;
    };
    raw.sample['remote'] = { id: 'not-a-uuid', community: false };
    expect(parsePatch(raw, 'sampler-1').sample?.remote).toBeUndefined();
    raw.sample['remote'] = { id, community: true, owner: 'dusty' };
    expect(parsePatch(raw, 'sampler-1').sample?.remote).toEqual({
      id,
      community: true,
      owner: 'dusty',
    });
  });
});
