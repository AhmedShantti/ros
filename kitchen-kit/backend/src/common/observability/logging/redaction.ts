/**
 * Central log sanitisation/redaction layer — SRS §27.6 NFR-OBS-005: "No PII or
 * secrets in logs, enforced by a redaction layer with an allowlist."
 *
 * ── ALLOWLIST IS THE PRIMARY CONTROL ─────────────────────────────────────────
 * `sanitizeMetadata()` walks an arbitrary metadata object and keeps ONLY keys
 * present in {@link ALLOWED_METADATA_KEYS}. Every other key is DROPPED, not
 * merely hidden — it never reaches `JSON.stringify`. This is deliberately the
 * inverse of a blocklist: a brand-new field a future call site adds is UNSAFE
 * BY DEFAULT until someone explicitly allow-lists it, which is the property
 * NFR-OBS-005 asks for ("enforced by ... an allowlist").
 *
 * A denylist of sensitive KEY NAMES still exists ({@link SENSITIVE_KEY_PATTERN})
 * as defence in depth: it blocks a key even if it were ever added to the
 * allowlist by mistake, and it also catches sensitive keys nested inside an
 * allowed object value (e.g. an allowed `error` object whose own property
 * happens to be `password`). It is not the primary control and must never be
 * relied on alone.
 *
 * ── KNOWN LIMITATION (documented, not silently absorbed) ────────────────────
 * This layer sanitises STRUCTURED metadata objects. It cannot inspect the
 * semantic content of a free-form string value for a secret unless that value
 * matches one of the best-effort {@link FREE_TEXT_SECRET_PATTERNS} scrub rules
 * applied to every retained string. A developer who interpolates a secret
 * directly into a message string in a way that pattern cannot recognise can
 * still leak it. That is exactly why NFR-OBS-005 is reported PARTIAL, not
 * COMPLETE, in the accompanying report — see that report's disposition
 * section for the full reasoning.
 */

/** Keys a call site is permitted to attach to a structured log line's `meta`. */
export const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'method',
  'route',
  'handler',
  'statusCode',
  'statusClass',
  'durationMs',
  'errorCode',
  'exceptionClass',
  'errorName',
  'errorMessage',
  'context',
  'trace',
  'event',
  'reason',
  'count',
  'tenantId',
  'branchId',
  'correlationId',
  'causationId',
  'userId',
  'sessionId',
  'membershipId',
  'terminalId',
  'code',
  'query',
  'target',
  'name',
  // ── SCHED-1 scheduled-job execution ────────────────────────────────────
  // All five are server-derived, bounded-shape identifiers of a scheduled
  // occurrence — never payload, never user input. `jobType` comes from the
  // handler registry, `occurrenceKey` is a `YYYY-MM-DDTHH:MM` slot, `attempt`
  // and `lagMs` are integers, `outcome` is the closed `SCHEDULED_JOB_OUTCOME`
  // vocabulary. They are allow-listed for LOGS only; the metric label set is
  // narrower still (see `ScheduledJobMetricLabels`).
  'jobType',
  'occurrenceKey',
  'attempt',
  'outcome',
  'lagMs',
]);

/**
 * Sensitive key names, matched case-insensitively and REGARDLESS of nesting
 * depth. A key matching this pattern is redacted even if it also appears in
 * {@link ALLOWED_METADATA_KEYS} — the denylist wins over the allowlist.
 */
const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|cookies|password|pin|pins|access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key|signing[_-]?key|private[_-]?key|signature|database_url|app_database_url|jwt|credentials?|clientsecret)$/i;

/** Best-effort scrub for common credential shapes inside otherwise-safe strings. */
const FREE_TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /bearer\s+[a-z0-9._-]{10,}/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s'"]+/gi, // scheme://user:pass@host DSNs
  /eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/gi, // JWT-shaped
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;
const MAX_KEYS_PER_OBJECT = 40;

function scrubFreeText(value: string): string {
  let scrubbed = value;
  for (const pattern of FREE_TEXT_SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return scrubFreeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  if (value instanceof Error) {
    return {
      errorName: value.name,
      errorMessage: scrubFreeText(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (count >= MAX_KEYS_PER_OBJECT) break;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeValue(inner, depth + 1);
      }
      count += 1;
    }
    return out;
  }

  // function, symbol, bigint, etc. — never serialize.
  return '[UNSUPPORTED]';
}

/**
 * Sanitise a top-level metadata object for the structured logger. Unknown
 * top-level keys are DROPPED (allowlist). Known keys still pass through the
 * denylist + depth/size bounding on their VALUE, since a permitted key
 * (`error`, say) can carry an attacker- or bug-shaped nested secret.
 */
export function sanitizeMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue; // drop, do not serialize
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue(value, 0);
  }
  return out;
}
