/**
 * Proves the ACTUAL committed deployment artefacts under
 * `config/country-packs/` — `EG-2026.1.pack.json` and `trust-manifest.json` —
 * activate through the real production pipeline (`parseTrustManifest`,
 * `InMemoryCountryPackTrustStore`, `Ed25519CountryPackSignatureVerifier`,
 * `CountryPackRegistry`), not a fixture. This is the file Render will actually
 * load via `COUNTRY_PACK_DIR` / `COUNTRY_PACK_TRUST_MANIFEST`.
 *
 * The existing `country-pack.registry.spec.ts` / `country-pack.signature.spec.ts`
 * already cover the GENERIC activation-policy logic against ephemeral fixture
 * keys; this file is deliberately narrow and only exercises the specific
 * artefacts this deployment ships.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import {
  CountryPackActivationError,
  CountryPackRegistry,
} from './country-pack.registry';
import {
  Ed25519CountryPackSignatureVerifier,
  InMemoryCountryPackTrustStore,
  parseTrustManifest,
} from './country-pack.signature';

const CONFIG_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'config',
  'country-packs',
);
const PACK_PATH = join(CONFIG_DIR, 'EG-2026.1.pack.json');
const MANIFEST_PATH = join(CONFIG_DIR, 'trust-manifest.json');

const parseOptions = { knownEngines: new TaxEngineRegistry().ids };

function loadManifestVerifier() {
  const keys = parseTrustManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
  );
  return new Ed25519CountryPackSignatureVerifier(
    new InMemoryCountryPackTrustStore(keys),
  );
}

function loadPackDocument(): Record<string, unknown> {
  return JSON.parse(readFileSync(PACK_PATH, 'utf8')) as Record<string, unknown>;
}

describe('committed Country Pack deployment artefacts (config/country-packs)', () => {
  it('parses the trust manifest with exactly one active Ed25519 key', () => {
    const keys = parseTrustManifest(
      JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      keyId: 'ros-demo-2026',
      algorithm: 'Ed25519',
      status: 'active',
    });
  });

  it('activates the committed EG pack against the committed trust manifest', async () => {
    const registry = new CountryPackRegistry(
      loadManifestVerifier(),
      parseOptions,
    );
    const pack = await registry.activate(loadPackDocument());

    expect(pack.code).toBe('EG');
    expect(pack.version).toBe('2026.1');
    expect(pack.currency.currency.code).toBe('EGP');
    expect(pack.tax.engine).toBe('vat_standard');
    expect([...pack.tax.classes.keys()].sort()).toEqual([
      'exempt',
      'reduced',
      'standard',
      'zero',
    ]);
  });

  it('resolves as effective for a transaction today (effectiveFrom already past)', async () => {
    const registry = new CountryPackRegistry(
      loadManifestVerifier(),
      parseOptions,
    );
    await registry.activate(loadPackDocument());

    expect(registry.resolveEffective('EG', new Date())).not.toBeNull();
    expect(
      registry.resolveEffective('EG', new Date('2025-01-01T00:00:00Z')),
    ).toBeNull();
  });

  it('rejects the pack if its payload is modified after signing', async () => {
    const registry = new CountryPackRegistry(
      loadManifestVerifier(),
      parseOptions,
    );
    const tampered = loadPackDocument();
    (tampered.tax as Record<string, unknown>).classes = [
      ...((tampered.tax as Record<string, unknown>).classes as unknown[]),
    ];
    (
      (tampered.tax as Record<string, unknown>).classes as Array<
        Record<string, unknown>
      >
    )[0] = {
      ...(
        (tampered.tax as Record<string, unknown>).classes as Array<
          Record<string, unknown>
        >
      )[0],
      rate: '99.0',
    };

    await expect(registry.activate(tampered)).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
  });

  it('rejects the pack when verified against a trust store that does not carry its key', async () => {
    const emptyVerifier = new Ed25519CountryPackSignatureVerifier(
      new InMemoryCountryPackTrustStore([]),
    );
    const registry = new CountryPackRegistry(emptyVerifier, parseOptions);

    await expect(registry.activate(loadPackDocument())).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
  });

  it('rejects the pack once its key is marked revoked', async () => {
    const keys = parseTrustManifest(
      JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
    );
    const revoked = new InMemoryCountryPackTrustStore(
      keys.map((k) => ({ ...k, status: 'revoked' as const })),
    );
    const registry = new CountryPackRegistry(
      new Ed25519CountryPackSignatureVerifier(revoked),
      parseOptions,
    );

    await expect(registry.activate(loadPackDocument())).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
  });
});
