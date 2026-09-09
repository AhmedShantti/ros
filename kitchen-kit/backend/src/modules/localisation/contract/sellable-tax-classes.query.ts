/**
 * Localisation PUBLIC contract — DEMO-TAX-CLASS-BACKEND-P0.
 *
 * `fiscal.tax_classes` identities are materialised per-tenant, per-jurisdiction
 * by `TaxClassProvisioningService` (see `tax/tax-class.provisioner.ts`) the
 * moment a tenant's `country_pack_code` is assigned — but nothing PUBLISHES
 * them anywhere a caller can discover a value valid for `MenuItem.taxClassId`.
 * `tax-class.port.ts` names that gap explicitly: "NO PUBLIC ADMINISTRATION
 * SURFACE ... a pack version that ADDS a class after a tenant was provisioned
 * has no operator surface". This contract is the narrowest fix: read-only
 * discovery of the identities that already exist, never a pack-authoring
 * surface and never a rate.
 *
 * Two operations:
 *
 *   listSellableForBranch  the CATALOGUE-facing read: every ACTIVE identity the
 *                          tenant holds under the pack currently effective for
 *                          one branch — i.e. every value an admin screen may
 *                          offer for that branch's items. Resolves the branch
 *                          exactly as `CountryPackService.resolveForBranch`
 *                          does (RLS-scoped; a foreign/unknown branch and a
 *                          branch with no activated pack are indistinguishable
 *                          failure shapes to a caller with no legitimate
 *                          reason to tell them apart), and turns those two
 *                          failures into `NotFoundException` /
 *                          `UnprocessableEntityException` — plain Nest
 *                          exceptions, not a Localisation-internal error type,
 *                          so nothing Localisation-specific crosses the
 *                          contract boundary.
 *
 *   resolveSellable        the CATALOGUE-facing WRITE-time check: does this
 *                          UUID name an active identity belonging to this
 *                          tenant? `MenuItem` carries no branch (C-02 — one
 *                          item may sell at many branches under many packs),
 *                          so write-time validation is deliberately
 *                          tenant-scoped, not branch-scoped; the branch/
 *                          jurisdiction match is `TaxClassService.
 *                          requireForSale`'s job, at sale time, unchanged by
 *                          this contract. `null` (never a thrown error) is
 *                          the "no" answer, so a caller can turn it into
 *                          whatever 4xx its own domain uses.
 *
 * Neither operation exposes a rate, a component, or any tax-engine
 * configuration — the same narrowing `TaxClassLabelsQuery` already applies.
 */
export const SELLABLE_TAX_CLASSES_QUERY = Symbol('SELLABLE_TAX_CLASSES_QUERY');

export interface SellableTaxClass {
  /** `fiscal.tax_classes.id` — the value `MenuItem.taxClassId` must carry. */
  readonly id: string;
  /** Immutable semantic key, matched against the pinned pack's `tax.classes[].code`. */
  readonly code: string;
  /** Localised display label ({"en": "...", ...}); never used for lookup. */
  readonly names: Readonly<Record<string, string>>;
}

export interface SellableTaxClassesForBranchInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface ResolveSellableTaxClassInput {
  readonly tenantId: string;
  readonly taxClassId: string;
}

export interface SellableTaxClassesQuery {
  /**
   * Every ACTIVE tax class identity valid for a MenuItem sold at this branch,
   * derived from the branch's own currently-effective country pack.
   *
   * Throws `NotFoundException` when the branch is not visible in this tenant
   * (unknown, or another tenant's — the two are indistinguishable on
   * purpose), and `UnprocessableEntityException` when no activated pack
   * covers the branch's jurisdiction or the pack's currency disagrees with
   * the branch's (mirrors `CountryPackService.resolveForBranch`).
   */
  listSellableForBranch(
    input: SellableTaxClassesForBranchInput,
  ): Promise<readonly SellableTaxClass[]>;

  /**
   * Resolve one candidate `MenuItem.taxClassId` for write-time validation.
   * Returns `null` — never throws — when the id does not name an ACTIVE
   * `fiscal.tax_classes` row belonging to this tenant.
   */
  resolveSellable(
    input: ResolveSellableTaxClassInput,
  ): Promise<SellableTaxClass | null>;
}
