/**
 * TEST SUPPORT ONLY — ephemeral Ed25519 signing for pack fixtures.
 *
 * Key pairs are generated IN MEMORY, per test run. **No private release key is
 * committed to this repository, and none is ever written to disk.** That is the
 * whole reason this helper exists instead of a checked-in signed fixture: a
 * committed signed pack would need a committed key to have produced it, or would
 * rot the moment the payload changed.
 *
 * Nothing under `src/` outside a `.spec.ts` or the E2E suite imports this file.
 * There is no signing capability in the application runtime — this is the only
 * place in the repository that holds a private key at all, and it holds it for
 * milliseconds inside a test process.
 */

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  COUNTRY_PACK_SIGNATURE_ALGORITHM,
  InMemoryCountryPackTrustStore,
  TrustedKeyStatus,
  TrustedReleaseKey,
  canonicalCountryPackBytes,
  stripSignature,
} from './country-pack.signature';

/** SPKI DER header for Ed25519 (RFC 8410); the raw key is the trailing 32 bytes. */
const SPKI_PREFIX_BYTES = 12;

export interface EphemeralReleaseKey {
  readonly keyId: string;
  /** base64url raw public key — what a trust manifest carries. */
  readonly publicKey: string;
  /** Sign a pack payload the way release tooling would, outside the runtime. */
  sign(payload: unknown): string;
  trusted(status?: TrustedKeyStatus): TrustedReleaseKey;
}

/** Generate an ephemeral release key pair for one test. */
export function generateReleaseKey(keyId: string): EphemeralReleaseKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(spki).subarray(SPKI_PREFIX_BYTES);
  const publicKeyB64 = raw.toString('base64url');

  return {
    keyId,
    publicKey: publicKeyB64,
    sign(payload: unknown): string {
      // Exactly the ratified contract: Ed25519 over the RFC-8785 canonical form
      // of the payload with the envelope excluded, encoded base64url.
      const bytes = canonicalCountryPackBytes(stripSignature(payload));
      return cryptoSign(null, bytes, privateKey).toString('base64url');
    },
    trusted(status: TrustedKeyStatus = 'active'): TrustedReleaseKey {
      return {
        keyId,
        algorithm: COUNTRY_PACK_SIGNATURE_ALGORITHM,
        publicKey: publicKeyB64,
        status,
      };
    },
  };
}

/** Attach a real signature envelope to a pack document. */
export function signPackDocument(
  document: Record<string, unknown>,
  key: EphemeralReleaseKey,
): Record<string, unknown> {
  return {
    ...document,
    signature: {
      algorithm: COUNTRY_PACK_SIGNATURE_ALGORITHM,
      keyId: key.keyId,
      signature: key.sign(document),
    },
  };
}

/** A trust store holding the given ephemeral keys. */
export function trustStoreFor(
  ...keys: readonly TrustedReleaseKey[]
): InMemoryCountryPackTrustStore {
  return new InMemoryCountryPackTrustStore(keys);
}
