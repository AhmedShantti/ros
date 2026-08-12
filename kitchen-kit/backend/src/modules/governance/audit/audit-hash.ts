import { createHash } from 'node:crypto';
import { AuditActorType } from './audit.constants';

/**
 * Deterministic JSON: keys are sorted recursively, so the canonical form does
 * not depend on object property insertion/iteration order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

// Any key whose name matches is a secret and is redacted before hashing/storage.
const FORBIDDEN_KEY =
  /pass|secret|token|hash|authorization|cookie|fingerprint|api[_-]?key|refresh|credential|mfa|bearer/i;

/** Defense-in-depth: redact secret-looking keys from caller-supplied metadata. */
export function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = FORBIDDEN_KEY.test(key) ? '[REDACTED]' : sanitizeMetadata(val);
    }
    return out;
  }
  return value;
}

export interface HashableEntry {
  tenantId: string;
  sequenceNo: bigint;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  terminalId: string | null;
  reasonCode: string | null;
  beforeState: unknown;
  afterState: unknown;
  correlationId: string;
}

/**
 * entry_hash = SHA-256 over a stable canonical representation of the entry's
 * meaningful fields plus the previous entry's hash. Sensitive values are never
 * present (metadata is already sanitized). Returns a Uint8Array for the BYTEA
 * column (Prisma Bytes).
 */
export function computeEntryHash(
  entry: HashableEntry,
  previousHash: Uint8Array | null,
): ReturnType<Uint8Array['slice']> {
  const canonical = stableStringify({
    tenantId: entry.tenantId,
    sequenceNo: entry.sequenceNo.toString(),
    occurredAt: entry.occurredAt.toISOString(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    terminalId: entry.terminalId,
    reasonCode: entry.reasonCode,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
    correlationId: entry.correlationId,
    previousHash: previousHash
      ? Buffer.from(previousHash).toString('hex')
      : null,
  });
  const digest = createHash('sha256').update(canonical).digest();
  // .slice() yields ReturnType<Uint8Array['slice']>, exactly Prisma's Bytes type.
  return new Uint8Array(digest).slice();
}
