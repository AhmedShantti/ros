import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — a branch's authoritative base currency
 * (SRS §7.3 #5 key invariant: "one timezone; one base currency").
 *
 * `org.branches` is Organisation-owned data. SRS §5.2.3 states plainly that
 * "a module MUST NOT query another module's tables" and that cross-module
 * communication happens "through a published interface or a domain event" —
 * that requirement is about DATABASE OWNERSHIP, not merely about which
 * TypeScript files get imported. A consumer issuing a bare Branch-model
 * lookup directly (even via the shared Prisma client, even with no private
 * Organisation file imported) still reaches into Organisation's table, and
 * `module-boundaries.spec.ts`'s import-scan cannot see it — that check only
 * proves import-boundary compliance, not table-ownership compliance. This
 * contract exists so P1G-1's Treasury `CashClosePolicyService` (the first
 * consumer) — and any future consumer that needs a branch's currency inside
 * its own transaction — goes through Organisation instead.
 *
 * This file is INTERFACE + DTOs ONLY (SRS §5.4: "contract/ is PUBLIC ...
 * application/infrastructure remain PRIVATE"). The Prisma-backed
 * implementation lives at `organisation/branches/branch-currency.query.service.ts`
 * — a PRIVATE Organisation path — bound to `BRANCH_CURRENCY_QUERY` only
 * inside `OrganisationModule`. A consumer injects the token and depends on
 * the `BranchCurrencyQuery` interface below; it never imports the concrete
 * implementation or any other private Organisation path
 * (`module-boundaries.spec.ts`'s contract-purity assertions, mirroring the
 * `TableDisplayQuery` / `RoutingConfigQuery` pattern).
 *
 * `find()` is transaction-aware: the CALLER's own `Prisma.TransactionClient`
 * — no second transaction. A branch-currency lookup taken mid-write (e.g.
 * P1G-1's cash-close-policy create) reads inside that SAME atomic unit of
 * work (SRS §5.5.1), so the currency snapshot it returns is consistent with
 * everything else the caller's transaction does.
 *
 * Returns `null` when the branch id does not resolve — unknown id, or a
 * genuinely cross-tenant id (RLS makes the row invisible to the caller's
 * `tx` regardless of the WHERE clause, the same `null`-on-invisible
 * convention `CashSessionFactsQuery`/`TableDisplayQuery` already use).
 */
export const BRANCH_CURRENCY_QUERY = Symbol('BRANCH_CURRENCY_QUERY');

export interface BranchCurrencyQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface BranchCurrencyResult {
  readonly branchId: string;
  /** ISO 4217, the branch's own authoritative operating currency. */
  readonly baseCurrency: string;
}

export interface BranchCurrencyQuery {
  find(
    tx: Prisma.TransactionClient,
    input: BranchCurrencyQueryInput,
  ): Promise<BranchCurrencyResult | null>;
}
