import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { makePackDocument } from './country-pack.fixture';
import { CountryPackValidationError } from './country-pack.model';
import {
  CountryPackActivationError,
  CountryPackRegistry,
  CountryPackUnavailableError,
} from './country-pack.registry';
import {
  CountryPackSignatureInput,
  CountryPackSignatureVerifier,
  DenyAllCountryPackSignatureVerifier,
  Ed25519CountryPackSignatureVerifier,
  readSignature,
} from './country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './country-pack.signing.fixture';

const parseOptions = { knownEngines: new TaxEngineRegistry().ids };

/**
 * These tests exercise the ACTIVATION POLICY around the verifier port, using the
 * real Ed25519 / RFC-8785 verifier and an ephemeral release key generated in
 * memory. No private key is committed; see `country-pack.signing.fixture.ts`.
 */
const RELEASE = generateReleaseKey('ros-release-2026');
const OTHER = generateReleaseKey('someone-elses-key');

/** The production verifier, trusting only the ephemeral release key. */
const realVerifier = (status: 'active' | 'revoked' = 'active') =>
  new Ed25519CountryPackSignatureVerifier(
    trustStoreFor(RELEASE.trusted(status)),
  );

/** A verifier that throws, to prove an exception path is not an accidental yes. */
class ExplodingVerifier implements CountryPackSignatureVerifier {
  verify(): boolean {
    throw new Error('HSM unreachable at /secret/path');
  }
}

/** A verifier that records what it was handed. */
class RecordingVerifier implements CountryPackSignatureVerifier {
  readonly seen: CountryPackSignatureInput[] = [];
  constructor(private readonly inner: CountryPackSignatureVerifier) {}
  verify(input: CountryPackSignatureInput): boolean | Promise<boolean> {
    this.seen.push(input);
    return this.inner.verify(input);
  }
}

const signed = (overrides: Record<string, unknown> = {}) =>
  signPackDocument(makePackDocument(overrides), RELEASE);

describe('Country Pack activation policy (FR-LOC-022 / FR-LOC-031)', () => {
  const trusted = () => realVerifier();

  it('accepts a pack whose signature the verifier attests', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);
    const pack = await registry.activate(signed());

    expect(pack.version).toBe('2026.1');
    expect(registry.resolveExact('EG', '2026.1')).not.toBeNull();
  });

  it('rejects an unsigned pack', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);

    await expect(registry.activate(makePackDocument())).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
    expect(registry.size).toBe(0);
  });

  it('rejects a structurally invalid signature block as unsigned', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);
    const doc = { ...makePackDocument(), signature: { algorithm: 'Ed25519' } };

    await expect(registry.activate(doc)).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
    expect(readSignature(doc)).toBeNull();
  });

  it('rejects a modified payload', async () => {
    // Sign the pack, then change a rate. The canonical bytes change, so the
    // value the verifier was told to expect no longer matches.
    const registry = new CountryPackRegistry(trusted(), parseOptions);
    const doc = signed();
    const tax = { ...(doc.tax as Record<string, unknown>) };
    tax.classes = [
      { code: 'standard', rate: '0.0' },
      { code: 'exempt', rate: null },
    ];

    await expect(registry.activate({ ...doc, tax })).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
    expect(registry.size).toBe(0);
  });

  it('rejects a pack signed by the wrong key', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);

    await expect(
      registry.activate(signPackDocument(makePackDocument(), OTHER)),
    ).rejects.toBeInstanceOf(CountryPackActivationError);
    expect(registry.size).toBe(0);
  });

  it('rejects a bad signature value under the right key', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);

    await expect(
      registry.activate(signPackDocument(makePackDocument(), OTHER)),
    ).rejects.toBeInstanceOf(CountryPackActivationError);
    expect(registry.size).toBe(0);
  });

  it('fails closed when the verifier throws, and never leaks its error', async () => {
    const registry = new CountryPackRegistry(
      new ExplodingVerifier(),
      parseOptions,
    );

    await expect(registry.activate(signed())).rejects.toThrow(
      /was not activated/,
    );
    await expect(registry.activate(signed())).rejects.not.toThrow(
      /secret\/path/,
    );
  });

  it('fails closed with the DEFAULT deny-all verifier', async () => {
    // The production binding. Until FR-LOC-022's scheme is ratified, no pack
    // activates at all, so no sale can be priced under an unverified pack.
    const registry = new CountryPackRegistry(
      new DenyAllCountryPackSignatureVerifier(),
      parseOptions,
    );

    await expect(registry.activate(signed())).rejects.toBeInstanceOf(
      CountryPackActivationError,
    );
    expect(registry.size).toBe(0);
  });

  it('reports malformation before signature failure', async () => {
    const registry = new CountryPackRegistry(trusted(), parseOptions);
    const doc = { ...makePackDocument(), version: '' };

    await expect(registry.activate(doc)).rejects.toBeInstanceOf(
      CountryPackValidationError,
    );
  });

  it('hands the verifier the document with the signature stripped', async () => {
    const verifier = new RecordingVerifier(realVerifier());
    const registry = new CountryPackRegistry(verifier, parseOptions);
    await registry.activate(signed());

    const seen = verifier.seen.at(-1)!;
    expect(seen.code).toBe('EG');
    expect(seen.version).toBe('2026.1');
    expect(seen.document).not.toHaveProperty('signature');
    expect(seen.signature?.keyId).toBe('ros-release-2026');
  });
});

describe('Country Pack versioning (FR-LOC-021)', () => {
  const build = async () => {
    const registry = new CountryPackRegistry(realVerifier(), parseOptions);
    await registry.activate(
      signed({
        version: '2025.1',
        effectiveFrom: '2025-01-01',
      }),
    );
    await registry.activate(
      signed({
        version: '2026.1',
        effectiveFrom: '2026-01-01',
      }),
    );
    await registry.activate(
      signed({
        version: '2027.1',
        effectiveFrom: '2027-01-01',
      }),
    );
    return registry;
  };

  it('resolves an earlier transaction to the earlier effective version', async () => {
    const registry = await build();
    expect(
      registry.resolveEffective('EG', new Date('2025-06-15T10:00:00Z'))
        ?.version,
    ).toBe('2025.1');
  });

  it('resolves a later transaction to the newer effective version', async () => {
    const registry = await build();
    expect(
      registry.resolveEffective('EG', new Date('2026-08-20T10:00:00Z'))
        ?.version,
    ).toBe('2026.1');
  });

  it('does not activate a future pack early (FR-LOC-024)', async () => {
    // The 2027 pack is distributed and registered but not yet in force.
    const registry = await build();
    expect(
      registry.resolveEffective('EG', new Date('2026-12-31T23:59:59Z'))
        ?.version,
    ).toBe('2026.1');
    expect(
      registry.resolveEffective('EG', new Date('2027-01-01T00:00:00Z'))
        ?.version,
    ).toBe('2027.1');
  });

  it('keeps a historical order pinned to its original version', async () => {
    const registry = await build();
    // An order created in 2025 recorded "2025.1". Two newer packs have since
    // become effective; the pinned lookup is unaffected by all of it.
    const pinned = registry.resolveExact('EG', '2025.1');
    expect(pinned?.version).toBe('2025.1');
    expect(pinned?.effectiveFrom.toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    );
  });

  it('resolves nothing before the earliest effective date', async () => {
    const registry = await build();
    expect(
      registry.resolveEffective('EG', new Date('2024-12-31T00:00:00Z')),
    ).toBeNull();
    expect(() =>
      registry.requireEffective('EG', new Date('2024-12-31T00:00:00Z')),
    ).toThrow(CountryPackUnavailableError);
  });

  it('resolves nothing for a jurisdiction with no activated pack', async () => {
    const registry = await build();
    expect(registry.resolveEffective('SA', new Date('2026-08-20Z'))).toBeNull();
  });

  it('refuses to re-register a version with a different effective date', async () => {
    const registry = await build();
    await expect(
      registry.activate(
        signed({
          version: '2026.1',
          effectiveFrom: '2026-07-01',
        }),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps each jurisdiction versions separate', async () => {
    const registry = await build();
    await registry.activate(
      signed({
        code: 'SA',
        version: '2026.1',
        effectiveFrom: '2026-01-01',
        currency: {
          code: 'SAR',
          exponent: 2,
          cashRounding: { enabled: false },
        },
      }),
    );
    expect(registry.describe()).toEqual({
      EG: ['2025.1', '2026.1', '2027.1'],
      SA: ['2026.1'],
    });
  });
});
