import { SongError, validateSong } from '@crokychords/core';
import type { Song } from '@crokychords/core';
import { z } from 'zod';

/** Limits from docs/specs/api-v1.md §7. */
export const LIMITS = {
  /** Maximum size of a PUT body in bytes (256 KiB). */
  maxSaveBytes: 256 * 1024,
  /** Maximum number of saves per user. */
  maxSaves: 200,
  maxTitleLength: 200,
} as const;

export const SCHEMA_VERSION = 1;

export const SAVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSaveId(value: string): boolean {
  return SAVE_ID_PATTERN.test(value);
}

/** Metadata kept in D1 and returned by `GET /api/saves`. */
export interface SaveMeta {
  id: string;
  version: number;
  updated_at: string;
  title: string;
}

/** The record shared with the web SaveStore; stored as JSON in R2. */
export interface SaveRecord extends SaveMeta {
  schema_version: typeof SCHEMA_VERSION;
  song: Song;
}

const songSchema = z.unknown().transform((value, ctx): Song => {
  try {
    return validateSong(value);
  } catch (e) {
    if (e instanceof SongError) {
      ctx.addIssue({ code: 'custom', message: e.message });
      return z.NEVER;
    }
    throw e;
  }
});

/** Body of `PUT /api/saves/:id`. `updated_at` is accepted but replaced by the server. */
export const saveInputSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(SAVE_ID_PATTERN),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  updated_at: z.string().optional(),
  title: z.string().max(LIMITS.maxTitleLength),
  song: songSchema,
});

export type SaveInput = z.infer<typeof saveInputSchema>;

/** A one-line description of the first validation problem, for the error message. */
export function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid record';
  const path = issue.path.map(String).join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
