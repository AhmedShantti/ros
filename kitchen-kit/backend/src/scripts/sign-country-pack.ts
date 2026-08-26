/**
 * Country Pack OFFLINE signing tool — DEVELOPMENT/DEMO PROVISIONING ONLY.
 *
 * This is NOT a production Country Pack certification pipeline and NOT part of
 * the application runtime. It exists solely so a signed pack + its trust
 * manifest entry can be produced outside the Nest process, matching the
 * ratified P1C-3 trust model: "No Country Pack signing private key may exist
 * in the application database, the backend runtime secret set, the source
 * repository, or any committed fixture. Signing happens outside the
 * application runtime." (docs/governance/GOVERNANCE_DECISION_REGISTER.md,
 * CARRIED ITEM P1C-3).
 *
 * It reuses the EXACT canonicalisation/verification primitives the runtime
 * uses (`stripSignature`, `canonicalCountryPackBytes` from
 * `country-pack.signature.ts`) so the bytes signed here are byte-identical to
 * the bytes `Ed25519CountryPackSignatureVerifier` re-derives at verification
 * time — there is no second canonicalisation implementation to drift.
 *
 * USAGE
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/sign-country-pack.ts \
 *     sign <unsigned-pack.json> <private-key.pem> <keyId> <output-signed-pack.json>
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/sign-country-pack.ts \
 *     trust-entry <private-key.pem> <keyId> [active|revoked]
 *
 * `sign` never reads a key from anywhere but the explicit local file path
 * given on the command line; it never logs the private key or any derived
 * secret; it refuses to write its output over the private-key path itself;
 * and it writes ONLY the signed pack (public artefact) to disk.
 *
 * `trust-entry` derives the PUBLIC key from the same private key file and
 * prints a single trust-manifest `keys[]` entry (public key only) to stdout —
 * it writes nothing to disk.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
} from 'node:crypto';
import {
  COUNTRY_PACK_SIGNATURE_ALGORITHM,
  canonicalCountryPackBytes,
  stripSignature,
} from '../modules/localisation/country-pack/country-pack.signature';

/** RFC 8410 SPKI DER header for Ed25519; the raw key is the trailing 32 bytes. */
const SPKI_PREFIX_BYTES = 12;

function fail(message: string): never {
  console.error(`sign-country-pack: ${message}`);
  process.exit(1);
}

function loadPrivateKeyFile(path: string) {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    fail(
      `private key file not found: ${path}. This tool never generates a key ` +
        'itself — create one first, e.g.:\n' +
        '  openssl genpkey -algorithm ed25519 -out <local-gitignored-path>.pem',
    );
  }
  const pem = readFileSync(abs, 'utf8');
  let keyObject: ReturnType<typeof createPrivateKey>;
  try {
    keyObject = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // Never echo the parser error: it can quote fragments of the key material.
    fail(`could not parse ${path} as a PEM private key.`);
  }
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    fail(
      `${path} is a ${keyObject.asymmetricKeyType ?? 'unknown'} key; only ` +
        `${COUNTRY_PACK_SIGNATURE_ALGORITHM} is supported (P1C-3).`,
    );
  }
  const spki = createPublicKey(keyObject).export({
    format: 'der',
    type: 'spki',
  });
  const publicKeyB64 = Buffer.from(spki)
    .subarray(SPKI_PREFIX_BYTES)
    .toString('base64url');
  return { keyObject, publicKeyB64 };
}

function cmdSign(args: string[]): void {
  const [unsignedPath, keyPath, keyId, outPath] = args;
  if (!unsignedPath || !keyPath || !keyId || !outPath) {
    fail(
      'usage: sign <unsigned-pack.json> <private-key.pem> <keyId> <output-signed-pack.json>',
    );
  }
  if (resolve(outPath) === resolve(keyPath)) {
    fail('refusing to write the signed pack over the private-key path.');
  }

  const unsignedRaw = readFileSync(resolve(unsignedPath), 'utf8');
  let document: unknown;
  try {
    document = JSON.parse(unsignedRaw);
  } catch {
    fail(`${unsignedPath} is not valid JSON.`);
  }
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    'signature' in (document as Record<string, unknown>)
  ) {
    fail(
      `${unsignedPath} must be an unsigned pack object with no "signature" key.`,
    );
  }

  const { keyObject } = loadPrivateKeyFile(keyPath);

  // The SAME canonicalisation path the verifier uses — no second implementation.
  const payload = stripSignature(document);
  const canonicalBytes = canonicalCountryPackBytes(payload);
  const signature = cryptoSign(null, canonicalBytes, keyObject).toString(
    'base64url',
  );

  const signed = {
    ...(payload as Record<string, unknown>),
    signature: {
      algorithm: COUNTRY_PACK_SIGNATURE_ALGORITHM,
      keyId,
      signature,
    },
  };

  writeFileSync(resolve(outPath), `${JSON.stringify(signed, null, 2)}\n`, {
    utf8: true,
  } as never);
  console.log(`Wrote signed pack: ${outPath}`);
  console.log(`  keyId: ${keyId}`);
  console.log(
    '  Private key material was read but never logged, written, or persisted ' +
      'anywhere other than the input path you provided.',
  );
}

function cmdTrustEntry(args: string[]): void {
  const [keyPath, keyId, status = 'active'] = args;
  if (!keyPath || !keyId) {
    fail('usage: trust-entry <private-key.pem> <keyId> [active|revoked]');
  }
  if (status !== 'active' && status !== 'revoked') {
    fail('status must be "active" or "revoked".');
  }
  const { publicKeyB64 } = loadPrivateKeyFile(keyPath);
  const entry = {
    keyId,
    algorithm: COUNTRY_PACK_SIGNATURE_ALGORITHM,
    publicKey: publicKeyB64,
    status,
  };
  console.log(JSON.stringify(entry, null, 2));
}

function main(): void {
  const [, , command, ...rest] = process.argv;
  if (command === 'sign') return cmdSign(rest);
  if (command === 'trust-entry') return cmdTrustEntry(rest);
  fail('usage: sign-country-pack.ts <sign|trust-entry> ...');
}

main();
