import { computeEntryHash, HashableEntry } from './audit-hash';
import { verifyAuditChain, VerifiableAuditEntry } from './audit-verify';

function entry(seq: bigint, action: string): HashableEntry {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    sequenceNo: seq,
    occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    actorType: 'user',
    actorId: 'u-1',
    action,
    entityType: 'user',
    entityId: 'u-1',
    terminalId: null,
    reasonCode: null,
    beforeState: null,
    afterState: { result: 'success' },
    correlationId: `c-${seq}`,
  };
}

/** Build a valid, hash-linked chain the way AuditService.record would. */
function buildChain(actions: string[]): VerifiableAuditEntry[] {
  const rows: VerifiableAuditEntry[] = [];
  let previousHash: Uint8Array | null = null;
  actions.forEach((action, i) => {
    const base = entry(BigInt(i + 1), action);
    const entryHash = computeEntryHash(base, previousHash);
    rows.push({ ...base, entryHash, previousHash });
    previousHash = entryHash;
  });
  return rows;
}

describe('verifyAuditChain', () => {
  it('accepts a valid, consecutive, hash-linked chain', () => {
    const chain = buildChain(['LOGIN_SUCCESS', 'LOGOUT', 'LOGIN_SUCCESS']);
    expect(verifyAuditChain(chain)).toEqual({ valid: true });
  });

  it('accepts an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ valid: true });
  });

  it('detects content tampering (a mutated field without a rehash)', () => {
    const chain = buildChain(['LOGIN_SUCCESS', 'ROLE_ASSIGNED', 'LOGOUT']);
    // Tamper the action of the middle row but keep its stored entry_hash.
    chain[1] = { ...chain[1], action: 'PRIVILEGE_ESCALATION' };
    const verdict = verifyAuditChain(chain);
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAtSequenceNo).toBe(2n);
    expect(verdict.reason).toMatch(/content tampered/);
  });

  it('detects a broken previous-hash linkage', () => {
    const chain = buildChain(['LOGIN_SUCCESS', 'LOGOUT']);
    chain[1] = { ...chain[1], previousHash: new Uint8Array(32).fill(7) };
    const verdict = verifyAuditChain(chain);
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAtSequenceNo).toBe(2n);
    expect(verdict.reason).toMatch(/link/);
  });

  it('detects a deleted entry (sequence gap)', () => {
    const chain = buildChain(['A', 'B', 'C']);
    chain.splice(1, 1); // remove seq 2 → remaining are seq 1,3
    const verdict = verifyAuditChain(chain);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/sequence/);
  });

  it('detects a bad genesis (first previous_hash not null)', () => {
    const chain = buildChain(['A']);
    chain[0] = { ...chain[0], previousHash: new Uint8Array(32).fill(1) };
    expect(verifyAuditChain(chain).valid).toBe(false);
  });
});
