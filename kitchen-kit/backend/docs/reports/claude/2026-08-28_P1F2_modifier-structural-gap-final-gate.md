# P1F-2 — Modifier Structural Gap, Final Narrow Design Gate

**Report type:** Narrow design/conformance gate (analysis only — no product code, no migration, no governance change, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. **No governance is created or amended by this gate; no D-21+ exists.** The controlling design document remains `docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-correction.md` §L. This gate ratifies nothing; it determines whether an already-implemented fix conforms to existing authority, and records one accepted implementation-level extension.
**Date:** 2026-08-28
**HEAD:** `9aa7a880229938bffd2d5dc0dfcb3d263da060e8` (verified unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** unchanged from the 2026-08-28 acceptance closure, plus this report and its `INDEX.md` entry. No `src/`, `prisma/`, or `test/` file was touched by this gate.
**Task identifier:** P1F-2 modifier structural-gap final gate

> ## VERDICT (§O)
> ## **A. CURRENT FIX ACCEPTED — NO FURTHER IMPLEMENTATION**
> No authority — literal SRS, ratified governance, or the accepted P1F2E-A
> design — requires this **capture-time** modifier `no_published_version`
> condition to appear in `ORDER_COMPLETED.gaps`. The SRS has **no completion-
> audit gaps concept at all** (verified: zero matches across the full text);
> the governance register has **zero** occurrences of `modifier_recipe_effects`,
> `no_published_version`, or `ORDER_COMPLETED`; and P1F2E-A's own definition
> makes `ORDER_COMPLETED.gaps` **exactly** `planConsumption`'s gaps — which is
> literally what the implementation writes. The two governance clauses that
> *do* bind (D-17-07 ratified points 6 and 7) are **fully satisfied**: the
> dropped effect contributes nothing and can never be retroactively resurrected
> by a later publish, because Completion reads only pinned snapshot rows.
> Durable `ORDER_LINE_ADDED` audit evidence is therefore sufficient, and
> **migration 31 is NOT required**. One residual is recorded honestly and left
> unfixed (§F): `ORDER_COMPLETED.gaps` is *asymmetric* — the identical
> `no_published_version` reason reaches it for a **base-recipe** sub-recipe but
> not for a **modifier-target** sub-recipe. That asymmetry is a legibility
> inconsistency, not a conformance failure, correctness failure, or immutability
> failure. Separately confirmed (§E): BR-MNU-012's "recipes requiring
> completion" report does **not** surface this condition and is **not required
> to** — recorded as future-slice debt, not a P1F-2 acceptance defect.

---

## A. THE CONDITION, EXACTLY

A `production.modifier_recipe_effects` row with `operation = 'add'`,
`component_type = 'sub_recipe'`, whose target recipe has **no published
version** at OrderLine capture time.

Current behaviour, traced in `consumption-resolution.service.ts`
(`resolveModifierEffects`): the effect is **not** persisted into
`sales.order_line_modifier_effects`, and a
`{modifierId, sequence, reason:'no_published_version'}` record is returned in
`ResolveConsumptionBasisResult.droppedModifierEffects` and written by
`order-lines.service.ts` into the **`ORDER_LINE_ADDED`** audit metadata.

It cannot be persisted into the snapshot table because that table's own
constraint forbids it:

```sql
CONSTRAINT "ck_olme_component_xor" CHECK (
  ("component_type" = 'stock_item'  AND "stock_item_id" IS NOT NULL AND "sub_recipe_version_id" IS NULL)
  OR
  ("component_type" = 'sub_recipe'  AND "sub_recipe_version_id" IS NOT NULL AND "stock_item_id" IS NULL)
)
```

A `sub_recipe` row **requires** a non-null `sub_recipe_version_id`. There is no
version to name. Consequently `planConsumption` never sees the effect, and
`ORDER_COMPLETED.gaps` — which is built solely from `planConsumption`'s output
(`sales-payment.service.ts:580` → `600`) — does not contain it.

---

## B. QUESTION 1 — DOES ANY AUTHORITY REQUIRE THIS IN `ORDER_COMPLETED.gaps`?

Answered per layer, separately, as required.

### B.1 Literal SRS — **NO. Silent.**

Verified directly from `ROS_SRS_v1.0.pdf` via `pdftotext -layout`, not from any
secondary report:

- **There is no SRS "completion audit gaps" concept.** A search of the full
  extracted text for any occurrence of "gap" co-occurring with
  completion/audit/depletion returns **zero results**. `ORDER_COMPLETED.gaps` is
  entirely a **P1F2E-A design construct**, not an SRS-mandated field.
- The SRS's own `Order.complete()` reference pseudocode (§24.2.4) names
  `orderId, branchId, businessDay, lines, totals, payments, completedAt,
  customerId` — **no gaps field**, as the prior implementation report already
  recorded.
- **BR-MNU-012**, verbatim (SRS line 2752): *"An item MAY be sold with an
  incomplete or absent recipe. The System SHALL permit the sale, SHALL record
  zero or partial cost, and SHALL list the item in a 'recipes requiring
  completion' report."* Three obligations — permit the sale, record zero/partial
  cost, list the item in a report. **None is an audit-placement obligation**,
  and all three are about *an item's recipe*, not a modifier's effect target.
- **FR-MNU-013** (the modifier "recipe delta" requirement) is marked **[S]
  (SHOULD)**, not [M], and governance explicitly keeps its wider surface
  deferred.

The SRS therefore imposes **no requirement whatsoever** on where this condition
is recorded. It cannot be violated by either placement.

### B.2 Ratified governance — **NO. Satisfied by the current fix.**

`docs/governance/GOVERNANCE_DECISION_REGISTER.md` contains **zero occurrences**
of `modifier_recipe_effects`, `no_published_version`, or `ORDER_COMPLETED`
(grepped). The two clauses that genuinely bind are in
**"P1F-2 Completion Economics & Depletion Resolution — 2026-08-25", Ratified §2
(D-17-07 narrowly reopened)**:

> 6. **Modifier consumption semantics used by a sale MUST be snapshotted** at
>    sale time, so later modifier or master-data edits cannot change historical
>    depletion.
> 7. **Completion MUST consume the sale-time resolved modifier-depletion
>    facts**, never re-interpret today's modifier master data.

Both are **satisfied**, and their stated *purpose* is met exactly:

- The dropped effect contributes **nothing** to depletion.
- Publishing that sub-recipe **tomorrow cannot retroactively change** this
  completed order's depletion, because Completion resolves only against pinned
  `order_line_modifier_effects` / `order_line_recipe_versions` rows, and no row
  exists for it. The historical depletion is immutable — which is precisely
  what clause 6 exists to guarantee.
- Completion never re-reads `production.modifier_recipe_effects`. **Verified**:
  `modifierRecipeEffect` appears nowhere in `src/` outside
  `src/modules/production/` (grepped, excluding generated client) — clause 7 holds
  structurally, not merely by convention.

Clause 6's phrase is *"modifier consumption semantics **used by a sale**."* The
dropped effect was **not used** — it contributed zero. The semantics actually
used were snapshotted in full.

### B.3 Accepted P1F2E-A design — **NO, not literally. Conformant as written.**

P1F2E-A §L specifies:

```
- Audits: PAYMENT_CAPTURED (unchanged) AND new ORDER_COMPLETED (entity 'order',
  before{state,version,paidTotal}, gaps, movement ids, posted COGS).
```

and defines the only producer of gaps:

```
2. planConsumption(tx, {lines:[...]}) -> { perLine:[{orderLineId,
     components:[...], gaps[]}] }   COMPLETION ONLY.
```

The implementation writes `ORDER_COMPLETED.gaps = planResult.perLine.flatMap(pl => pl.gaps)` —
**exactly and only** `planConsumption`'s gaps. That is literal conformance to the
accepted design.

P1F2E-A **never addresses** a capture-time-unresolvable modifier effect anywhere
in §L or its body. It is genuinely silent on the condition — which is why the
original implementation had discretion here at all, and why the P1F-2
implementation report recorded the behaviour as an explicit documented deviation
(§H.3) rather than a design violation.

### B.4 Implementation convenience — where the residual actually lives

This is the only layer with a real objection, and it is a **quality**
observation, not a conformance one. See §F.

### B.5 Answer

**Durable `ORDER_LINE_ADDED` audit evidence is sufficient.** No authority
requires `ORDER_COMPLETED.gaps` to carry this condition.

Durability of that evidence was verified, not assumed:

| Property | Evidence |
|---|---|
| Append-only at the DB level | `GRANT SELECT, INSERT ON governance.audit_entries TO ros_app; REVOKE UPDATE, DELETE, TRUNCATE ... FROM ros_app` (migration `20260812175712_governance_audit_entries`) |
| Tamper-evident | `entry_hash` / `previous_hash` chain on every entry |
| Tenant-scoped | RLS `ENABLE`+`FORCE`, `ros_app` is `NOBYPASSRLS` |
| Content survives verbatim | `sanitizeMetadata` recurses through arrays and objects preserving structure; `FORBIDDEN_KEY` (`/pass\|secret\|token\|hash\|authorization\|cookie\|fingerprint\|api[_-]?key\|refresh\|credential\|mfa\|bearer/i`) matches **none** of `modifierId`, `sequence`, `reason`. Empirically confirmed by the passing acceptance-closure test asserting the exact stored object. |
| Precisely keyed | Entry `entityId` is the `orderLineId`; payload carries `modifierId`, `sequence`, `reason` |

---

## C. QUESTION 2 — IS `droppedModifierEffects` A VALID CONTRACT EXTENSION?

P1F2E-A §L D gives a controlling result shape:

```
1. resolveConsumptionBasis(tx, {tenantId, recipeVersionId|null, modifierIds[]})
     -> { versionClosure[], modifierEffects Map, conversions[] }
     LINE CAPTURE ONLY. Returns NO resolved/net consumption quantities and NO
     money; configured modifier ADD quantities and pinned conversion factors ARE
     part of it.
```

The implementation added a fourth member, `droppedModifierEffects`.

**Finding: a VALID implementation-level extension. No narrow design amendment is
required.** Reasons, in order of weight:

1. **The design's constraints on this return are stated as prohibitions**, and
   the new field violates neither. "Returns **NO** resolved/net consumption
   quantities and **NO** money" — `{modifierId, sequence, reason}` is neither a
   quantity nor money. It carries two identifiers and a closed enum drawn from
   the design's own gap taxonomy.
2. **The three listed members are a persistence-mapping spec, not an exhaustive
   struct definition.** Their role in §L is "Call Production's
   `resolveConsumptionBasis` ONCE and persist all THREE snapshots" — the three
   members map 1:1 onto the three Sales snapshot tables. The new member is
   explicitly **not** persisted to a snapshot table and does not disturb that
   mapping, which remains exactly three-for-three.
3. **It crosses none of P1F2E-A's actual fences.** No new persistence concept,
   no migration, no new table or column, no governance change, no new
   permission, no OpenAPI change (confirmed still 3.1.0 / 135, zero drift).
4. **The design is silent on the condition**, so the implementation
   *necessarily* had discretion. Returning the fact is strictly more truthful
   than the alternative the design's silence had permitted (silent discard), and
   it cannot change depletion by construction — the value is never read by
   `planConsumption`.
5. **Module boundaries are unaffected**, verified mechanically:
   `module-boundaries.spec.ts` 31/31 with `KNOWN_DEVIATIONS` unchanged.

**Recorded, not ratified:** this gate creates no governance. It records
`droppedModifierEffects` as an **accepted implementation-level extension of the
P1F2E-A §L published result shape**, already documented in the acceptance-closure
report §I. A future author reading §L should treat the three-member arrow as the
persistence mapping it is, and this entry as the record of the fourth,
non-persisted member.

---

## D. QUESTION 3 — SMALLEST TRUTHFUL DESIGN, IF IT *WERE* REQUIRED

Presented conditionally. **It is not required (§B), so none of B/C should be
built now.** All four options were evaluated against the stated rejection
criteria.

### Option A — existing line-capture audit only (**CURRENT**)

- Migration: **none**.
- Truthful: yes — records exactly what was known, when it was known.
- Durable / append-only / tenant-scoped / tamper-evident: yes (§B.5).
- Rejection criteria: violates **none**. Completion consults no mutable
  Production master data; Sales queries no other module's private tables; no
  sentinel version is invented; the STRUCTURAL gap stays structural (the sale
  completes); BR-MNU-012's permit-the-sale clause is honoured; no historical
  meaning is lost; append-only/tenancy/RLS untouched; no governance invented.
- Shortfall: the condition is absent from `ORDER_COMPLETED.gaps` (§F).
- **Verdict: VIABLE — and the accepted option.**

### Option B — additional immutable Sales capture persistence

A new append-only table, e.g. `sales.order_line_dropped_modifier_effects`
(`tenant_id, business_day, order_line_id, order_line_modifier_id, sequence,
reason`), SELECT+INSERT only, RLS `ENABLE`+`FORCE`, composite tenant-safe FKs —
matching the three existing snapshot tables exactly. Completion reads it and
merges its rows into the per-line `gaps` array.

- Migration: **31 required** (new table).
- Truthful: yes — names no version, invents no sentinel.
- Rejection criteria: violates none.
- Cost: a whole new table, its RLS, its grants, its FKs, its Prisma model and
  back-relations, and a new Completion read — for one edge case that currently
  has exactly one known trigger.
- **Verdict: VIABLE but disproportionate.** Cleanest invariant of the three, but
  the highest structural cost.

### Option C — extension of an existing snapshot representation

Relax `ck_olme_component_xor` on `sales.order_line_modifier_effects` to admit
`component_type='sub_recipe' AND sub_recipe_version_id IS NULL`, plus a
discriminator column (e.g. `unresolved_reason`) so a null pin is never ambiguous
with a data error. `planConsumption` then sees a pinned effect it cannot
resolve and emits `no_published_version` — **reproducing the base-recipe path
exactly**, which makes this the most *symmetric* design (§F).

- Migration: **31 required** (`ALTER ... DROP/ADD CONSTRAINT`, plus `ADD COLUMN`).
- Truthful: yes — no sentinel version; the null is explicitly discriminated.
- Note: `ck_olme_operation`'s `add => quantity > 0 AND unit_id IS NOT NULL` is
  **not** an obstacle — an unresolved sub-recipe ADD legitimately has both.
- **Material risk:** it weakens a currently-absolute invariant — *"a `sub_recipe`
  snapshot row always names a real pinned version"* — on which every present and
  future reader of that table implicitly relies. Every such reader would have to
  learn to handle a null pin. That is a durable cost paid by all future code to
  serve one edge case.
- **Verdict: VIABLE; smallest *if* co-location were mandatory**, because it
  reuses an existing table and reproduces the existing base-recipe mechanism
  rather than inventing a parallel one — but it buys symmetry by weakening a
  real invariant.

### Option D — another existing approved persistence location

**None genuinely fits.** Each candidate was examined and rejected on stated
grounds:

| Candidate | Rejected because |
|---|---|
| `sales.order_line_recipe_versions` | FK `(tenant_id, recipe_version_id) → production.recipe_versions(tenant_id,id)` RESTRICT — there is no version to reference. Pinning the target's **draft** version would both **invent a sentinel** *and* cause `planConsumption` to expand an unpublished recipe, **changing depletion**. Rejected on two independent grounds. |
| `governance.audit_entries`, **read at Completion** | Would make audit evidence **load-bearing domain state** (a category error — audit records what happened; it must not drive what happens), and would require Sales to query another module's table. Rejected. |
| `catalogue.modifiers.recipe_delta` | Governance D-17-07 ratified point 1 keeps it **permanently opaque and uninterpreted**; P1F2E-A's NON-GOALS repeat "NEVER read `catalogue.modifiers.recipe_delta`". Rejected. |
| `inventory.sale_depletion_effects` | The effect produced **no depletion**; a zero-quantity effect row would be false (and `ck_sda_quantity_positive` / the effect's own semantics forbid it). Rejected — would lose historical meaning. |

### Ranking, conditional on the requirement existing

**C < B** on structural footprint; **B < C** on invariant preservation. Both
require migration 31. **Neither is warranted**, because the requirement does not
exist (§B).

---

## E. QUESTION 4 — DOES BR-MNU-012's REPORT ALREADY SURFACE THIS?

**NO.** Verified from repository evidence, not assumed.

`src/modules/production/costing/recipe-completeness.service.ts` is the
implementation of BR-MNU-012's third clause. Its structural walk
(`structuralGaps`) issues exactly one kind of query:

```ts
const lines = await tx.recipeLine.findMany({
  where: { recipeVersionId: { in: frontier } },
  select: { recipeVersionId: true, componentType: true, subRecipeId: true },
});
```

It reads **`production.recipe_lines` only**. It never reads
`production.modifier_recipe_effects` — nor could it, meaningfully: the report is
keyed **sellable variant → applicable recipe → recipe-line graph**, and a
modifier's effect target is not reachable from that graph at all. The service's
own docblock defines its scope explicitly:

> *"a published version with no components, or one naming a **sub-recipe** that
> has no published version"*

— i.e. recipe **lines**, not modifier effects.

**Consequence:** a menu item whose own recipe is perfectly complete, sold with a
modifier whose ADD effect targets an unpublished sub-recipe, under-depletes — and
that item appears **nowhere** in the "recipes requiring completion" report.

**Is that a BR-MNU-012 violation? No.** BR-MNU-012's text governs *"an item …
sold with an incomplete or absent **recipe**"*. The item's recipe is complete.
Modifier recipe effects are a **P1F-2 invention** (the D-17-07 resolution
replacing the permanently-opaque `recipe_delta`), postdating BR-MNU-012, and
FR-MNU-013 is **[S]** with its wider surface explicitly deferred by governance.
The report is neither required to cover them nor wrong for not doing so.

**Recorded as honest, future-slice debt, not a P1F-2 acceptance defect:** the
operator-facing completeness surface has a blind spot for modifier-target
sub-recipes. Closing it is a **Production reporting** change (extend
`structuralGaps` to also walk `modifier_recipe_effects` for modifiers linked to
each variant), needs **no migration**, and is **out of scope for P1F-2** — whose
completion path is what is under acceptance here. It is noted so a future slice
can pick it up deliberately rather than rediscover it.

---

## F. THE RESIDUAL, STATED HONESTLY

The current design produces a real **asymmetry** in `ORDER_COMPLETED.gaps` for
one and the same reason code. Both paths were traced in code:

| Path | Capture time | Completion time | In `ORDER_COMPLETED.gaps`? |
|---|---|---|---|
| **Base recipe** names a sub-recipe with no published version | `walkClosure` omits it from the pinned closure (and *knows* it is unpublished — it called `publishedVersionOf` and got null) | `expandVersion` finds the live `recipe_lines` row, cannot resolve `versionIdByRecipeId`, pushes `{reason:'no_published_version'}` | **YES** |
| **Modifier ADD** targets a sub-recipe with no published version | `resolveModifierEffects` drops it (cannot persist — XOR CHECK) and records it in `ORDER_LINE_ADDED` | `planConsumption` never sees it — nothing to notice | **NO** |

The mechanical reason for the difference: `planConsumption` re-reads recipe
**structure** live (published `recipe_versions` are DB-frozen, so this is safe
and was accepted design), and merely *resolves* sub-recipes against pinned
versions — so the base-recipe row survives to be noticed. Modifier effects have
no live-structure counterpart Completion is permitted to read; they exist at
Completion **only** as pinned snapshot rows. The dropped one has no row, so it
is unnoticeable by construction.

An honest assessment of the consequence, without overstating it:

- **What is wrong:** a consumer reading `ORDER_COMPLETED.gaps` could conclude
  the completion had no structural gaps when a modifier effect was in fact
  dropped. The array is, for that one condition, silently incomplete relative to
  a natural reading of "structural gaps affecting this completion."
- **What is *not* wrong:** nothing is lost (the fact is durably recorded,
  keyed to the same order line); depletion is correct and immutable; the sale
  correctly completes per BR-MNU-012; no valuation failure is manufactured; no
  invariant is weakened. This is **not** a recurrence of the original defect —
  the original defect was *total* loss with zero trace anywhere, which is fixed.
- **Classification:** a **legibility inconsistency**, not a conformance,
  correctness, or immutability failure. It is recorded here rather than fixed,
  because fixing it costs migration 31 to satisfy a requirement no authority
  states, at the final acceptance edge of the slice.

If the user later prefers co-location over migration stability, **Option C** is
the design to adopt, and this section is the rationale to revisit.

---

## G. QUESTION 5 — IS MIGRATION 31 REQUIRED?

**NO.** Not written, and correctly not written.

Migrations remain exactly **30**. Migration 31 would become necessary **only if**
the user elects the §F co-location improvement (Option C, or Option B), which no
SRS requirement, no ratified governance clause, and no P1F2E-A provision
mandates.

---

## H. VALIDITY OF THE 2026-08-28 ACCEPTANCE EVIDENCE

**All other P1F-2 acceptance evidence from `2026-08-28_P1F2_acceptance-closure.md`
remains valid in full and does NOT need to be rerun.**

This gate is analysis only: **no `src/`, `prisma/`, or `test/` file was modified**,
so nothing that evidence measured has changed. Specifically still valid, unrerun:

- Concurrency matrix 5/5 scenarios × 3 clean runs (9 tests in
  `order-completion-concurrency-2` + the 6 prior).
- Structural FK negative proofs 6/6 (`order-completion-structural`).
- Historical pinning / gap semantics / modifier composition 10/10
  (`order-completion-pinning`) — **including the §5 finding test**, which asserts
  the exact behaviour this gate has now accepted.
- RLS / append-only / grants 21/21 (`order-completion-rls`).
- Unit **732/732**, E2E **793/793**, `module-boundaries` **31/31**
  (`KNOWN_DEVIATIONS` unchanged).
- Migrations **30**, clean-from-zero verified; OpenAPI **3.1.0 / 135**, zero drift.
- Persistent local `ros` DB untouched (26 `_prisma_migrations` rows).
- NFR-PERF-006 **PARTIAL** (p50 ≈ 1195 ms, p95 ≈ 2120 ms vs ≤ 200 ms target).

Because the verdict is **A**, there are **no tests to rerun** — not even a
regression pass — as no code changed. Had the verdict been B or C, the rerun set
would have been: `order-completion-pinning` (the §5 finding test), `order-completion-rls`
(if a new table were added), plus full unit + full E2E regression.

---

## I. REQUIREMENT CLASSIFICATIONS — UNCHANGED

This gate changes **no** classification recorded in
`2026-08-28_P1F2_acceptance-closure.md` §N. FR-INV-012/013 (completion path),
FR-INV-022/023, FR-INV-030, BR-INV-003 (completion path), FR-CST-001 and
FR-POS-024 remain COMPLETE; FR-INV-027 substrate-only; FR-CST-002,
NFR-PERF-006, §1.2 / UC-POS-01 remain PARTIAL.

**BR-MNU-012** remains as previously classified for the completion path (permit
the sale + zero/partial cost + report, all implemented). This gate adds one
honest, newly-verified scope note (§E): the report's structural walk does not
cover modifier-target sub-recipes — recorded as future-slice debt, not a
reclassification, because BR-MNU-012's text governs an item's recipe and modifier
recipe effects postdate it.

---

## J. WHAT WAS NOT DONE

No product code. No migration. No governance change. No `D-21+`. No test
authored, modified, or run. No commit. No push. No destructive git command. The
three preserved user files (`.gitignore`, `src/main.ts`,
`src/scripts/seed-dev-data.ts`) untouched. `prisma.config.ts` untouched.

---

## K. OPEN ITEMS HANDED TO THE USER (neither fixed nor decided here)

1. **`ORDER_COMPLETED.gaps` asymmetry (§F)** — accepted as-is. Adopt Option C if
   co-location is later preferred over migration stability; requires migration 31.
2. **BR-MNU-012 report blind spot for modifier-target sub-recipes (§E)** — a
   Production **reporting** change, no migration, out of P1F-2 scope.

---

## O. FINAL VERDICT

# **A. CURRENT FIX ACCEPTED — NO FURTHER IMPLEMENTATION**

No Sonnet implementation prompt is provided, because none is required.

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).
