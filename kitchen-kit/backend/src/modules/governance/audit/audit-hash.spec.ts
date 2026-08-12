import {
  computeEntryHash,
  HashableEntry,
  sanitizeMetadata,
  stableStringify,
} from './audit-hash';

function baseEntry(overrides: Partial<HashableEntry> = {}): HashableEntry {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    sequenceNo: 1n,
    occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    actorType: 'user',
    actorId: 'u-1',
    action: 'LOGIN_SUCCESS',
    entityType: 'user',
    entityId: 'u-1',
    terminalId: null,
    reasonCode: null,
    beforeState: null,
    afterState: { result: 'success' },
    correlationId: 'c-1',
    ...overrides,
  };
}

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(
      stableStringify({ a: 2, b: 1 }),
    );
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(
      stableStringify({ a: { x: 2, y: 1 } }),
    );
  });
});

describe('sanitizeMetadata', () => {
  it('redacts secret-looking keys recursively', () => {
    const out = sanitizeMetadata({
      sessionId: 's-1',
      password: 'p',
      refreshToken: 'rt',
      nested: { secret: 'x', ok: 1, api_key: 'k' },
    }) as Record<string, unknown>;
    expect(out.sessionId).toBe('s-1');
    expect(out.password).toBe('[REDACTED]');
    expect(out.refreshToken).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.secret).toBe('[REDACTED]');
    expect(nested.api_key).toBe('[REDACTED]');
    expect(nested.ok).toBe(1);
  });
});

describe('computeEntryHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeEntryHash(baseEntry(), null);
    const b = computeEntryHash(baseEntry(), null);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a).toHaveLength(32); // sha256
  });

  it('changes when the previous hash changes (chain linkage)', () => {
    const prev = computeEntryHash(baseEntry(), null);
    const withPrev = computeEntryHash(baseEntry({ sequenceNo: 2n }), prev);
    const withoutPrev = computeEntryHash(baseEntry({ sequenceNo: 2n }), null);
    expect(Buffer.from(withPrev).equals(Buffer.from(withoutPrev))).toBe(false);
  });

  it('changes when a meaningful field changes', () => {
    const a = computeEntryHash(baseEntry(), null);
    const b = computeEntryHash(baseEntry({ action: 'LOGIN_FAILURE' }), null);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
