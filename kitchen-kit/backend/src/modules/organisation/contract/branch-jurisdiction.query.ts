import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — a branch's authoritative jurisdiction
 * (`org.branches.country_code`), used to resolve which Country Pack applies.
 *
 * A NEW, narrow sibling of `branch-currency.query.ts` rather than an added
 * field on `BranchCurrencyResult` — that contract's name, docblock, and
 * rationale (SRS §7.3 #5 "one timezone; one base currency") are entirely
 * currency-specific, and jurisdiction is a conceptually distinct fact (even
 * though it happens to live on the same `org.branches` row) that deserves
 * its own name rather than quietly widening what "branch currency" means to
 * its existing consumer. See `docs/reports/claude/
 * 2026-09-09_FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B.md` §1 and
 * `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-CORRECTION-P1C.md`
 * ORGANISATION_CONTRACT_DECISION.
 *
 * `org.branches` is Organisation-owned data; SRS §5.2.3 forbids another
 * module querying it directly (a raw Prisma read is invisible to
 * `module-boundaries.spec.ts`'s import-scan but is still a table-ownership
 * violation — the exact reasoning `branch-currency.query.ts`'s own docblock
 * already gives). This contract exists so `platform-settings`' Country-Pack
 * settings-hierarchy tier — and any future consumer needing a branch's
 * jurisdiction inside its own transaction — goes through Organisation
 * instead of reading `org.branches` itself or reaching into Localisation's
 * private `CountryPackService` the way the pre-existing, unaddressed
 * `sales->localisation` deviation does.
 *
 * `find()` is transaction-aware: the CALLER's own `Prisma.TransactionClient`
 * — no second transaction (SRS §5.5.1), matching `BranchCurrencyQuery`.
 * Returns `null` when the branch id does not resolve — unknown id, or a
 * genuinely cross-tenant id (RLS makes the row invisible to the caller's
 * `tx` regardless of the WHERE clause), the same convention every other
 * Organisation query contract already uses.
 */
export const BRANCH_JURISDICTION_QUERY = Symbol('BRANCH_JURISDICTION_QUERY');

export interface BranchJurisdictionQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface BranchJurisdictionResult {
  readonly branchId: string;
  /**
   * `org.branches.country_code` — the SAME value space as
   * `CountryPack.code`/`identity.tenants.country_pack_code` (both are, e.g.,
   * `"EG"`), confirmed by `CountryPackService.requireEffectiveFor`'s own use
   * of `branch.countryCode` directly as the pack-registry lookup key.
   */
  readonly countryCode: string;
}

export interface BranchJurisdictionQuery {
  find(
    tx: Prisma.TransactionClient,
    input: BranchJurisdictionQueryInput,
  ): Promise<BranchJurisdictionResult | null>;
}
