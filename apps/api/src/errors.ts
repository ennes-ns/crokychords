import type { SaveMeta } from './record';

/** Error codes of the API (docs/specs/api-v1.md §6) with their HTTP status. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden_origin: 403,
  forbidden: 403,
  save_limit_reached: 403,
  sample_limit_reached: 403,
  not_found: 404,
  conflict: 409,
  not_listed: 409,
  share_rejected: 409,
  sample_in_use: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  budget_exhausted: 429,
  server_misconfigured: 500,
  internal: 500,
  assistant_failed: 502,
  assistant_unavailable: 503,
  assistant_busy: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; current?: SaveMeta | null };
}

/** Thrown inside handlers; turned into a JSON error response by the app's error handler. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly current: SaveMeta | null | undefined;

  constructor(code: ErrorCode, message: string, current?: SaveMeta | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.current = current;
  }

  get status(): ErrorStatus {
    return ERROR_STATUS[this.code];
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: { code: this.code, message: this.message } };
    if (this.current !== undefined) body.error.current = this.current;
    return body;
  }
}
