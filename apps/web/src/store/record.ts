/**
 * The saved-progression record (`schema_version: 1`, docs/specs/savestore-v1.md): the format every
 * SaveStore keeps and the Worker API stores, unchanged, over the wire.
 */
import type { Song } from '@crokychords/core';
import { serializeSong, validateSong } from '@crokychords/core';

export const SAVE_SCHEMA_VERSION = 1;
export const MAX_SAVE_TITLE_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface SaveRecord {
  schema_version: typeof SAVE_SCHEMA_VERSION;
  /** 1–64 characters of [A-Za-z0-9_-]. */
  id: string;
  /** Monotonic per id: 1 for the first save, previous + 1 after that. */
  version: number;
  /** ISO 8601 UTC timestamp of the save. */
  updated_at: string;
  /** `song.title`, cut to MAX_SAVE_TITLE_LENGTH, so a list needs no song. */
  title: string;
  /** The song as `serializeSong` writes it. */
  song: Song;
}

/** A record without its song: what `SaveStore.list` returns. */
export type SaveSummary = Omit<SaveRecord, 'song'>;

/** A value that is not a valid SaveRecord; `path` names the field ('' for the whole value). */
export class SaveRecordError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(path === '' ? message : `${path}: ${message}`);
    this.name = 'SaveRecordError';
  }
}

/** `put` with a version other than the stored version + 1. */
export class VersionConflictError extends Error {
  constructor(
    readonly id: string,
    /** The version the store would have accepted. */
    readonly expected: number,
    /** The version that was offered. */
    readonly actual: number,
  ) {
    super(`version conflict on "${id}": expected version ${expected}, got ${actual}`);
    this.name = 'VersionConflictError';
  }
}

export function isValidSaveId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** A fresh random record id (a UUID, which fits the id rule). */
export function newSaveId(): string {
  return crypto.randomUUID();
}

export interface MakeRecordOptions {
  id: string;
  version: number;
  now: Date;
}

/** Build a record for `song`; the song goes through serializeSong, so it is in the wire format. */
export function makeRecord(song: Song, { id, version, now }: MakeRecordOptions): SaveRecord {
  const json: unknown = JSON.parse(serializeSong(song));
  return parseSaveRecord({
    schema_version: SAVE_SCHEMA_VERSION,
    id,
    version,
    updated_at: now.toISOString(),
    title: song.title.slice(0, MAX_SAVE_TITLE_LENGTH),
    song: json,
  });
}

/** Validate an untrusted value as a SaveRecord. Throws SaveRecordError. */
export function parseSaveRecord(value: unknown): SaveRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SaveRecordError('', 'expected an object');
  }
  const root = value as Record<string, unknown>;
  if (root['schema_version'] !== SAVE_SCHEMA_VERSION) {
    throw new SaveRecordError('schema_version', `expected ${SAVE_SCHEMA_VERSION}`);
  }
  const id = root['id'];
  if (typeof id !== 'string' || !isValidSaveId(id)) {
    throw new SaveRecordError('id', 'expected 1-64 characters of [A-Za-z0-9_-]');
  }
  const version = root['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new SaveRecordError('version', 'expected an integer >= 1');
  }
  const updatedAt = root['updated_at'];
  if (
    typeof updatedAt !== 'string' ||
    !TIMESTAMP_PATTERN.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new SaveRecordError('updated_at', 'expected an ISO 8601 UTC timestamp');
  }
  const title = root['title'];
  if (typeof title !== 'string' || title.length > MAX_SAVE_TITLE_LENGTH) {
    throw new SaveRecordError('title', `expected a string of at most ${MAX_SAVE_TITLE_LENGTH}`);
  }
  let song: Song;
  try {
    song = validateSong(root['song']);
  } catch (e) {
    throw new SaveRecordError('song', e instanceof Error ? e.message : String(e));
  }
  return { schema_version: SAVE_SCHEMA_VERSION, id, version, updated_at: updatedAt, title, song };
}

export function summarize(record: SaveRecord): SaveSummary {
  return {
    schema_version: record.schema_version,
    id: record.id,
    version: record.version,
    updated_at: record.updated_at,
    title: record.title,
  };
}
