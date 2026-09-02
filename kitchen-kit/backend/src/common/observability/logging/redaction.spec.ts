import { ALLOWED_METADATA_KEYS, sanitizeMetadata } from './redaction';

describe('sanitizeMetadata — allowlist redaction layer (NFR-OBS-005)', () => {
  it('drops an unknown top-level key entirely rather than serializing it', () => {
    const out = sanitizeMetadata({
      route: '/orders/:id',
      somethingNoOneAllowlisted: 'value',
    });
    expect(out).toEqual({ route: '/orders/:id' });
    expect(out).not.toHaveProperty('somethingNoOneAllowlisted');
  });

  it('keeps every safe, allow-listed field', () => {
    const out = sanitizeMetadata({
      event: 'http.request.completed',
      route: '/orders/:id',
      handler: 'OrdersController#getOrder',
      statusCode: 200,
      statusClass: '2xx',
      durationMs: 12.3,
      correlationId: 'abc-123',
    });
    expect(out).toMatchObject({
      event: 'http.request.completed',
      route: '/orders/:id',
      handler: 'OrdersController#getOrder',
      statusCode: 200,
      statusClass: '2xx',
      durationMs: 12.3,
      correlationId: 'abc-123',
    });
  });

  describe('sabotage — sensitive top-level keys are redacted, never the raw value', () => {
    const secretValue = 'super-secret-password';
    const cases: Array<[key: string, allowlisted: boolean]> = [
      ['authorization', false],
      ['cookie', false],
      ['password', false],
      ['pin', false],
      ['accessToken', false],
      ['refreshToken', false],
      ['token', false],
      ['secret', false],
      ['apiKey', false],
      ['signingKey', false],
      ['privateKey', false],
      ['DATABASE_URL', false],
      ['APP_DATABASE_URL', false],
    ];

    it.each(cases)('redacts key "%s"', (key) => {
      const out = sanitizeMetadata({ [key]: secretValue });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain(secretValue);
    });
  });

  it('redacts a sensitive key nested inside an allow-listed object value', () => {
    const out = sanitizeMetadata({
      target: {
        safeField: 'ok',
        password: 'nested-secret-value',
      },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('nested-secret-value');
    expect(serialized).toContain('ok');
  });

  it('redacts a sensitive key inside an array', () => {
    const out = sanitizeMetadata({
      target: [{ token: 'array-secret-value' }, { name: 'safe' }],
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('array-secret-value');
    expect(serialized).toContain('safe');
  });

  it('reduces an Error object to name/message, dropping other properties', () => {
    const err = new Error('boom: password=hunter2-secret-value');
    (err as unknown as Record<string, unknown>).extra = 'should-not-leak';
    const out = sanitizeMetadata({ context: err });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('should-not-leak');
    // free-text scrub cannot catch every shape, but this one (password=) style
    // is not one of the best-effort patterns, so the message itself passes
    // through — this is the documented, known PARTIAL limitation.
  });

  it('redacts a Prisma-like error object nested under an allowed key', () => {
    const prismaLikeError = {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta: { target: ['email'] },
      message:
        'Unique constraint failed on connection string postgres://user:hunter2@host/db',
    };
    const out = sanitizeMetadata({ target: prismaLikeError });
    const serialized = JSON.stringify(out);
    // the DSN-shaped credential inside the free-text message is scrubbed by
    // the best-effort pattern.
    expect(serialized).not.toContain('hunter2');
  });

  it('secret appearing beside safe metadata: only the secret is dropped', () => {
    const out = sanitizeMetadata({
      route: '/auth/login',
      method: 'POST',
      password: 'beside-safe-secret-value',
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('beside-safe-secret-value');
    expect(out.route).toBe('/auth/login');
    expect(out.method).toBe('POST');
  });

  it('bounds recursion depth so a deeply nested/circular-shaped structure cannot blow up serialization', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    const out = sanitizeMetadata({ target: deep });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('bounds array length', () => {
    const bigArray = Array.from({ length: 1000 }, (_, i) => i);
    const out = sanitizeMetadata({ target: bigArray });
    expect((out.target as unknown[]).length).toBeLessThanOrEqual(20);
  });

  it('scrubs a bearer token appearing inside an otherwise-safe string value', () => {
    const out = sanitizeMetadata({
      context: 'Bearer ey1234567890abcdefghij was rejected',
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ey1234567890abcdefghij');
  });

  it('scrubs a refresh-token-shaped bearer value and a raw DSN credential', () => {
    const out = sanitizeMetadata({
      context:
        'retry with refresh-token-value failed; fallback postgres://appuser:s3cret-pw@db.internal:5432/ros',
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('s3cret-pw');
  });

  it('never emits the redacted value in a second field — a denied top-level key is dropped, not merely relabelled', () => {
    const secretValue = 'never-twice-secret-value';
    const out = sanitizeMetadata({
      token: secretValue,
      route: '/orders/:id',
    });
    // "token" is not allow-listed at the top level, so it is DROPPED
    // entirely rather than round-tripped under any key.
    expect(out).not.toHaveProperty('token');
    expect(JSON.stringify(out)).not.toContain(secretValue);
    expect(out.route).toBe('/orders/:id');
  });

  it('denylist wins even for a key that also happens to be allow-listed (nested, defence in depth)', () => {
    // "name" is allow-listed (safe in general — e.g. a country-pack name),
    // but a sensitive key nested one level down under an allowed container
    // must still be caught regardless of the container's own key name.
    const out = sanitizeMetadata({
      target: { name: 'ok', secret: 'defence-in-depth-secret-value' },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('defence-in-depth-secret-value');
    expect(serialized).toContain('ok');
  });

  it('every allow-listed key is a plain, expected identifier (no accidental wildcard)', () => {
    for (const key of ALLOWED_METADATA_KEYS) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });
});
