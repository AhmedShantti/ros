import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT = 'idempotent';

/**
 * Mark a POST/PATCH as idempotent — SRS §26.5.
 *
 * FR-API-020 makes `Idempotency-Key` MANDATORY on financially significant
 * endpoints, so a route carrying this decorator REQUIRES the header and rejects
 * the request without it. Non-financial routes may accept the header without
 * being annotated; they simply do not get replay protection.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);
