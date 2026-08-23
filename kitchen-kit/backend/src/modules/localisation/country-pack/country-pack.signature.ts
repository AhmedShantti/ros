/**
 * Country Pack signature verification — FR-LOC-022, FR-LOC-031.
 *
 * ── THE RATIFIED v1 SCHEME (carried item P1C-3, 2026-08-20) ────────────────
 *
 *   algorithm          Ed25519, and for v1 the envelope MUST say exactly that
 *   canonical payload  RFC 8785 JSON Canonicalization Scheme (JCS)
 *   signature encoding base64url
 *   envelope           { keyId, algorithm, signature }
 *   signed bytes       the JCS canonical form of the COMPLETE pack payload with
 *                      ONLY the signature envelope excluded
 *
 * The envelope is excluded from what it signs — signature metadata can never be
 * recursively part of its own input, which would be unsatisfiable.
 *
 * ── WHY JCS AND NOT THE AUDIT CANONICALISER ────────────────────────────────
 * `stableStringify` (governance/audit/audit-hash) sorts keys and is perfectly
 * good for a hash chain we both produce and consume. It is NOT a signing
 * protocol: it has no defined number form, no defined string escaping and no
 * specification an external signer could implement against. A pack is signed
 * OUTSIDE this runtime, by tooling that must agree byte-for-byte, so the
 * canonical form has to be a published standard. RFC 8785 is that standard, and
 * the implementation used is its reference implementation.
 *
 * ── TRUST MODEL ────────────────────────────────────────────────────────────
 * Verification uses trusted release PUBLIC keys only. There is no signing key in
 * the database, the runtime secret set, this repository, or any committed
 * fixture — grep-verified, and there is no code path that could use one because
 * no signing function exists. Tests generate ephemeral key pairs in memory.
 *
 * Every one of these fails CLOSED: unsigned · unknown keyId · revoked key ·
 * wrong key · bad signature · payload modified after signing · malformed
 * base64url · malformed envelope · algorithm other than Ed25519 · no trusted key
 * configured · malformed trust configuration.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * The signature envelope carried by a pack bundle — exactly the three ratified
 * members. Anything else in the block is ignored; anything missing makes the
 * pack unsigned.
 */
export interface CountryPackSignature {
  /** v1: MUST be the literal `Ed25519`. */
  readonly algorithm: string;
  /** Names the release key in the trust store. */
  readonly keyId: string;
  /** base64url, no padding — 64 raw bytes for Ed25519. */
  readonly signature: string;
}

/** What the verifier is asked to attest. */
export interface CountryPackSignatureInput {
  readonly code: string;
  readonly version: string;
  /** The pack document with the `signature` envelope removed. */
  readonly document: unknown;
  /** RFC 8785 canonical UTF-8 bytes of {@link document}. THE signed bytes. */
  readonly canonicalBytes: Uint8Array;
  /** `null` when the bundle carried no usable envelope at all. */
  readonly signature: CountryPackSignature | null;
}

export interface CountryPackSignatureVerifier {
  /**
   * Return `true` only for a pack signed by an authorised, non-revoked release
   * key. An implementation MUST return `false` (or throw) in every other case,
   * and must never return `true` as a default.
   */
  verify(input: CountryPackSignatureInput): boolean | Promise<boolean>;
}

/** DI token for the verifier port. */
export const COUNTRY_PACK_SIGNATURE_VERIFIER = Symbol(
  'COUNTRY_PACK_SIGNATURE_VERIFIER',
);

/**
 * Refuse everything.
 *
 * Retained as the explicit fail-closed fallback, not as a placeholder: it is
 * what a deployment gets if its trust configuration is missing or malformed, and
 * what the unit tests assert against. It is never "upgraded" to return `true`.
 */
export class DenyAllCountryPackSignatureVerifier implements CountryPackSignatureVerifier {
  verify(): boolean {
    return false;
  }
}

/** Raised when a document cannot be canonicalised at all. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/**
 * RFC 8785 canonical UTF-8 bytes.
 *
 * JCS fixes key ordering (by UTF-16 code unit), number form (ECMAScript
 * shortest round-trip) and string escaping, so an external signer and this
 * verifier produce identical bytes for identical JSON — including when the two
 * emit their object members in different orders.
 *
 * `undefined`, functions and symbols are not JSON and make the result
 * `undefined`; that is a malformed payload, not an empty one, so it throws.
 */
export function canonicalCountryPackBytes(document: unknown): Uint8Array {
  const canonical = canonicalize(document);
  if (typeof canonical !== 'string') {
    throw new CanonicalizationError(
      'The pack payload is not canonicalisable JSON.',
    );
  }
  return new Uint8Array(Buffer.from(canonical, 'utf8'));
}

/** Strip the signature envelope without mutating the caller's document. */
export function stripSignature(document: unknown): unknown {
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    return document;
  }
  const copy = { ...(document as Record<string, unknown>) };
  delete copy.signature;
  return copy;
}

/**
 * Read the `signature` envelope.
 *
 * Returns `null` for an absent envelope AND for a structurally invalid one —
 * both are "unsigned or invalidly-signed" as far as FR-LOC-022 is concerned, and
 * the activation gate rejects both identically. Distinguishing them in the
 * response would only tell an attacker how far they got.
 */
export function readSignature(document: unknown): CountryPackSignature | null {
  if (document === null || typeof document !== 'object') return null;
  const raw = (document as Record<string, unknown>).signature;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return null;
  const { algorithm, keyId, signature } = raw as Record<string, unknown>;
  if (
    typeof algorithm !== 'string' ||
    algorithm.length === 0 ||
    typeof keyId !== 'string' ||
    keyId.length === 0 ||
    typeof signature !== 'string' ||
    signature.length === 0
  ) {
    return null;
  }
  return { algorithm, keyId, signature };
}

// --------------------------------------------------------------- trust store

/** The only algorithm v1 accepts. */
export const COUNTRY_PACK_SIGNATURE_ALGORITHM = 'Ed25519';

export type TrustedKeyStatus = 'active' | 'revoked';

/**
 * A trusted release PUBLIC key.
 *
 * A revoked key is RETAINED rather than deleted. FR-LOC-021 requires historical
 * transactions to stay interpretable under the pack version they were priced
 * with, which means historical packs must stay verifiable; deleting the key
 * would make a past pack unreadable rather than merely unusable for new
 * activation.
 */
export interface TrustedReleaseKey {
  readonly keyId: string;
  readonly algorithm: string;
  /** Raw 32-byte Ed25519 public key, base64url. NEVER a private key. */
  readonly publicKey: string;
  readonly status: TrustedKeyStatus;
}

export interface CountryPackTrustStore {
  /** `null` for an unknown key id. Revoked keys ARE returned, marked revoked. */
  find(keyId: string): TrustedReleaseKey | null;
  /** 0 means "nothing is trusted", which makes every verification fail. */
  readonly size: number;
}

/** DI token for the trust-store port. */
export const COUNTRY_PACK_TRUST_STORE = Symbol('COUNTRY_PACK_TRUST_STORE');

/** A store that trusts nothing. The fail-closed default. */
export class EmptyCountryPackTrustStore implements CountryPackTrustStore {
  find(): TrustedReleaseKey | null {
    return null;
  }
  readonly size = 0;
}

/** Build an in-memory store from already-validated key material. */
export class InMemoryCountryPackTrustStore implements CountryPackTrustStore {
  private readonly byId: ReadonlyMap<string, TrustedReleaseKey>;

  constructor(keys: readonly TrustedReleaseKey[]) {
    const map = new Map<string, TrustedReleaseKey>();
    for (const key of keys) {
      if (map.has(key.keyId)) {
        throw new Error(
          `Duplicate trusted key id ${JSON.stringify(key.keyId)}.`,
        );
      }
      map.set(key.keyId, key);
    }
    this.byId = map;
  }

  find(keyId: string): TrustedReleaseKey | null {
    return this.byId.get(keyId) ?? null;
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * Parse a trust manifest.
 *
 * Rejects a private key outright. A manifest is deployment configuration and a
 * human writes it; if someone pastes a private key into it, the correct response
 * is to refuse loudly, not to quietly use the half of it that happens to work.
 *
 * @throws Error on any malformed entry. The caller fails closed.
 */
export function parseTrustManifest(raw: unknown): TrustedReleaseKey[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A trust manifest must be an object.');
  }
  const keys = (raw as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) {
    throw new Error('A trust manifest must carry a "keys" array.');
  }
  return keys.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`keys[${i}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    for (const forbidden of ['privateKey', 'secretKey', 'd', 'seed']) {
      if (forbidden in e) {
        throw new Error(
          `keys[${i}] carries private key material. A trust manifest holds ` +
            'PUBLIC release keys only; signing never happens in this runtime.',
        );
      }
    }
    const { keyId, algorithm, publicKey, status } = e;
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw new Error(`keys[${i}].keyId must be a non-empty string.`);
    }
    if (algorithm !== COUNTRY_PACK_SIGNATURE_ALGORITHM) {
      throw new Error(
        `keys[${i}].algorithm must be ${COUNTRY_PACK_SIGNATURE_ALGORITHM}.`,
      );
    }
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      throw new Error(`keys[${i}].publicKey must be a base64url string.`);
    }
    if (status !== 'active' && status !== 'revoked') {
      throw new Error(`keys[${i}].status must be "active" or "revoked".`);
    }
    // Reject unusable key material at LOAD time rather than at first sale.
    decodeEd25519PublicKey(publicKey, `keys[${i}].publicKey`);
    return { keyId, algorithm, publicKey, status };
  });
}

// ------------------------------------------------------------------- crypto

/**
 * The fixed SPKI DER prefix for an Ed25519 public key (RFC 8410).
 *
 * Node's `createPublicKey` needs a structured key; the manifest carries the raw
 * 32 bytes because that is what every Ed25519 tool emits. Prepending the known
 * 12-byte header is exact and reversible — there is nothing to guess.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Strict base64url decode. Rejects standard-base64 characters and padding. */
export function decodeBase64Url(value: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${what} is not base64url.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  // Node's decoder is lenient; re-encoding proves the input was canonical.
  if (decoded.toString('base64url') !== value) {
    throw new Error(`${what} is not canonical base64url.`);
  }
  return decoded;
}

function decodeEd25519PublicKey(value: string, what: string): Buffer {
  const raw = decodeBase64Url(value, what);
  if (raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES) {
    throw new Error(
      `${what} must decode to ${ED25519_RAW_PUBLIC_KEY_BYTES} raw bytes.`,
    );
  }
  return raw;
}

/**
 * The concrete v1 verifier.
 *
 * Every rejection path returns `false`. None of them reports WHICH check failed
 * to the caller: the activation gate turns any `false` into one message, so a
 * probe cannot learn whether a key id exists, whether it is revoked, or how the
 * signature was wrong.
 */
export class Ed25519CountryPackSignatureVerifier implements CountryPackSignatureVerifier {
  constructor(private readonly trust: CountryPackTrustStore) {}

  verify(input: CountryPackSignatureInput): boolean {
    const envelope = input.signature;
    if (!envelope) return false;
    if (envelope.algorithm !== COUNTRY_PACK_SIGNATURE_ALGORITHM) return false;
    // Nothing is trusted -> nothing verifies. Stated explicitly so an empty
    // trust store can never be read as "no constraint".
    if (this.trust.size === 0) return false;

    const key = this.trust.find(envelope.keyId);
    if (!key) return false;
    if (key.status !== 'active') return false;
    if (key.algorithm !== COUNTRY_PACK_SIGNATURE_ALGORITHM) return false;

    let signature: Buffer;
    let publicKey: Buffer;
    try {
      signature = decodeBase64Url(envelope.signature, 'signature');
      publicKey = decodeEd25519PublicKey(key.publicKey, 'publicKey');
    } catch {
      return false;
    }
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;

    try {
      const keyObject = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
        format: 'der',
        type: 'spki',
      });
      // Ed25519 takes no separate digest algorithm; `null` is required here.
      return cryptoVerify(null, input.canonicalBytes, keyObject, signature);
    } catch {
      // A malformed key or signature reaching the primitive is a rejection, not
      // an error to surface: the message could disclose key material.
      return false;
    }
  }
}
