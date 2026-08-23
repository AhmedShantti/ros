/**
 * Catalogue price-list resolution — FR-MNU-020…023 and the catalogue-owned tiers
 * of FR-POS-040.
 *
 * PURE FUNCTION. No clock, no database, no locale, no global state: every input
 * arrives in the context object, so the same inputs always produce the same
 * output. That is what ADR-004 / BR-FIN-005 / FR-OFF-050 require of any logic
 * that must one day be duplicated in the Dart POS client and agree with the
 * server byte-for-byte.
 *
 * ── FR-POS-040 TIERS ────────────────────────────────────────────────────────
 *   1. manual price override      — Sales does not exist; NOT implemented here
 *   2. active promotion           — CRM does not exist; NOT implemented here
 *   3. active time-based list     — IMPLEMENTED (recurrence v1, ratified P0-2)
 *   4. order-type-specific list   — IMPLEMENTED
 *   5. branch price list          — IMPLEMENTED
 *   6. brand price list           — IMPLEMENTED
 *   7. base price                 — IMPLEMENTED as ratified P0-5: the eligible
 *                                   tenant-scoped, non-order-specific list
 *
 * A candidate takes the HIGHEST tier it qualifies for (lowest number). A
 * recurring list that also carries an order type stays a Tier-3 candidate but
 * must still satisfy its order-type eligibility.
 *
 * FR-POS-040 as a whole remains PARTIAL while tiers 1 and 2 have no domain.
 *
 * ── RATIFIED DECISIONS IMPLEMENTED HERE ─────────────────────────────────────
 *   P0-1  validity windows are half-open [from, to); NULL endpoints unbounded.
 *         This is a ratified architectural decision, NOT merely a local
 *         convention, and NOT an SRS requirement — the SRS never states
 *         boundary inclusivity.
 *   P0-2  weekly local-time recurrence v1, evaluated in the branch timezone.
 *   P0-4  higher integer = higher priority (the repository's existing direction).
 *   P0-5  the base-price tier is the eligible tenant-scoped, non-order-specific
 *         price list. No `base_price` column exists and none is invented.
 *
 * ── TIE HANDLING ────────────────────────────────────────────────────────────
 * SRS §7.3 #10 forbids two lists sharing scope, priority and an overlapping
 * outer window, and `ex_price_list_no_overlap` makes that state unrepresentable.
 * Should an ambiguous state survive anyway, no winner is invented — not by id,
 * not by creation time, not by row order. The result is flagged `ambiguous`.
 */

import { Money } from '../../../common/money/money';
import {
  RecurrenceError,
  parseRecurrence,
  recurrenceMatchesAt,
} from './recurrence';

/** Price-list scope, mirroring the `catalogue.PriceListScope` enum. */
export type PriceScope = 'tenant' | 'brand' | 'branch';

/** FR-POS-040 precedence tier. Lower wins. */
export type PriceTier = 3 | 4 | 5 | 6 | 7;

export const TIER_LABEL: Readonly<Record<PriceTier, string>> = Object.freeze({
  3: 'time_based',
  4: 'order_type_specific',
  5: 'branch',
  6: 'brand',
  7: 'base_tenant',
});

/**
 * One price-list entry that could apply to the requested variant, as loaded by
 * the service. Field names mirror the Prisma models.
 */
export interface PriceCandidate {
  readonly priceListId: string;
  readonly priceListName: string;
  readonly scopeType: PriceScope;
  /** Brand id for `brand` scope, branch id for `branch` scope, tenant id for `tenant`. */
  readonly scopeId: string | null;
  /** NULL means the list applies to every order type (FR-MNU-021). */
  readonly orderType: string | null;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  /** Weekly local-time recurrence v1 (P0-2), or null/undefined for none. */
  readonly recurrenceRule: unknown;
  readonly priority: number;
  /** `scheduled` | `active` | `expired`. */
  readonly status: string;
  readonly entryId: string;
  /** Minor units, straight from `price_entries.price` (BIGINT). */
  readonly priceMinorUnits: bigint;
  readonly currency: string;
}

/** Everything the resolution depends on. Nothing is read from ambient state. */
export interface PriceContext {
  readonly brandId: string;
  readonly branchId: string;
  /** IANA zone from `org.branches.timezone`, e.g. `Africa/Cairo` (FR-MNU-022). */
  readonly branchTimezone: string;
  readonly menuItemVariantId: string;
  /** The order type being priced, or null when none applies. */
  readonly orderType: string | null;
  /** The instant to evaluate at — supplied, never read from the clock. */
  readonly at: Date;
}

/** A candidate that could not be evaluated at all. */
export interface UndeterminableCandidate {
  readonly priceListId: string;
  readonly priceListName: string;
  readonly reason: 'recurrence_rule_malformed';
  readonly detail: string;
}

/**
 * The selected price plus enough provenance for a future Sales layer to snapshot
 * which list and which rule produced it (FR-POS-042). Nothing is persisted here.
 */
export interface ResolvedPrice {
  readonly amount: Money;
  readonly priceListId: string;
  readonly priceListName: string;
  readonly priceEntryId: string;
  readonly scopeType: PriceScope;
  readonly orderType: string | null;
  readonly priority: number;
  /** FR-POS-040 tier that selected this candidate. */
  readonly tier: PriceTier;
  readonly tierLabel: string;
  /** True when a P0-2 recurrence window put this candidate in Tier 3. */
  readonly recurring: boolean;
  /** Human-readable account of the tiers that selected this candidate. */
  readonly rule: string;
}

export interface PriceResolution {
  /** The winner, or null when nothing eligible applies or the result is ambiguous. */
  readonly resolved: ResolvedPrice | null;
  /** True when two or more candidates tie on every discriminator. */
  readonly ambiguous: boolean;
  readonly warning?: string;
  /** Candidates skipped because they could not be evaluated. */
  readonly undeterminable: readonly UndeterminableCandidate[];
  readonly evaluatedAt: Date;
  readonly evaluatedInTimezone: string;
}

/** Scope specificity within a tier — branch > brand > tenant. */
const SCOPE_RANK: Readonly<Record<PriceScope, number>> = Object.freeze({
  branch: 2,
  brand: 1,
  tenant: 0,
});

/** Statuses that may price anything. C-11 governs completeness, not this filter. */
function statusPermitsPricing(status: string): boolean {
  return status !== 'expired';
}

/**
 * Outer validity window check — ratified P0-1 half-open `[from, to)`, NULL
 * endpoints unbounded. Mirrors `tstzrange(valid_from, valid_to)` exactly.
 */
function withinOuterWindow(candidate: PriceCandidate, at: Date): boolean {
  if (candidate.validFrom !== null && at < candidate.validFrom) {
    return false;
  }
  if (candidate.validTo !== null && at >= candidate.validTo) {
    return false;
  }
  return true;
}

function targetsThisContext(
  candidate: PriceCandidate,
  ctx: PriceContext,
): boolean {
  if (candidate.scopeType === 'branch') {
    return candidate.scopeId === ctx.branchId;
  }
  if (candidate.scopeType === 'brand') {
    return candidate.scopeId === ctx.brandId;
  }
  return true; // tenant scope always targets the acting tenant (RLS guarantees it)
}

function matchesOrderType(
  candidate: PriceCandidate,
  ctx: PriceContext,
): boolean {
  // FR-MNU-021: a list either targets this order type or every order type.
  return candidate.orderType === null || candidate.orderType === ctx.orderType;
}

function hasRecurrence(candidate: PriceCandidate): boolean {
  return (
    candidate.recurrenceRule !== null && candidate.recurrenceRule !== undefined
  );
}

/**
 * FR-POS-040 tier for an eligible candidate — the highest it qualifies for.
 *
 * `recurring` is passed in rather than re-derived so the caller's single
 * recurrence evaluation is reused.
 */
function tierOf(candidate: PriceCandidate, recurring: boolean): PriceTier {
  if (recurring) return 3;
  if (candidate.orderType !== null) return 4;
  if (candidate.scopeType === 'branch') return 5;
  if (candidate.scopeType === 'brand') return 6;
  return 7; // tenant-scoped, non-order-specific — the P0-5 base fallback
}

interface Ranked {
  readonly candidate: PriceCandidate;
  readonly tier: PriceTier;
  readonly recurring: boolean;
}

/** Tier first (lower wins), then scope specificity, then P0-4 priority. */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const scope =
    SCOPE_RANK[b.candidate.scopeType] - SCOPE_RANK[a.candidate.scopeType];
  if (scope !== 0) return scope;
  return b.candidate.priority - a.candidate.priority; // P0-4: higher wins
}

function describeRule(ranked: Ranked): string {
  const c = ranked.candidate;
  const parts = [
    `tier=${ranked.tier}:${TIER_LABEL[ranked.tier]}`,
    `scope=${c.scopeType}`,
    c.orderType !== null ? `orderType=${c.orderType}` : 'orderType=any',
    `priority=${c.priority}`,
  ];
  if (ranked.recurring) parts.push('recurrence=v1-match');
  if (c.validFrom !== null || c.validTo !== null) parts.push('window=bounded');
  return parts.join(', ');
}

/**
 * Resolve the applicable price for one variant at one instant.
 *
 * Deterministic: identical inputs always yield an identical result, including
 * the ambiguity verdict.
 */
export function resolvePrice(
  candidates: readonly PriceCandidate[],
  ctx: PriceContext,
): PriceResolution {
  const base = {
    evaluatedAt: ctx.at,
    evaluatedInTimezone: ctx.branchTimezone,
  };

  const undeterminable: UndeterminableCandidate[] = [];
  const eligible: Ranked[] = [];

  for (const candidate of candidates) {
    // Cheap structural filters first.
    if (
      !targetsThisContext(candidate, ctx) ||
      !matchesOrderType(candidate, ctx) ||
      !statusPermitsPricing(candidate.status) ||
      !withinOuterWindow(candidate, ctx.at)
    ) {
      continue;
    }

    // P0-2 recurrence. A malformed rule is surfaced explicitly rather than
    // silently treated as "always on" or "never on" — either would price at
    // times the operator never configured.
    let recurring = false;
    if (hasRecurrence(candidate)) {
      try {
        const rule = parseRecurrence(candidate.recurrenceRule);
        if (!recurrenceMatchesAt(rule, ctx.at, ctx.branchTimezone)) {
          continue; // configured, but not inside its window right now
        }
        recurring = true;
      } catch (err) {
        undeterminable.push({
          priceListId: candidate.priceListId,
          priceListName: candidate.priceListName,
          reason: 'recurrence_rule_malformed',
          detail:
            err instanceof RecurrenceError ? err.message : 'unparseable rule',
        });
        continue;
      }
    }

    eligible.push({ candidate, tier: tierOf(candidate, recurring), recurring });
  }

  if (eligible.length === 0) {
    return {
      resolved: null,
      ambiguous: false,
      undeterminable,
      ...(undeterminable.length > 0
        ? {
            warning:
              'No price could be resolved. One or more candidate price lists carry a ' +
              'malformed recurrence rule and were not considered.',
          }
        : {}),
      ...base,
    };
  }

  const ranked = [...eligible].sort(compareRanked);
  const winner = ranked[0];

  const tied = ranked.filter((r) => compareRanked(winner, r) === 0);
  if (tied.length > 1) {
    return {
      resolved: null,
      ambiguous: true,
      warning:
        `Multiple price lists apply with equal precedence and equal priority ` +
        `(${tied.map((t) => t.candidate.priceListName).join(', ')}). SRS §7.3 ` +
        `forbids this configuration and the database constraint normally makes ` +
        `it unrepresentable; no winner was invented.`,
      undeterminable,
      ...base,
    };
  }

  const c = winner.candidate;
  return {
    resolved: {
      amount: Money.of(c.priceMinorUnits, c.currency),
      priceListId: c.priceListId,
      priceListName: c.priceListName,
      priceEntryId: c.entryId,
      scopeType: c.scopeType,
      orderType: c.orderType,
      priority: c.priority,
      tier: winner.tier,
      tierLabel: TIER_LABEL[winner.tier],
      recurring: winner.recurring,
      rule: describeRule(winner),
    },
    ambiguous: false,
    undeterminable,
    ...(undeterminable.length > 0
      ? {
          warning:
            'A price was resolved, but one or more candidate price lists carry a ' +
            'malformed recurrence rule and were not considered.',
        }
      : {}),
    ...base,
  };
}
