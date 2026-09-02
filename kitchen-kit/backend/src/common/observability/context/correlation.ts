import { newId } from '../../ids';

export const CORRELATION_HEADER = 'x-correlation-id';
export const CAUSATION_HEADER = 'x-causation-id';

/**
 * Bounded, validated identifier format for an inbound correlation/causation
 * header. Deliberately narrow: letters, digits, `.`, `_`, `-` only, 1-128
 * characters. This rejects CR/LF and every other control character by
 * construction (they are simply not in the allowed alphabet) and caps length
 * so an unbounded caller-supplied string can never reach a log line or a
 * metric label.
 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Extract a single header value as a plain string, or `undefined`. Express
 * lower-cases header names and returns an array only for a header sent
 * multiple times; a multi-value correlation header is treated as absent
 * rather than guessing which occurrence to trust.
 */
function singleHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * Resolve the effective correlation id for a request: the inbound header when
 * it is present and valid, otherwise a freshly server-generated id. A
 * present-but-malformed header is silently replaced (never echoed back,
 * never logged) rather than rejecting the request — correlation is an
 * observability aid, not an API contract the caller can break.
 */
export function resolveCorrelationId(
  headerValue: string | string[] | undefined,
): string {
  const candidate = singleHeaderValue(headerValue);
  if (candidate && ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return newId();
}

/**
 * Resolve the effective causation id for a request. Unlike correlation, there
 * is no server fallback: a root HTTP request genuinely has no prior cause
 * this layer can honestly name, so an absent/malformed header resolves to
 * `null` rather than inventing a false causal link (SRS §27.6 NFR-OBS-001 —
 * causation must be honest, not merely present).
 */
export function resolveCausationId(
  headerValue: string | string[] | undefined,
): string | null {
  const candidate = singleHeaderValue(headerValue);
  if (candidate && ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return null;
}
