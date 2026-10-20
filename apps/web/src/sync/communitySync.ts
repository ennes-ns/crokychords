/**
 * Own sampler samples on the server (docs/specs/community-v1.md §4.2): uploads a slot's own
 * sample in the background and writes the server id into the patch, deletes an upload that no
 * slot uses any more, downloads the bytes of a slot whose local copy is gone, and runs the
 * share and take flows the Sampler panel offers.
 */
import type { SamplerId } from '../audio/instruments';
import { SAMPLER_IDS } from '../audio/instruments';
import type { Samplers } from '../audio/sampler';
import type { CommunityClient, CommunitySample, OwnSample } from './community';
import { CommunityError, sha256Hex, uploadType } from './community';

interface Seen {
  savedAt: string | null;
  /** The slot's own upload (not a community sample). */
  ownId: string | null;
  /** The community sample the slot took (its ref on the server). */
  takenId: string | null;
}

export interface CommunitySyncOptions {
  client: CommunityClient;
  samplers: Samplers;
  /** SHA-256 of the bytes (tests inject a fake). */
  digest?: (bytes: ArrayBuffer) => Promise<string>;
}

export class CommunitySync {
  readonly #client: CommunityClient;
  readonly #samplers: Samplers;
  readonly #digest: (bytes: ArrayBuffer) => Promise<string>;
  readonly #seen = new Map<SamplerId, Seen>();
  /** Uploads in flight by `savedAt`, so a sample is uploaded once. */
  readonly #uploads = new Map<string, Promise<string | null>>();
  /** Samples (`savedAt`) whose background upload failed: not retried until a share or restart. */
  readonly #failed = new Set<string>();
  #started = false;

  constructor(options: CommunitySyncOptions) {
    this.#client = options.client;
    this.#samplers = options.samplers;
    this.#digest = options.digest ?? sha256Hex;
  }

  get client(): CommunityClient {
    return this.#client;
  }

  /** Watch the slots; upload every own sample that has no server copy yet. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const id of SAMPLER_IDS) this.#seen.set(id, this.#current(id));
    this.#samplers.subscribe((id) => this.#changed(id));
    for (const id of SAMPLER_IDS) this.#maybeUpload(id);
  }

  /** The bytes of a sample's server copy (the bank's fallback when the local copy is gone). */
  download(remoteId: string): Promise<ArrayBuffer> {
    return this.#client.bytes(remoteId);
  }

  /**
   * The server id of the slot's own sample, uploading it first when needed; null when the slot
   * has no own sample or its bytes are not stored. Rejects with the upload's error.
   */
  async ensureUploaded(id: SamplerId): Promise<string | null> {
    const sample = this.#samplers.patch(id).sample;
    if (sample === null || sample.remote?.community === true) return null;
    if (sample.remote !== undefined) return sample.remote.id;
    const savedAt = sample.savedAt;
    let upload = this.#uploads.get(savedAt);
    if (upload === undefined) {
      upload = this.#upload(id, savedAt);
      this.#uploads.set(savedAt, upload);
      void upload.finally(() => this.#uploads.delete(savedAt)).catch(() => undefined);
    }
    return upload;
  }

  /**
   * Share the slot's own sample (the user ticked the licence): upload when needed, then share.
   * A server copy that has gone is uploaded again.
   */
  async share(id: SamplerId, options: { name: string; tags: string[] }): Promise<OwnSample> {
    const remote = await this.ensureUploaded(id);
    if (remote === null) throw new CommunityError('rejected', 'This slot has no own sample.');
    try {
      return await this.#client.share(remote, { licence: true, ...options });
    } catch (e) {
      if (!(e instanceof CommunityError) || e.code !== 'not_found') throw e;
      const savedAt = this.#samplers.patch(id).sample?.savedAt;
      if (savedAt !== undefined) this.#samplers.setRemote(id, savedAt, null);
      const again = await this.ensureUploaded(id);
      if (again === null) throw e;
      return this.#client.share(again, { licence: true, ...options });
    }
  }

  /** Take `sample` from the bank into `slot`: the ref, the bytes, the slot. */
  async take(slot: SamplerId, sample: CommunitySample): Promise<void> {
    const taken = await this.#client.take(sample.id, slot);
    const bytes = await this.#client.bytes(sample.id);
    await this.#samplers.loadBytes(slot, bytes, {
      name: taken.name,
      type: '',
      root: taken.root,
      remote: taken.own
        ? { id: taken.id, community: false }
        : { id: taken.id, community: true, owner: taken.owner },
    });
  }

  async #upload(id: SamplerId, savedAt: string): Promise<string | null> {
    const stored = await this.#samplers.stored(id);
    const sample = this.#samplers.patch(id).sample;
    if (stored === null || sample === null || sample.savedAt !== savedAt) return null;
    const type = uploadType(stored.type, stored.name);
    if (type === null) {
      throw new CommunityError('rejected', 'Only wav, ogg, flac and mp3 files can be shared.');
    }
    const uploaded = await this.#client.upload(stored.bytes, {
      name: sample.name.trim() === '' ? 'Sample' : sample.name,
      duration: sample.frames / sample.sampleRate,
      channels: sample.channels,
      root: this.#samplers.patch(id).root,
      sha256: await this.#digest(stored.bytes),
      type,
    });
    if (!this.#samplers.setRemote(id, savedAt, { id: uploaded.id, community: false })) {
      // The slot moved on during the upload: do not leave the upload orphaned.
      this.#release(uploaded.id);
      return null;
    }
    return uploaded.id;
  }

  #current(id: SamplerId): Seen {
    const sample = this.#samplers.patch(id).sample;
    const remote = sample?.remote;
    return {
      savedAt: sample?.savedAt ?? null,
      ownId: remote !== undefined && !remote.community ? remote.id : null,
      takenId: remote?.community === true ? remote.id : null,
    };
  }

  #changed(id: SamplerId): void {
    const before = this.#seen.get(id);
    const now = this.#current(id);
    this.#seen.set(id, now);
    if (before?.ownId != null && before.savedAt !== now.savedAt) this.#release(before.ownId);
    // A slot that drops a taken sample releases its ref, so the owner can delete it again.
    if (before?.takenId != null && before.savedAt !== now.savedAt) {
      this.#client.release(before.takenId, id).catch(() => undefined);
    }
    if (before?.savedAt !== now.savedAt || now.ownId === null) this.#maybeUpload(id);
  }

  /** Whether a slot holds the server sample `remoteId` (own or taken). */
  inUse(remoteId: string): boolean {
    for (const id of SAMPLER_IDS) {
      if (this.#samplers.patch(id).sample?.remote?.id === remoteId) return true;
    }
    return false;
  }

  /** Delete an upload no slot uses any more; the server keeps it while it is shared or used. */
  #release(remoteId: string): void {
    if (this.inUse(remoteId)) return;
    this.#client.remove(remoteId).catch(() => undefined);
  }

  #maybeUpload(id: SamplerId): void {
    const sample = this.#samplers.patch(id).sample;
    if (sample === null || sample.remote !== undefined) return;
    if (this.#samplers.state(id) !== 'ready' || this.#failed.has(sample.savedAt)) return;
    // Background: a failure leaves the slot local-only; sharing or the next start retries.
    const savedAt = sample.savedAt;
    this.ensureUploaded(id).then(
      (remote) => {
        if (remote === null) this.#failed.add(savedAt);
      },
      () => this.#failed.add(savedAt),
    );
  }
}
