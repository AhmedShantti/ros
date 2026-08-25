import { RoundingMode } from '../../../common/money/rounding';

/**
 * Localisation PUBLIC contract — the pinned cash-rounding/payment policy
 * facts Payment needs from a historical CountryPack (P1F-1A).
 *
 * SRS §5.4 makes `contract/` the ONLY directory another module may import
 * (§5.2.3 enforces that mechanically). This is Localisation's FIRST
 * `contract/` — before this correction, Sales' `OrderLinesService` consumed
 * `CountryPackService` directly, a pre-existing, unchanged, documented
 * `sales->localisation` deviation. P1F-1's own Payment work reasoned that
 * reusing that same private path introduced "zero new deviation" because
 * the allow-list key did not change; that reasoning is REJECTED here — an
 * existing private-import deviation is debt, not a public API, and a new
 * consumer relying on it *expands* the architectural violation even when
 * the `KNOWN_DEVIATIONS` entry's shape is unchanged. `SalesPaymentService`
 * therefore consumes Localisation ONLY through this contract, never through
 * `country-pack/country-pack.service` or any other Localisation internal
 * path. The pre-existing `OrderLinesService` debt is deliberately NOT
 * repaired here — this is a narrow correction, not a boundary-wide
 * refactor.
 *
 * ── WHY NO `Prisma.TransactionClient` PARAMETER ─────────────────────────────
 * Unlike the Catalogue/Organisation/Treasury contracts P1E-6/P1F-1
 * established, this query is NOT database-backed: `CountryPackService.
 * requirePinned()` is a synchronous, pure in-memory registry lookup (the
 * signed pack document, once activated, lives in process memory — see
 * `CountryPackRegistry`). Adding a transaction parameter here would invent
 * a database dependency the real implementation does not have. The
 * interface is deliberately synchronous, mirroring the real operation
 * exactly (SRS §5.5.1 — a synchronous interface call, not an async one
 * pretending to be I/O-bound).
 *
 * ── WHY NOT THE FULL `CountryPack` OBJECT ───────────────────────────────────
 * `CountryPack` also carries the full tax engine configuration (rate
 * classes, components, order-type overrides) — Payment needs none of that.
 * Exposing the whole object would leak Localisation's tax-domain internals
 * across the boundary for a caller that only needs four payment-relevant
 * facts. The private implementation lives at
 * `localisation/payment-policy/pinned-payment-policy.query.service.ts` and
 * adapts/delegates to `CountryPackService` — nothing else changes inside
 * Localisation.
 *
 * `requirePinnedPaymentPolicy()` resolves the EXACT pinned `(countryCode,
 * packVersion)` a historical Order names (FR-LOC-021) — never "current" or
 * "newest". Throws the same `CountryPackUnavailableError` `requirePinned()`
 * already throws when the pinned pack is not activated on this node.
 */
export const PINNED_PAYMENT_POLICY_QUERY = Symbol(
  'PINNED_PAYMENT_POLICY_QUERY',
);

export interface PinnedPaymentPolicyQueryInput {
  readonly countryCode: string;
  readonly packVersion: string;
}

export interface PinnedPaymentPolicy {
  /** ISO 4217 currency code the pinned pack prices in. */
  readonly currencyCode: string;
  readonly cashRoundingEnabled: boolean;
  /** Non-null if and only if `cashRoundingEnabled`. */
  readonly cashRoundingStepMinorUnits: bigint | null;
  /**
   * BR-FIN-002 — the system-wide rounding mode the pinned pack uses at
   * runtime (the pack's own tax-rounding mode; there is no separate
   * cash-specific mode field anywhere in the source). See
   * `sales-payment.service.ts` for why this is the correct value to apply,
   * not a substitute for a missing one.
   */
  readonly roundingMode: RoundingMode;
}

export interface PinnedPaymentPolicyQuery {
  requirePinnedPaymentPolicy(
    input: PinnedPaymentPolicyQueryInput,
  ): PinnedPaymentPolicy;
}
