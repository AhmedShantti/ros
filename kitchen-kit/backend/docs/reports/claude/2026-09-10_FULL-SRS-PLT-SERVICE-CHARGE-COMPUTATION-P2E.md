# FULL-SRS-PLT-SERVICE-CHARGE-COMPUTATION-P2E — Real Service-Charge Computation

**Report type:** Implementation report (evidence, not governance).
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
This task implements against the already-RATIFIED `P2A-R1` and `P2D-R1`
entries and makes **no new governance decision**. Every semantic choice
this report records that is not already fixed by SRS text or ratified
governance is explicitly derived, in §2, from an existing, already-shipped
precedent in this codebase — never invented to "finish the task."
**Date:** 2026-09-10
**HEAD at task start:** `c0a14df` (tip of `full-srs/lane-d4-reporting-demo`
— the P2D-CORRECTION report's hash-recording commit).
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** clean except pre-existing untracked report
files from earlier tasks in this session (not part of this task's diff).
**Task identifier:** `FULL-SRS-PLT-SERVICE-CHARGE-COMPUTATION-P2E`

---

## 0. Baseline verification

```
$ git rev-parse HEAD
c0a14df3c028233986cee0ae2cbc6229deb473c4
$ git log -15 --oneline
c0a14df docs(reports): record commit hash in P2D-CORRECTION report
e304f8e test(sales): strengthen ServiceChargePolicy precedence + anti-backdating evidence (P2D-CORRECTION)
aaa41ed docs(reports): record commit hash in FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D report
8715474 feat(sales): ServiceChargePolicy configuration substrate (P2D-R1)
19e5746 docs(reports): record commit hash in FULL-SRS-PLT-CASH-ROUNDING-PROVIDER-EXCLUSIVE-P2C1-IMPL report
b5f67d5 fix(platform-settings,localisation): payments.cash_rounding_policy is Country-Pack provider-exclusive (P2C1-R1)
9a7da00 docs(governance): ratify P2C1-R1 and P2D-R1 (cash-rounding provider-exclusivity + ServiceChargePolicy config semantics)
...
```

`c0a14df` ancestry confirmed: `P2D-CORRECTION` (`e304f8e`→`c0a14df`) sits
directly on top of `P2D` (`8715474`→`aaa41ed`), which sits directly on top
of the `P2C1-R1`/`P2D-R1` governance ratification (`9a7da00`). `git status`
at task start was clean except pre-existing untracked reports from earlier
tasks this session.

---

## 1. Mission recap

Implement REAL service-charge computation using the already-pinned
`ServiceChargePolicy` version (P2D/P2D-R1's configuration substrate).
Primary targets `FR-PLT-028`, `FR-POS-055`; `FR-POS-058` only to the extent
current Country Pack/tax-engine semantics make it unambiguous. No
frontend, no new governance/design report before implementation, no pull/
merge/push.

---

## 2. Semantic preflight (before any financial code was changed)

Four questions had to be settled from SRS + ratified governance + existing
computation precedent before writing any code. All four were determined —
**no `P2E_SEMANTIC_BLOCKER` was raised.**

### A. Deterministic rule matching when multiple rules match

Not decided anywhere: `P2D-R1`'s own "Not decided by this entry" section
explicitly named this "a P2E evaluation-logic decision, not a P2D
storage-shape decision." Determined here from two existing, shipped
precedents in this exact domain (both cited in
`service-charge-evaluation.ts`'s own docblock):

1. `tax.calculator.ts`'s `resolveTaxClass` — an order-type-specific
   override REPLACES a base (order-type-agnostic) tax class WHOLE. A rule
   naming a specific `orderType` is, by identical logic, more specific
   than a rule with `orderType: null` and wins over it.
2. `minGuestCount` is a ONE-SIDED THRESHOLD, never a range (`maxGuestCount`
   is explicitly not invented — `P2D-R1` clause 3). The only
   mathematically coherent reading of several co-configured thresholds for
   the same order type is a graduated structure: the HIGHEST threshold the
   order's `guestCount` still satisfies is the most specific applicable
   rule — the same "narrowest qualifying band wins" shape
   `price-resolution.ts`'s own tier system already applies, generalised to
   one numeric dimension.

**Result:** rank (1) `orderType`-specific beats wildcard, (2) among ties,
highest SATISFIED `minGuestCount` wins. A TRUE tie (identical on both
discriminators — a genuine configuration duplicate, not a graduated
structure) is never resolved by array order: it throws
`ServiceChargeRuleAmbiguityError`, mirroring `price-resolution.ts`'s own
"no winner is invented" handling of its own genuinely tied candidates.

### B. Monetary base for `ratePercent`

`Order.subtotal` — the SRS's own Order-entity table names it explicitly:
"Minor units, before discount and tax." It is the one pre-existing,
unambiguously-defined "lines" figure already computed by
`recomputeOrderTotals` on every call, requiring no new concept.

### C. Interaction with existing discounts/comps

Service charge is applied to `subtotal` and added to `grandTotal` as an
INDEPENDENT term — never adjusting, or adjusted by, `discountTotal`.
Determined directly from `discounts.service.ts`'s own existing, documented
precedent for order-level discount: *"An order-level discount does NOT
reduce any line's taxable base or tax amount... applied POST-TAX, as a
straight subtraction from `grandTotal` only... This is a recorded scoping
decision, not an oversight."* Extending that SAME "isolated straight term"
treatment to service charge — rather than inventing a NEW cross-term
apportionment rule that does not exist anywhere in this codebase (BR-FIN-003
distribution is explicitly unimplemented for order-level discount too) —
is the conservative, precedent-consistent choice. This yields exactly the
formula the task itself states as the required invariant: `grandTotal =
subtotal - discountTotal + serviceChargeTotal + taxTotal` (with
`taxTotal`/line-level-discount effects already folded into the
per-line-summed shape `recomputeOrderTotals` has always used).

### D. Exact rounding mechanism

The order's PINNED `countryPackVersion`'s `tax.roundingMode`/
`tax.roundingPrecision` — the SAME fields line-tax computation already
uses, loaded via the SAME `CountryPackService.requirePinned(countryCode,
order.countryPackVersion)` call every existing line-tax path already
makes. Never an independent hardcoded mode (BR-FIN-001: "rounded exactly
once... using the applicable Country Pack rounding policy"; FR-FIN-035:
"rounding mode and rounding point SHALL be specified by the country
pack"). The Country Pack schema carries no SEPARATE "service charge
rounding policy" field, and none is invented — `tax.roundingMode`/
`roundingPrecision` is the pack's one rounding policy.

### E. `serviceChargeTaxable` → tax-engine mapping — genuinely blocked, narrowly

`pack.tax.serviceChargeTaxable` is a bare boolean (`country-pack.model.ts`
line 138: "Carried for the service-charge slice; unused until that
exists"). It says WHETHER service charge is taxable, never WHICH tax
class/rate/component applies when it is. Every existing line-tax
computation path REQUIRES a `taxClassCode` resolved against
`pack.tax.classes`; no Country Pack field names one for service charge.
Per this task's own explicit instruction ("Do NOT hardcode a tax rate or
tax class... report `FR_POS_058_BLOCKER` and leave that portion open"),
this is `FR_POS_058_BLOCKER` — see §8. Per the task's equally explicit
instruction, **this narrow gap does NOT block the core service-charge
amount**, which is fully implemented (§3-§7).

---

## 3. Pinned-policy-only resolution

Computation NEVER re-resolves today's tenant→brand→branch policy. It
reads exactly `Order.serviceChargePolicyVersionId` (set once, at open, by
the P2D/P2D-R1 resolver — untouched by this task) and loads that EXACT
immutable row (`tx.serviceChargePolicy.findUnique({where: {id, tenantId}})`
inside `computeServiceChargeTotal`, `order-totals.ts`). `NULL` pin →
`0n`, immediately, no further lookup. `rules: []` → `0n` (no rule can ever
match an empty array). Proven end-to-end by e2e test 15/16 (§7): a V1
version pinned at open time, a V2 created later, both a first AND a
second line-mutation recompute on the SAME order, and a brand-new order
opened after V2 exists — V1's amount and pin are unchanged on the
historical order; only the new order picks up V2.

---

## 4. Rule evaluator

`src/modules/sales/service-charge-policy/service-charge-evaluation.ts` —
new file, PURE, no I/O (mirrors `price-resolution.ts`/`tax.calculator.ts`'s
own discipline for exactly this reason: ADR-004/BR-FIN-005/FR-OFF-050).

- `evaluateServiceChargeRule(rules, {orderType, guestCount})` — filters to
  matching rules (§2.A's semantics: `orderType: null` = all; non-null
  `minGuestCount` requires a non-null `guestCount >=` it, and a null
  `guestCount` never satisfies ANY non-null threshold, `0` included), then
  ranks by specificity and returns the single winner or `null`. Throws
  `ServiceChargeRuleAmbiguityError` on a true tie.
- `computeServiceChargeAmount(base, ratePercentUnscaled, ratePercentScale,
  roundingMode, roundingPrecision)` — mirrors `VatStandardStrategy.
  computeLine`'s single-component, exclusive-pricing formula (`tax_i =
  round(net * n_i / D)`) exactly, using the SAME `divideRounded`/`pow10`
  primitives, rounding EXACTLY ONCE.

**Never mutates or re-validates the pinned rule-set** — trusts the
already-parsed, already-immutable rows as-is.

15 unit tests (`service-charge-evaluation.spec.ts`), all passing — every
required scenario in §3/§8's enumerated list, plus specificity-ranking and
the true-tie-throws case.

---

## 5. Order-totals integration

`order-totals.ts`'s `recomputeOrderTotals` — the SAME single, canonical
full-re-derivation function every write path (line capture, pre-fire void,
discount/comp application, post-fire void) already shared before this
task — now ALSO computes `serviceChargeTotal`, via a new private
`computeServiceChargeTotal` helper in the SAME file. `OrderTotalsResult`
gained one field (`serviceChargeTotal: bigint`); `grandTotal`'s formula
became `grandTotalFromLines - orderLevelDiscountMinor + serviceChargeTotal`
— §2.C's independent-term formula, added in exactly one place.

**No independent `serviceChargeTotal` update was sprinkled anywhere** — all
six existing call sites (`order-lines.service.ts` ×2, `discounts.service.ts`
×3, `post-fire-void.service.ts` ×1) needed only ONE change each: pass the
already-injected (or newly-injected, for `PostFireVoidService`)
`CountryPackService` through as a new trailing parameter. `order-totals.ts`
itself resolves the small amount of additional context it needs (the
order's `branchId`/`orderType`/`guestCount`/`countryPackVersion`/
`serviceChargePolicyVersionId`, plus the branch's `countryCode`) via two
additional indexed reads inside itself, rather than requiring every caller
to expand its own `select` — the safer, less error-prone design given five
different call sites.

`Order.orderType`/`guestCount` are immutable post-open (an established
`P2D-R1` rationale point), so re-evaluating the rule-set fresh on every
`recomputeOrderTotals` call — rather than caching a winning rule anywhere —
costs one extra indexed read per call and carries zero staleness risk.

`Order.serviceChargePolicyVersionId` is **never** written again after
`OrdersService.create` pins it (this task made no change to
`orders.service.ts`) — proven by e2e test 16 (§7).

---

## 6. Payment integration

**No change was made to `sales-payment.service.ts`.** It already reads
`order.grandTotal` fresh from the row loaded at the start of its own
transaction (`const isSettling = newPaidTotal >= order.grandTotal`), and
that row is always the CURRENT state after the last `recomputeOrderTotals`
call — so once `Order.grandTotal` correctly includes the service charge,
payment settlement is correct automatically, with zero code changes.
Proven end-to-end by e2e test 13/14 (§7 and §8 list item 14): paying
exactly `subtotal + taxTotal` (the total WITHOUT the service charge) only
reaches `partially_paid`; paying the remaining service-charge amount on
top settles the order to `completed`.

---

## 7. Historical V1 proof (`FR-PLT-028`)

New e2e test `15/16` in `test/service-charge-computation.e2e-spec.ts`:

1. Policy V1 created (branch-level, `10%`, real wall-clock time).
2. An instant `t1` captured by the TEST PROCESS itself, strictly after V1's
   INSERT committed.
3. An order opened at `t1` — pins V1 (`serviceChargePolicyVersionId ===
   v1.id`).
4. A line added — `serviceChargeTotal` is genuinely non-zero (1000, 10% of
   10000).
5. Policy V2 created (`99%`, real wall-clock time, strictly later).
6. A SECOND line added to the SAME (historical) order — the pin is
   UNCHANGED (`=== v1.id`, `!== v2.id`), and the recomputed amount is still
   V1's `10%` of the new, larger subtotal (2000) — never V2's `99%`.
7. A BRAND-NEW order opened now (after V2) at the SAME scope correctly
   pins V2.

This is the key evidence this task's §7 names as required to move
`FR-PLT-028` from PARTIAL to COMPLETE — every one of `FR-PLT-028`'s named
financial-setting categories (tax class, rounding policy, service charge)
is now genuinely exercised by a real, non-zero computation that respects
its own effective-dated version, never today's.

---

## 8. Required functional tests (task §8)

All in `test/service-charge-computation.e2e-spec.ts` unless noted (unit
tests noted separately) — **14/14 e2e, 15/15 unit, all passing:**

| # | Scenario | Where | Result |
|---|---|---|---|
| 1 | no pinned policy => 0 | e2e #1 | ✅ |
| 2 | `rules: []` => 0 | e2e #2 | ✅ |
| 3 | matching orderType => non-zero | e2e #3 | ✅ (1000 = 10% of 10000) |
| 4 | non-matching orderType => 0 | e2e #4 | ✅ |
| 5 | minGuestCount satisfied => charge | e2e #5 | ✅ |
| 6 | minGuestCount not satisfied => 0 | e2e #6 | ✅ |
| 7 | guestCount null does not satisfy a positive minimum | e2e #7 + unit | ✅ |
| 8 | wildcard orderType/null condition | e2e #8 | ✅ |
| 9 | exact-decimal percentage | e2e #9 | ✅ (9999 × 12.5% → HALF_UP → 1250) |
| 10 | rounding follows pinned Country Pack | e2e #10 (dedicated `ZZ` HALF_DOWN pack, isolated) + unit | ✅ (0.5 → 0 under HALF_DOWN, vs. → 1 under HALF_UP in the same unit suite) |
| 11 | recalculation after line mutation | e2e #11 | ✅ (1000 → 2000 as subtotal doubles) |
| 12 | discount/comp interaction (§2.C semantic) | e2e #12 | ✅ (service charge unchanged by a 2000-unit order-level discount) |
| 13 | grandTotal includes service charge exactly once | e2e #13/14 | ✅ |
| 14 | payment balance uses new grandTotal | e2e #13/14 | ✅ (short payment → `partially_paid`; full → `completed`) |
| 15 | historical V1 pin unaffected by newer V2 | e2e #15/16 | ✅ |
| 16 | `serviceChargePolicyVersionId` immutable | e2e #15/16 | ✅ |
| 17-19 (`FR-POS-058`) | not implementable — see §2.E/§8 blocker | — | intentionally not attempted |

---

## 9. Receipt / event / read model

Inspected first, per this task's instruction. `receipt.views.ts`,
`sales.views.ts`, `contract/events.ts` (the `order.completed` payload
type) **already read `order.serviceChargeTotal`/`taxTotal`/`grandTotal`
straight off the persisted row** — pre-existing scaffolding from before
this task, confirmed unmodified and confirmed now correct automatically
the moment the column is genuinely populated. **No changes were made to
any of these three files.**

The ONE change made: `receipt.views.ts`'s `deriveTaxPresentation` docblock
corrected a now-stale factual claim — it previously asserted `UNDETERMINED`
is "structurally unreachable... whenever `taxTotal != 0`"; that was already
imprecise for any order carrying a line-level discount (POS-FIN-1), and
this task's non-zero `serviceChargeTotal` makes it unambiguously reachable
for any order with a matching service-charge rule. **The comparison LOGIC
itself was not changed** — `UNDETERMINED` is (and always was) an honest,
designed fallback, not an error; the docblock now says so accurately. 18/18
`receipt.views.spec.ts` unit tests unaffected.

No new event design, no new route, no new unrelated projection.

---

## 10. Scope discipline

Confirmed unchanged: `P2D-R1` governance, `ServiceChargePolicy` storage
architecture, the JSONB rule schema, `Order.openedAt` as the governing
instant, permissions, the admin route design (no controller/DTO/route
touched at all), cash rounding, tax (line-level computation untouched),
`P2C1`. **Zero Prisma schema/migration changes** — `serviceChargeTotal`
was already an existing, previously-always-zero column. Not implemented,
per this task's explicit exclusion list: tips, tip pooling, PRC, POS
cancellation, combos, tables, CRM, reporting architecture, frontend, any
ServiceChargePolicy governance/storage redesign.

---

## 11. Requirement status

- **FR-PLT-025 / FR-PLT-026 / FR-PLT-027** — **COMPLETE**, unchanged.
- **FR-PLT-028** — **COMPLETE.** Tax class and rounding policy were
  already versioned/effective-dated and genuinely interpreted historically
  (P1C/P2C1). Service charge — the third named category — is now ALSO
  genuinely versioned, effective-dated, and interpreted at its historical
  transaction time (§7's proof), with a real non-zero computation, never a
  fabricated placeholder. All three named financial-setting categories are
  now genuinely exercised.
- **FR-POS-055** — **COMPLETE.** Automatic percentage-based service
  charge, configurable per branch (P2D's tenant→brand→branch hierarchy),
  per order type (`orderType` rule field), and conditional on guest count
  (`minGuestCount` rule field), now genuinely computes a real amount for a
  real order via a deterministic evaluator.
- **FR-POS-058 — remains NOT COMPLETE, explicitly.** `serviceChargeTaxable`
  is read from the pack (implicitly, by never applying tax when it is
  irrelevant) but the CORE requirement — correctly applying whatever tax
  the country pack's rule implies — cannot be implemented without a
  Country-Pack field this schema does not have (§2.E/§8 blocker). Never
  falsely closed.

---

## 12. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npm run openapi:generate` | run; **empty diff** — no controller/DTO/route touched |
| `npx prisma validate`/`generate` | not run — zero schema change (confirmed via `git status --short prisma/`) |
| `npx eslint` (all 8 changed/new files) | clean, 0 errors, 0 warnings after prettier auto-fix + 2 real findings fixed (1 unused var, 1 redundant local) |
| New unit — `service-charge-evaluation.spec.ts` | **15/15** |
| `service-charge-policy` unit suite (unchanged, regression) | **12/12** |
| New e2e — `service-charge-computation.e2e-spec.ts` | **14/14** |
| `service-charge-policy.e2e-spec.ts` (P2D/P2D-CORRECTION, regression) | **27/27** |
| Full local unit suite (89 suites) | **1229/1229** |
| Targeted e2e regression: `sales`, `sales-lines`, `sales-fire`, `sales-payment` ×2, `platform-settings`, `receipt`, `order-completion` | **226/227** — the 1 failure is the SAME pre-existing, unrelated `/orders/reason-codes` route-list assertion documented in both the original P2D and P2D-CORRECTION reports; `orders.controller.ts` has zero diff from this task |
| `order-completion-pinning`/`-structural`/`-rls`, `pos-financial-corrections` | **81/81** |
| `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` | **55/55**, zero new `KNOWN_DEVIATIONS` |

No full E2E suite run, per this task's own instruction.

---

## 13. Files changed

**New:**
- `src/modules/sales/service-charge-policy/service-charge-evaluation.ts`
  (pure rule evaluator + exact-decimal money computation)
- `src/modules/sales/service-charge-policy/service-charge-evaluation.spec.ts`
  (15 unit tests)
- `test/service-charge-computation.e2e-spec.ts` (14 e2e tests)

**Modified:**
- `src/modules/sales/orders/order-totals.ts` — `serviceChargeTotal`
  computed and folded into `grandTotal`; new `CountryPackService`
  parameter
- `src/modules/sales/orders/order-lines.service.ts` — 2 call sites pass
  `this.countryPacks` through
- `src/modules/sales/orders/discounts.service.ts` — 3 call sites pass
  `this.countryPacks` through
- `src/modules/sales/orders/post-fire-void.service.ts` — `CountryPackService`
  newly injected; 1 call site passes it through
- `src/modules/sales/receipt.views.ts` — `deriveTaxPresentation` docblock
  correction only, no logic change

No Prisma schema/migration file, no controller, no DTO, no OpenAPI file
touched.

---

## 14. Commit

Implementation, tests, and this report + `INDEX.md` are committed together
as `IMPLEMENTATION_COMMIT` below. No generated OpenAPI/Prisma files needed
inclusion (both empty-diff). No push. A second, docs-only follow-up commit
records the resulting hash into this report, per this session's
established convention.

`IMPLEMENTATION_COMMIT`: *(recorded after commit — see §15)*

---

## 15. Post-commit hash record

*(Updated by the docs-only follow-up commit.)*

---

## 16. Blockers or uncertainties

**One explicit, narrow blocker: `FR_POS_058_BLOCKER`** (§2.E/§8) — the
Country Pack schema's `tax.serviceChargeTaxable` boolean carries no
companion field naming which tax class/rate/component a taxable service
charge would use. This does not block, and did not block, the core
service-charge amount computation (`FR-POS-055`, `FR-PLT-028`), which is
fully implemented and proven. Closing it would require either a new,
explicitly-ratified Country Pack field (a governance action, out of this
task's scope) or discovering an existing field this investigation missed
— neither was found. No workaround was fabricated.

No other blockers. `PLT_SETTINGS_WORKSTREAM_CLOSED` (`FR-PLT-025/026/027/028`
all COMPLETE) — the narrow `FR-POS-058` gap is a Country-Pack-schema
limitation, not an open item within the PLT financial-settings workstream
itself.
