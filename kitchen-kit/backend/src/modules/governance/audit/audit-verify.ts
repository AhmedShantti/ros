import { computeEntryHash, HashableEntry } from './audit-hash';

/**
 * A stored audit row as needed for chain verification: the hashed fields plus
 * the persisted `entryHash` / `previousHash`. (Matches the columns written by
 * AuditService.record and readable back from governance.audit_entries.)
 */
export interface VerifiableAuditEntry extends HashableEntry {
  entryHash: Uint8Array;
  previousHash: Uint8Array | null;
}

export interface AuditChainVerdict {
  valid: boolean;
  /** 1-based sequence position where verification first failed, if any. */
  brokenAtSequenceNo?: bigint;
  reason?: string;
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Recompute and validate a single tenant's audit hash chain. This is an
 * internal, read-only verification utility (test / offline / ops use) — it is
 * intentionally NOT exposed as an HTTP endpoint. `entries` must be for one
 * tenant, ordered by ascending `sequenceNo`.
 *
 * Detects: content tampering (recomputed `entryHash` mismatch), broken linkage
 * (`previousHash` not equal to the prior `entryHash`), a bad genesis, and
 * sequence gaps/duplicates.
 */
export function verifyAuditChain(
  entries: VerifiableAuditEntry[],
): AuditChainVerdict {
  let previousHash: Uint8Array | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const expectedSeq = BigInt(i + 1);
    if (e.sequenceNo !== expectedSeq) {
      return {
        valid: false,
        brokenAtSequenceNo: e.sequenceNo,
        reason: `sequence gap/disorder: expected ${expectedSeq}, got ${e.sequenceNo}`,
      };
    }
    if (!bytesEqual(e.previousHash, previousHash)) {
      return {
        valid: false,
        brokenAtSequenceNo: e.sequenceNo,
        reason: 'previous_hash does not link to the prior entry',
      };
    }
    const recomputed = computeEntryHash(e, previousHash);
    if (!bytesEqual(recomputed, e.entryHash)) {
      return {
        valid: false,
        brokenAtSequenceNo: e.sequenceNo,
        reason:
          'entry_hash does not match the recomputed hash (content tampered)',
      };
    }
    previousHash = e.entryHash;
  }
  return { valid: true };
}
