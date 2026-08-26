/**
 * `CountryPackService.requireEffectiveFor` — the branch->pack resolution step
 * `resolveForBranch`/`OrderLinesService` depend on. No existing spec covered
 * this pure method directly (only indirectly via e2e), and it is exactly the
 * check that would refuse order creation if a branch's `baseCurrency` ever
 * disagreed with its activated pack's currency (FR-BRN-003).
 */

import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { CountryPackService } from './country-pack.service';
import { CountryPackUnavailableError } from './country-pack.registry';
import { Ed25519CountryPackSignatureVerifier } from './country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './country-pack.signing.fixture';
import { makePackDocument } from './country-pack.fixture';

const RELEASE = generateReleaseKey('ros-release-2026');
const verifier = new Ed25519CountryPackSignatureVerifier(
  trustStoreFor(RELEASE.trusted()),
);

function makeService(): CountryPackService {
  // `requireEffectiveFor` is pure (no DB access) — the Prisma dependency is
  // never touched by the method under test.
  return new CountryPackService({} as never, new TaxEngineRegistry(), verifier);
}

describe('CountryPackService.requireEffectiveFor (FR-BRN-002/003)', () => {
  it('resolves the pack when the branch country and currency both match', async () => {
    const service = makeService();
    await service.activate(signPackDocument(makePackDocument(), RELEASE));

    const pack = service.requireEffectiveFor(
      { id: 'branch-1', countryCode: 'EG', baseCurrency: 'EGP' },
      new Date('2026-06-01T00:00:00Z'),
    );

    expect(pack.code).toBe('EG');
    expect(pack.currency.currency.code).toBe('EGP');
  });

  it('refuses a branch whose baseCurrency disagrees with the activated pack', async () => {
    const service = makeService();
    await service.activate(signPackDocument(makePackDocument(), RELEASE));

    expect(() =>
      service.requireEffectiveFor(
        { id: 'branch-1', countryCode: 'EG', baseCurrency: 'USD' },
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).toThrow(CountryPackUnavailableError);
  });

  it('refuses a branch whose country has no activated pack at all', () => {
    const service = makeService();

    expect(() =>
      service.requireEffectiveFor(
        { id: 'branch-1', countryCode: 'SA', baseCurrency: 'SAR' },
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).toThrow(CountryPackUnavailableError);
  });
});
