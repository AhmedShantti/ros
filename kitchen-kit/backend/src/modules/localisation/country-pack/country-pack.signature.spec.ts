import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makePackDocument } from './country-pack.fixture';
import {
  COUNTRY_PACK_SIGNATURE_ALGORITHM,
  DenyAllCountryPackSignatureVerifier,
  Ed25519CountryPackSignatureVerifier,
  EmptyCountryPackTrustStore,
  canonicalCountryPackBytes,
  decodeBase64Url,
  parseTrustManifest,
  readSignature,
  stripSignature,
} from './country-pack.signature';
import type { TrustedReleaseKey } from './country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './country-pack.signing.fixture';

/**
 * FR-LOC-022 — the concrete v1 scheme ratified as carried item P1C-3:
 * Ed25519 over RFC-8785 (JCS) canonical bytes, base64url encoded, verified
 * against trusted release PUBLIC keys.
 */

const RELEASE = generateReleaseKey('ros-release-2026');
const OTHER = generateReleaseKey('someone-elses-key');

const verifierTrusting = (...keys: TrustedReleaseKey[]) =>
  new Ed25519CountryPackSignatureVerifier(trustStoreFor(...keys));

/** Build the verifier input the registry would construct. */
function inputFor(document: Record<string, unknown>) {
  const payload = stripSignature(document);
  return {
    code: String(document.code),
    version: String(document.version),
    document: payload,
    canonicalBytes: canonicalCountryPackBytes(payload),
    signature: readSignature(document),
  };
}

describe('RFC 8785 canonicalization', () => {
  it('is independent of member order', () => {
    const a = canonicalCountryPackBytes({
      b: 1,
      a: 'x',
      z: [3, { d: true, c: null }],
    });
    const b = canonicalCountryPackBytes({
      z: [3, { c: null, d: true }],
      a: 'x',
      b: 1,
    });
    expect(Buffer.from(a).toString('utf8')).toBe(
      Buffer.from(b).toString('utf8'),
    );
  });

  it('produces the RFC 8785 sorted, minimal form', () => {
    const bytes = canonicalCountryPackBytes({ b: 1, a: 'x' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('{"a":"x","b":1}');
  });

  it('distinguishes a number from the string that looks like it', () => {
    // The signature must not survive a type change that alters meaning.
    const asNumber = canonicalCountryPackBytes({ exponent: 2 });
    const asString = canonicalCountryPackBytes({ exponent: '2' });
    expect(Buffer.from(asNumber).toString('utf8')).not.toBe(
      Buffer.from(asString).toString('utf8'),
    );
  });

  it('rejects a payload that is not canonicalisable JSON', () => {
    expect(() => canonicalCountryPackBytes(undefined)).toThrow(
      /not canonicalisable/,
    );
  });

  it('is NOT the audit-chain canonicaliser', () => {
    // stableStringify would emit the same bytes for this payload, which is
    // exactly why the check is structural: the signing path must IMPORT the
    // RFC 8785 implementation and must not import the audit canonicaliser.
    // (The file mentions `stableStringify` in prose, explaining the refusal.)
    const source = readFileSync(
      join(__dirname, 'country-pack.signature.ts'),
      'utf8',
    );
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');
    expect(imports).not.toMatch(/stableStringify|audit-hash/);
    expect(imports).toMatch(/from 'canonicalize'/);
  });
});

describe('Signature envelope', () => {
  it('reads a well-formed envelope', () => {
    const doc = signPackDocument(makePackDocument(), RELEASE);
    const envelope = readSignature(doc);
    expect(envelope?.algorithm).toBe(COUNTRY_PACK_SIGNATURE_ALGORITHM);
    expect(envelope?.keyId).toBe('ros-release-2026');
    expect(envelope?.signature).toEqual(
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    );
  });

  it('treats a malformed envelope as unsigned', () => {
    for (const bad of [
      undefined,
      null,
      'nope',
      {},
      { algorithm: 'Ed25519' },
      { algorithm: 'Ed25519', keyId: 'k' },
      { algorithm: '', keyId: 'k', signature: 's' },
      { algorithm: 'Ed25519', keyId: 'k', signature: '' },
    ]) {
      expect(
        readSignature({ ...makePackDocument(), signature: bad }),
      ).toBeNull();
    }
  });

  it('excludes the envelope from the bytes it signs', () => {
    const doc = signPackDocument(makePackDocument(), RELEASE);
    expect(stripSignature(doc)).not.toHaveProperty('signature');
    expect(
      Buffer.from(canonicalCountryPackBytes(stripSignature(doc))).toString(
        'utf8',
      ),
    ).not.toContain('signature');
  });
});

describe('base64url decoding', () => {
  it('accepts unpadded base64url', () => {
    expect(decodeBase64Url('aGVsbG8', 'x').toString('utf8')).toBe('hello');
  });

  it('rejects standard base64 characters and padding', () => {
    expect(() => decodeBase64Url('a+b/c', 'x')).toThrow(/not base64url/);
    expect(() => decodeBase64Url('aGVsbG8=', 'x')).toThrow(/not base64url/);
  });

  it('rejects a non-canonical encoding', () => {
    expect(() => decodeBase64Url('aGVsbG9', 'x')).toThrow(/canonical/);
  });
});

describe('Ed25519 verification (FR-LOC-022)', () => {
  it('accepts a pack signed by an active trusted release key', () => {
    const verifier = verifierTrusting(RELEASE.trusted());
    expect(
      verifier.verify(inputFor(signPackDocument(makePackDocument(), RELEASE))),
    ).toBe(true);
  });

  it('verifies regardless of the member order the signer emitted', () => {
    // JCS is the point: a signer that serialises members in a different order
    // still produces bytes this verifier reproduces exactly.
    const original = makePackDocument();
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(original).reverse()) {
      reordered[key] = original[key];
    }
    const signed = signPackDocument(original, RELEASE);
    const shuffled = { ...reordered, signature: signed.signature };

    expect(verifierTrusting(RELEASE.trusted()).verify(inputFor(shuffled))).toBe(
      true,
    );
  });

  it('rejects an unsigned pack', () => {
    expect(
      verifierTrusting(RELEASE.trusted()).verify(inputFor(makePackDocument())),
    ).toBe(false);
  });

  it('rejects a payload modified after signing', () => {
    const signed = signPackDocument(makePackDocument(), RELEASE);
    const tax = { ...(signed.tax as Record<string, unknown>) };
    tax.classes = [{ code: 'standard', rate: '0.0' }];
    expect(
      verifierTrusting(RELEASE.trusted()).verify(inputFor({ ...signed, tax })),
    ).toBe(false);
  });

  it('rejects a payload whose number changed to a string', () => {
    const signed = signPackDocument(makePackDocument(), RELEASE);
    const currency = {
      ...(signed.currency as Record<string, unknown>),
      exponent: '2',
    };
    expect(
      verifierTrusting(RELEASE.trusted()).verify(
        inputFor({ ...signed, currency }),
      ),
    ).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const signed = signPackDocument(makePackDocument(), OTHER);
    // Same key id as the trusted one, bytes signed by another key.
    const forged = {
      ...signed,
      signature: {
        ...(signed.signature as Record<string, unknown>),
        keyId: RELEASE.keyId,
      },
    };
    expect(verifierTrusting(RELEASE.trusted()).verify(inputFor(forged))).toBe(
      false,
    );
  });

  it('rejects an unknown key id', () => {
    expect(
      verifierTrusting(RELEASE.trusted()).verify(
        inputFor(signPackDocument(makePackDocument(), OTHER)),
      ),
    ).toBe(false);
  });

  it('rejects a REVOKED key even though the signature is genuine', () => {
    const verifier = verifierTrusting(RELEASE.trusted('revoked'));
    expect(
      verifier.verify(inputFor(signPackDocument(makePackDocument(), RELEASE))),
    ).toBe(false);
  });

  it('rejects an algorithm other than Ed25519', () => {
    const signed = signPackDocument(makePackDocument(), RELEASE);
    const envelope = signed.signature as Record<string, unknown>;
    for (const algorithm of ['HS256', 'RS256', 'ed25519', 'none']) {
      expect(
        verifierTrusting(RELEASE.trusted()).verify(
          inputFor({ ...signed, signature: { ...envelope, algorithm } }),
        ),
      ).toBe(false);
    }
  });

  it('rejects a signature that is not valid base64url', () => {
    const signed = signPackDocument(makePackDocument(), RELEASE);
    const envelope = signed.signature as Record<string, unknown>;
    expect(
      verifierTrusting(RELEASE.trusted()).verify(
        inputFor({
          ...signed,
          signature: { ...envelope, signature: 'not+base64/url=' },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    const signed = signPackDocument(makePackDocument(), RELEASE);
    const envelope = signed.signature as Record<string, unknown>;
    expect(
      verifierTrusting(RELEASE.trusted()).verify(
        inputFor({
          ...signed,
          signature: { ...envelope, signature: 'aGVsbG8' },
        }),
      ),
    ).toBe(false);
  });

  it('fails closed when NOTHING is trusted', () => {
    const verifier = new Ed25519CountryPackSignatureVerifier(
      new EmptyCountryPackTrustStore(),
    );
    expect(
      verifier.verify(inputFor(signPackDocument(makePackDocument(), RELEASE))),
    ).toBe(false);
  });

  it('the deny-all verifier still refuses a genuinely signed pack', () => {
    expect(new DenyAllCountryPackSignatureVerifier().verify()).toBe(false);
  });
});

describe('Trust manifest', () => {
  it('parses a well-formed manifest', () => {
    const keys = parseTrustManifest({
      keys: [RELEASE.trusted(), OTHER.trusted('revoked')],
    });
    expect(keys).toHaveLength(2);
    expect(keys[1].status).toBe('revoked');
  });

  it('REFUSES a manifest carrying private key material', () => {
    for (const field of ['privateKey', 'secretKey', 'd', 'seed']) {
      expect(() =>
        parseTrustManifest({ keys: [{ ...RELEASE.trusted(), [field]: 'x' }] }),
      ).toThrow(/PUBLIC release keys only/);
    }
  });

  it('rejects an algorithm other than Ed25519', () => {
    expect(() =>
      parseTrustManifest({
        keys: [{ ...RELEASE.trusted(), algorithm: 'RS256' }],
      }),
    ).toThrow(/must be Ed25519/);
  });

  it('rejects an unusable public key at LOAD time, not at first sale', () => {
    expect(() =>
      parseTrustManifest({
        keys: [{ ...RELEASE.trusted(), publicKey: 'aGVsbG8' }],
      }),
    ).toThrow(/32 raw bytes/);
    expect(() =>
      parseTrustManifest({
        keys: [{ ...RELEASE.trusted(), publicKey: 'not valid!' }],
      }),
    ).toThrow(/base64url/);
  });

  it('rejects an unknown status', () => {
    expect(() =>
      parseTrustManifest({ keys: [{ ...RELEASE.trusted(), status: 'maybe' }] }),
    ).toThrow(/active.*revoked/);
  });

  it('rejects a structurally malformed manifest', () => {
    expect(() => parseTrustManifest(null)).toThrow(/must be an object/);
    expect(() => parseTrustManifest({})).toThrow(/"keys" array/);
    expect(() => parseTrustManifest({ keys: ['x'] })).toThrow(
      /must be an object/,
    );
  });

  it('rejects duplicate key ids', () => {
    expect(() => trustStoreFor(RELEASE.trusted(), RELEASE.trusted())).toThrow(
      /Duplicate trusted key id/,
    );
  });
});

describe('No signing capability exists in the runtime', () => {
  it('has no private key or signing call anywhere under src/', () => {
    const root = join(__dirname, '..', '..', '..');
    const offenders: string[] = [];
    const PRIVATE_MATERIAL =
      /BEGIN [A-Z ]*PRIVATE KEY|generateKeyPair|createSign\b|crypto\.sign\b|\bsign\(null/;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Generated Prisma client is vendored output, not repository source.
          if (entry.name === 'generated') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // Test support may hold an EPHEMERAL key for milliseconds in-process.
        if (
          entry.name.endsWith('.spec.ts') ||
          entry.name.endsWith('.fixture.ts')
        ) {
          continue;
        }
        if (PRIVATE_MATERIAL.test(readFileSync(path, 'utf8'))) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    };
    expect(statSync(root).isDirectory()).toBe(true);
    walk(root);

    expect(offenders).toEqual([]);
  });
});
