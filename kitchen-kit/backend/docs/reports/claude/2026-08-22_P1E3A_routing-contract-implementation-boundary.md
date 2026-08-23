# P1E-3A — Organisation Public Contract / Private Implementation Correction

**Date:** 2026-08-22
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Slice:** P1E-3A (narrow architecture correction on top of P1E-3)
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of work performed in this session.
The SRS and ratified governance decisions remain authoritative; nothing here
overrides them. P1E-3's database, RLS, routing persistence, Catalogue
modifier tenancy, Sales line-override substrate, and Kitchen routing
semantics were read as accepted per this slice's instructions and are **not**
reopened here — this report only corrects the one architecture defect that
acceptance review identified.

---

## A. STARTING STATE

- Branch `feat/production-spec`, HEAD `e5648fb`, unchanged throughout this
  slice — no commit was made before, during, or after this run.
- Prerequisite read: `docs/reports/claude/2026-08-21_P1E3_kds-routing-persistence-and-resolver.md`.
  P1E-3's `## R.` exit answers were all YES for the layers it built; `##
  Q.` classified FR-KDS-010 PARTIAL system-wide (no live caller). This
  slice does not change either of those classifications except where §L
  below explicitly narrows wording.
- Local dev DB (`ros`): 23 migrations found, 8 unapplied (the same 5
  pre-existing plus P1E-3's 3 new ones), sentinels
  `catalogue.price_lists=78`, `catalogue.modifiers=18`,
  `kitchen.station_routing_rules=0` — confirmed unchanged at the end of
  this slice too (§H).
- Unit suite at P1E-3's end: 51 suites / 690 tests. E2E suite: 26 suites /
  567 tests.

---

## B. DEFECT VERIFICATION

Read `src/modules/organisation/contract/routing-config.query.ts` as it
existed at the start of this slice (i.e., as P1E-3 left it) before touching
anything.

**Confirmed: the defect is real, not an overstatement.** The file contained,
in one place, under the `contract/` path:

- the public `RoutingConfigQueryInput` / `RoutingRuleRef` /
  `CategoryRoutingRuleRef` / `RoutingConfigResult` DTOs (legitimately
  public), **and**
- a concrete `@Injectable() export class RoutingConfigQuery` whose `find()`
  method issued direct Prisma calls — `tx.stationRoutingRule.findMany(...)`
  (×3) and `tx.branchKdsConfig.findUnique(...)` — and mapped the raw rows
  into the DTOs itself.

This is exactly the acceptance-review concern: `contract/` contained the
actual Organisation persistence implementation, not merely its published
interface. The existing `module-boundaries.spec.ts` import-path check could
not catch this, because the violation was never an illegal import path —
Kitchen legitimately imports `organisation/contract`. The violation was
*what the file at that legal path contained*. This is not a case where the
report overstated the issue; no "prove it's already correct" branch of this
slice's instructions applies.

---

## C. PUBLIC CONTRACT

`src/modules/organisation/contract/routing-config.query.ts` now contains
**interface, token, and DTOs only** — no class, no `@Injectable()`, no
Prisma query call:

```ts
export const ROUTING_CONFIG_QUERY = Symbol('ROUTING_CONFIG_QUERY');

export interface RoutingConfigQueryInput { ... }
export interface RoutingRuleRef { ... }
export interface CategoryRoutingRuleRef extends RoutingRuleRef { ... }
export interface RoutingConfigResult { ... }

export interface RoutingConfigQuery {
  find(tx: Prisma.TransactionClient, input: RoutingConfigQueryInput): Promise<RoutingConfigResult>;
}
```

`Prisma.TransactionClient` remains as a **type-only** parameter — this is the
accepted P1E-2/P1E-3 same-transaction pattern (SRS §5.5.1), not persistence
leakage; nothing in this file executes a query, and the file contains no
runtime-reachable Prisma call at all. `contract/index.ts` is unchanged
(`export * from './routing-config.query'` still re-exports everything —
now interface/token/types instead of interface/token/types/class).

This mirrors the repository's own established interface+token pattern
(`workforce/contract/commands.ts`'s `SHIFT_OPENER`/`ShiftOpener`,
`production/costing/recipe-cost.port.ts`'s `RECIPE_COST_RECOMPUTER`,
`localisation/tax/tax-class.port.ts`'s `TAX_CLASS_PROVISIONER`) rather than
inventing a new convention.

---

## D. PRIVATE IMPLEMENTATION

New file: `src/modules/organisation/routing-config/routing-config.query.service.ts`
— `@Injectable() export class RoutingConfigQueryService implements
RoutingConfigQuery`. Contains the exact Prisma logic P1E-3 wrote (moved
verbatim, not rewritten): the same three `stationRoutingRule.findMany`
calls, the same `branchKdsConfig.findUnique`, the same `select` clauses (no
`priority`, no raw model leakage), the same DTO-mapping. No routing
semantics were touched — this is a pure move.

Chosen path: `organisation/routing-config/` (smallest addition consistent
with the repository — a new leaf directory under the existing module, not a
broader `application/`/`infrastructure/` restructuring, which the prompt
explicitly said not to build).

---

## E. NEST DI

`organisation.module.ts`:

```ts
providers: [
  ...,
  RoutingConfigQueryService,
  { provide: ROUTING_CONFIG_QUERY, useExisting: RoutingConfigQueryService },
],
exports: [
  ...,
  ROUTING_CONFIG_QUERY,   // token only — see the deviation note below
],
```

**Deliberate deviation from the literal Workforce precedent, noted
explicitly:** `WorkforceModule` exports both `ShiftsService` (the concrete
class) and `SHIFT_OPENER` (the token). This slice exports **only**
`ROUTING_CONFIG_QUERY`, not `RoutingConfigQueryService` — nothing in the
repository needs the concrete class injectable by its own type, and not
exporting it is a strictly tighter public surface with no loss of
capability. This is a one-line, deliberate improvement on the existing
pattern, not a deviation that weakens it, and is called out here rather than
silently diverging from established convention.

---

## F. KITCHEN DEPENDENCY

`src/modules/kitchen/routing/routing-resolver.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { ROUTING_CONFIG_QUERY } from '../../organisation/contract';
import type { CategoryRoutingRuleRef, RoutingConfigQuery } from '../../organisation/contract';
...
constructor(
  @Inject(ROUTING_CONFIG_QUERY)
  private readonly routingConfig: RoutingConfigQuery,
) {}
```

The `import type` split for the interface (rather than a value import) is
required by `emitDecoratorMetadata` + `isolatedModules` on a decorated
constructor parameter — confirmed by matching the exact same split already
used at every other token+interface call site in this repository
(`cash-sessions.service.ts`'s `ShiftOpener`, `movements.service.ts`'s
`RecipeCostRecomputer`). Kitchen never imports `RoutingConfigQueryService`
or the `organisation/routing-config` path — verified both by direct source
inspection and mechanically (§G).

R1–R7 routing behaviour is **byte-for-byte unchanged**: no method body in
`routing-resolver.service.ts` was edited, only the constructor's injection
mechanism and the import split above. The 15 pre-existing resolver unit
tests were not modified and all still pass unchanged (§I) — direct
construction (`new RoutingResolverService(mockQuery)`) is unaffected by a
constructor parameter's `@Inject()` decorator, since decorators only affect
Nest's own DI container, not plain `new`.

---

## G. ARCHITECTURE ENFORCEMENT

Three new assertions added to `src/modules/module-boundaries.spec.ts`
(mechanical, not textual "contains the word Prisma" grepping):

1. **`containsPersistenceImplementation(source)`** — a shared detector
   function checking for BEHAVIOUR, not vocabulary: a `class` declaration, an
   `@Injectable()` decorator, or an actual Prisma query-method **call**
   (`.findMany(`, `.findUnique(`, `.create(`, `.update(`, `.delete(`,
   `.upsert(`, `.count(`, `.aggregate(`, `.groupBy(` — the call shape, not
   the type name). A type-only `Prisma.TransactionClient` parameter matches
   none of these and stays legal, exactly as instructed.
2. **Self-test proving the detector actually fires**, mirroring the existing
   `trusted-construction-boundary.spec.ts` convention: an inline fabricated
   bad-contract string (an `@Injectable()` class calling
   `tx.stationRoutingRule.findMany`) is asserted `true`; an inline
   fabricated clean-contract fixture (token + interface only) is asserted
   `false`.
3. **`organisation/contract/` contains no persistence implementation`** —
   every non-`.spec.ts` file under `organisation/contract/` is run through
   the detector; the current real file passes (asserts `false` for the
   corrected `routing-config.query.ts`).
4. **The concrete implementation is private and Kitchen never reaches it** —
   asserts `organisation/routing-config/routing-config.query.service.ts`
   exists AND that its content DOES trip the detector (proving it wasn't
   just deleted, but genuinely moved and still does real work); asserts
   Kitchen's resolver source contains neither the literal string
   `organisation/routing-config` nor `RoutingConfigQueryService`; asserts
   zero raw `violations` where `importer === 'kitchen'` and
   `inner.startsWith('routing-config')`.

All pre-existing P1E-3 module-boundary assertions (Kitchen imports only
`organisation/contract`; zero new `KNOWN_DEVIATIONS`; the full-tree "records
every pre-existing deviation, and no more" snapshot) are unchanged and still
pass — this slice added assertions, it did not relax or replace any.
**13/13 tests in `module-boundaries.spec.ts` pass** (10 pre-existing + 3
new).

---

## H. TRANSACTION / RLS EVIDENCE

New e2e file `test/routing-config-contract.e2e-spec.ts` boots
`Test.createTestingModule({ imports: [AppModule, KitchenModule] })` — real
Nest DI, real PostgreSQL, real RLS — and proves, against a real fixture
(tenant, brand, branch, station, menu item, one MenuItem-tier routing rule):

| Assertion | Result |
|---|---|
| `ROUTING_CONFIG_QUERY` resolves through DI to `RoutingConfigQueryService` | ✅ `toBeInstanceOf` |
| Kitchen's `RoutingResolverService` is wired to that same resolved instance | ✅ reference equality |
| The resolver correctly resolves a real MenuItem-tier rule end to end (DI + DB) | ✅ tier/stationIds/sourceIds all correct |
| The private implementation opens no second transaction | ✅ `prisma.$transaction` spy called exactly once (the one `withAuthContext` itself opened — Prisma has no nested interactive transactions, so a second one would have thrown, not silently run) |
| Tenant B session cannot read tenant A's routing config, even when the query `input` itself names tenant A | ✅ empty result — RLS enforced independently of the `WHERE` clause, not merely by it |
| Missing tenant context fails closed | ✅ empty result, no error |
| Query result shape is unchanged (plain DTOs, no Prisma model leakage) | ✅ exact key set and value match |

**7/7 passing.** This is the concrete proof, not merely an inference from
the source-level split, that moving the implementation out of `contract/`
did not disturb the accepted same-transaction/RLS behaviour.

---

## I. TESTS

- `routing-resolver.service.spec.ts` — **15/15**, unmodified, still pass
  (proves R1–R7 semantics are untouched).
- `module-boundaries.spec.ts` — **13/13** (10 pre-existing + 3 new, §G).
- `routing-config-contract.e2e-spec.ts` — **7/7**, new (§H).
- No test was skipped or marked `todo`.

---

## J. DATABASE / MIGRATION

**No production migration created or edited.** `schema.prisma` was not
edited by this slice (the only reason it shows in `git diff` is the
pre-existing P1E-3 diff against the old committed baseline — no new hunk
was introduced by this session; `prisma format`/`validate` are idempotent
and were run purely as regression checks). Migration count remains **23**.

Verification, exactly as required:

- `npx prisma format` — clean (no-op on top of the already-formatted
  P1E-3 state).
- `npx prisma validate` — "The schema at prisma/schema.prisma is valid."
- `npx prisma generate` — succeeded, Prisma Client 7.9.1.
- `ros_p1e3_scratch` dropped and recreated; `npx prisma migrate deploy`
  applied **all 23 migrations from zero**, no error.

---

## K. FILES CHANGED

**New:**
`src/modules/organisation/routing-config/routing-config.query.service.ts`,
`test/routing-config-contract.e2e-spec.ts`.

**Modified:**
`src/modules/organisation/contract/routing-config.query.ts` (implementation
removed; interface + token retained/added),
`src/modules/organisation/organisation.module.ts` (DI binding),
`src/modules/kitchen/routing/routing-resolver.service.ts` (injection
mechanism only — no behavioural change),
`src/modules/module-boundaries.spec.ts` (3 new contract-purity assertions).

No other file was touched. No migration file, no `schema.prisma` hunk, no
governance document, no permission, no route.

---

## L. REQUIREMENT CLASSIFICATION

Unchanged from P1E-3, restated verbatim per this slice's instructions (no
functional reclassification — wording-only correction where P1E-3's own
report had drifted):

- **FR-KDS-001: COMPLETE.**
- **FR-KDS-010: PARTIAL.** Reason: routing persistence/resolver exist, but no
  live Fire/Ticket caller exists.
- **FR-KDS-011: PARTIAL.** Reason: multi-station persistence/resolution
  substrate exists, but no live POS/Fire workflow exercises it yet. (P1E-3's
  own §Q had called this "COMPLETE at the persistence layer" — accurate as
  far as it went, but this slice's instructions are explicit that the
  *official* system-wide classification is PARTIAL, and this report adopts
  that wording exactly rather than repeating P1E-3's narrower framing.)

---

## M. P1E-3A EXIT

**P1E-3A CONTRACT/IMPLEMENTATION SPLIT COMPLETE: YES.** The public
`organisation/contract/routing-config.query.ts` is now interface + token +
DTOs only; the Prisma-backed implementation lives at
`organisation/routing-config/routing-config.query.service.ts`, a private
Organisation path.

**P1E-3A MODULE BOUNDARY COMPLETE: YES.** `module-boundaries.spec.ts` now
mechanically detects persistence-implementation leakage into any module's
`contract/` (not just Organisation's, and not just this one file — the
detector runs over every file in a module's `contract/` directory), proven
against both a fabricated bad example and the real corrected file; zero new
`KNOWN_DEVIATIONS`; Kitchen's only Organisation import remains
`organisation/contract`.

**P1E-3A TRANSACTION/RLS REGRESSION-FREE: YES.** §H's 7 tests prove the
private implementation still uses the caller's own transaction (no second
transaction opened), still enforces RLS independently of application-level
filtering, still fails closed with no tenant context, and returns the exact
same DTO shape as before the split.

**P1E-3A OVERALL COMPLETE: YES.**

---

## N. P1E-3 FINAL ACCEPTANCE

**P1E-3 FINAL ACCEPTANCE: YES.** The one architecture defect acceptance
review raised — a concrete, Prisma-backed, `@Injectable()` implementation
sitting directly inside `organisation/contract/` rather than behind it — is
confirmed real (§B) and is now corrected (§C–§F), with the correction
mechanically enforced against regression (§G) and proven not to have
disturbed the accepted transaction/RLS/routing-semantics behaviour (§H, §I).
P1E-3's persistence layer, RLS design, and resolver semantics — all
out-of-scope for reopening in this slice — remain exactly as P1E-3 left
them; only the one identified boundary defect changed.

---

## O. NEXT

**NEXT: TICKET / TICKETLINE ARCHITECTURE DESIGN CLOSURE.** Unchanged from
P1E-3's own §S recommendation — nothing in this slice's evidence points
anywhere else: the resolver still has no caller because Fire still does not
exist, and Fire's job is to create Kitchen-side state (Ticket/TicketLine)
that still does not exist anywhere in this repository. This slice does
**not** implement it — no table, model, service, or route for
Ticket/TicketLine exists in this run's changes.

---

## P. COMMIT READINESS

**COMMIT READY: YES.** The change is self-contained, narrow, passes every
verification this report ran (tsc, eslint, full unit + e2e suites,
migrations-from-zero, local-dev-DB-untouched check), and touches no file
outside the 5 listed in §K.

**COMMITTED: NO.** No commit was created in this session, per explicit
instruction. This report makes no attempt to draft a commit message or
stage files; that step is the user's to take.
