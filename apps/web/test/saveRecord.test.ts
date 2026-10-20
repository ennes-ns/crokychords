import { createSong, serializeSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_SAVE_TITLE_LENGTH,
  SAVE_SCHEMA_VERSION,
  SaveRecordError,
  VersionConflictError,
  isValidSaveId,
  makeRecord,
  newSaveId,
  parseSaveRecord,
  summarize,
} from '../src/store/record';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const song = createSong({ title: 'Night drive', chords: [{ token: 'vi', beats: 4 }] });

function valid(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'abc-123_X',
    version: 2,
    updated_at: '2026-10-20T12:00:00.000Z',
    title: 'Night drive',
    song: JSON.parse(serializeSong(song)) as unknown,
  };
}

function pathOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof SaveRecordError) return e.path;
    throw e;
  }
  return null;
}

describe('save record', () => {
  it('builds a record in the wire format', () => {
    const record = makeRecord(song, { id: 'r1', version: 1, now: NOW });
    expect(record).toEqual({
      schema_version: SAVE_SCHEMA_VERSION,
      id: 'r1',
      version: 1,
      updated_at: '2026-10-20T12:00:00.000Z',
      title: 'Night drive',
      song,
    });
    // The record survives JSON unchanged: what goes over the wire is what is stored.
    expect(parseSaveRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('cuts a long title for the record but keeps the song title', () => {
    const long = 'x'.repeat(MAX_SAVE_TITLE_LENGTH + 10);
    const record = makeRecord({ ...song, title: long }, { id: 'r1', version: 1, now: NOW });
    expect(record.title).toHaveLength(MAX_SAVE_TITLE_LENGTH);
    expect(record.song.title).toBe(long);
  });

  it('accepts a valid record and migrates a schema-1 song', () => {
    expect(parseSaveRecord(valid()).song).toEqual(song);
    const legacy = {
      ...valid(),
      song: { ...(valid()['song'] as object), schema: 1, tracks: undefined },
    };
    expect(parseSaveRecord(JSON.parse(JSON.stringify(legacy))).song.schema).toBe(4);
  });

  it.each([
    ['', null],
    ['', []],
    ['schema_version', { schema_version: 2 }],
    ['id', { id: '' }],
    ['id', { id: '../etc' }],
    ['id', { id: 'x'.repeat(65) }],
    ['version', { version: 0 }],
    ['version', { version: 1.5 }],
    ['version', { version: '2' }],
    ['updated_at', { updated_at: '2026-10-20' }],
    ['updated_at', { updated_at: '2026-13-45T99:00:00Z' }],
    ['title', { title: 3 }],
    ['title', { title: 'x'.repeat(MAX_SAVE_TITLE_LENGTH + 1) }],
    ['song', { song: { schema: 9 } }],
  ])('rejects a bad %s', (path, patch) => {
    const value = patch === null || Array.isArray(patch) ? patch : { ...valid(), ...patch };
    expect(pathOf(() => parseSaveRecord(value))).toBe(path);
  });

  it('checks ids', () => {
    expect(isValidSaveId('a')).toBe(true);
    expect(isValidSaveId('a/b')).toBe(false);
    expect(isValidSaveId(newSaveId())).toBe(true);
    expect(newSaveId()).not.toBe(newSaveId());
  });

  it('summarizes without the song', () => {
    const record = makeRecord(song, { id: 'r1', version: 3, now: NOW });
    expect(summarize(record)).toEqual({
      schema_version: 1,
      id: 'r1',
      version: 3,
      updated_at: record.updated_at,
      title: 'Night drive',
    });
  });

  it('describes errors', () => {
    expect(new SaveRecordError('id', 'bad').message).toBe('id: bad');
    expect(new SaveRecordError('', 'bad').message).toBe('bad');
    const conflict = new VersionConflictError('r1', 3, 2);
    expect([conflict.id, conflict.expected, conflict.actual]).toEqual(['r1', 3, 2]);
    expect(conflict.message).toContain('expected version 3');
  });
});
