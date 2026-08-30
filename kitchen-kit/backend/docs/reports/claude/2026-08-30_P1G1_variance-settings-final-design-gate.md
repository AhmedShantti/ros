# P1G-1 — Variance Tolerance / Settings Substrate FINAL DESIGN GATE

**Task / slice:** P1G-1 CashSession Close — variance tolerance & cash-count-mode settings substrate
**Report type:** Design / analysis gate. **No product implementation, no migration, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order is
**(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` and ratified governance decisions → (3) the repository at HEAD `1f9ea1f` → (4) prior reports (`2026-08-28_P1G1_cash-close-design-gate.md`, `2026-08-29_APPROVAL_*`) → (5) engineering inference, labelled as such.**
Where this report and the SRS or the register differ, **they govern**. Prior report prose is corrected in §0.3 where current code or current source text gives stronger evidence.
**Date:** 2026-08-30
**HEAD:** `1f9ea1f` — *feat: add governance approval runtime* (unchanged throughout; no commit performed)
**Branch:** `feat/production-spec`
**Working tree at start:** `INDEX.md` modified; four uncommitted prior reports untracked (`2026-08-26_MVP_…`, `2026-08-27_RENDER_…`, `2026-08-28_P1G1_…`, `2026-08-28_POST-P1F2_…`). All left byte-identical.
**Working tree at report time:** the above, plus this report, plus one appended `INDEX.md` row. **No product code, no migration, no test change.**
**Migrations at HEAD:** 32 (verified by directory count). **OpenAPI at HEAD:** 3.1.0 / 138 operations (cited from the accepted Approval Runtime report; not re-executed in this session).
**Task identifier:** P1G-1 variance/settings final design gate

> ## VERDICT
> ## **C. USER RATIFICATION REQUIRED — NARROW ITEMS PROVIDED**
>
> The settings substrate is **fully designed and implementation-writable** except for
> **four narrow decisions**, of which **two are migration-critical** (R-1 tolerance
> representation, R-4 approval-expiry source) and **two are P1G-1-behaviour-critical**
> (R-2 comparison semantics, R-3 which effective version governs a session).
> Per §32 of the brief, **no Sonnet implementation prompt is issued.**
>
> Everything else resolved **without invention**, including three items the prior gate
> and the brief expected to be blockers:
> * **Write authorization is SOURCE-DECIDED** — `settings.branch.manage` is in SRS §15.2 **and is already seeded in this repository**. The brief's §25 premise ("no source-named permission") is **false**; corrected in §0.3.
> * **The tolerance default is NOT needed.** Fail-closed (no configured policy → no cash close) is a *derived* consequence, not an invention, and it removes the default from the migration-critical set.
> * **`entity_type` is repository-decided** (`AUDIT_ENTITY.CASH_SESSION = 'cash_session'` already exists) and **`request_type` is implementation-owned vocabulary**, design-decidable now.

---

## 0. WHAT WAS ACTUALLY READ, AND THREE CORRECTIONS

### 0.1 Sources read at HEAD `1f9ea1f`

| Source | What was extracted |
|---|---|
| `ROS_SRS_v1.0.pdf` (6,510 lines, `pdftotext -layout`) | §6.4 cascade, FR-PLT-025/026/027/028, §7.2 Money, §7.3 aggregate catalogue, §8.7 FR-POS-090…097, §12.6 FR-PRC-041/042, §15.2 permission catalogue, §15.4 SoD, §15.6 FR-SEC-030…035, §16.2 FR-FIN-001…007, §19 FR-RPT-045, §20 FR-AUD-002…006, §21.3 offline local data model, §22.2 country pack, §25.1 schema organisation |
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (6,387 lines) | **D-13 (thresholds domain-owned, RATIFIED)**, D-16 (`request_type` OPEN), D-10 (expiry, no default duration), D-15, D-9, D-14 A-1, D-20, and the *Approval Runtime Minimum Resolution — 2026-08-29* entry |
| `docs/adr/0008-organisation-foundation.md` | **D-11 (`org.settings` DEFERRED)** verbatim, D-01 (permission codes), D-09 (composite tenant-safe FKs), D-03/D-12 |
| `ROS_DrawDB_Compatible_v3.sql` | `org.settings`, `identity.tenants.settings`, `org.brands.default_settings`, `org.branches.base_currency`, `treasury.*` |
| Repository | `prisma/schema.prisma` (3,380 lines), all 32 migrations' grant/RLS shape, `modules/{treasury,organisation,governance,localisation,identity}`, `module-boundaries.spec.ts`, `audit.constants.ts` |
| Prior reports | `2026-08-28_P1G1_cash-close-design-gate.md`, `2026-08-29_APPROVAL_runtime.md`, `2026-08-29_APPROVAL_ratification-recorded.md` |

### 0.2 The three settings artefacts that exist, and their status

| Artefact | Status at HEAD | Evidence |
|---|---|---|
| `identity.tenants.settings JSONB DEFAULT '{}'` | **INERT.** Column exists (`schema.prisma:185`). No service reads it, no service writes it, no validation, no resolver, no versioning, no lock, not surfaced by any endpoint. | Exhaustive grep over `src/modules` |
| `org.brands.default_settings JSONB DEFAULT '{}'` | **STORE-AND-ECHO ONLY.** `BrandsService` accepts it on create/update and `BrandView` returns it verbatim as `unknown`; the OpenAPI description is literally *"Opaque default-settings JSON, as stored."* No resolver, no schema, no precedence, no lock, no version. | `brands.service.ts:55,124`, `brand.view.ts:7,17`, `organisation.controller.ts:90-92` |
| `org.settings` (the approved-SQL cascade table) | **DOES NOT EXIST.** Never migrated. Deferred by **ADR 0008 D-11**. | 32 migrations; no `settings` table in `schema.prisma` |

**ADR 0008 D-11 verbatim, and it is decisive for §11 of the brief:**
> *"the approved table cannot satisfy its own mandatory requirements: it models three of the six cascade levels FR-PLT-025 specifies (no Platform Default, no Country Pack, no Terminal), has no `locked` column for FR-PLT-026 [M], and no effective-dating for FR-PLT-028 [M]. It also has **no `tenant_id`**, and `scope_id` is a polymorphic UUID with no FK — so it cannot be RLS-anchored as designed… Whatever is eventually built must carry `tenant_id` and a `scope_type`-aware ownership check from the first migration."*

### 0.3 Three corrections to prior prose

1. **CORRECTION — write authorization is NOT undecidable.** The brief's §25 instructs that if no source-named permission authorises settings changes, write authorization is `NOT SOURCE-DECIDABLE`. **A source-named permission exists.** SRS §15.2 "Governance & Platform" lists **`settings.branch.manage` — "Branch configuration"** and **`settings.tenant.manage` — "Tenant configuration"**, and both are **already seeded in this repository** (`organisation.permissions.ts:21,24`, ratified by ADR 0008 D-01, MFA-mandatory per FR-SEC-024). A per-branch cash-close policy is *branch configuration* by the catalogue's own wording. **SOURCE-DECIDED.** Nothing is invented.

2. **CORRECTION — the prior gate (§6) says variance tolerance's level is "branch or tenant — not stated by any source".** That is right about tolerance, but incomplete: **FR-PLT-025 §6.4 states the full six-level cascade verbatim** (Platform Default → Country Pack → Tenant → Brand → Branch → Terminal). The hierarchy *is* source-decided; what is not source-decided is *which levels a cash tolerance may be defined at*. Corrected in §9.

3. **CORRECTION — the country pack cannot be the tolerance source.** §22.2 gives the pack's shape verbatim (`currency`, `tax`, `invoice`, `fiscal`, `labour`, `calendar`, `legal`). **No cash-variance tolerance, no drawer limit, no count mode appears anywhere in it**, and the repository's `country-pack.model.ts` models only the currency and tax blocks. A country-pack-derived tolerance has **no source support**.

---

## 1. SOURCE REQUIREMENTS — TRACED EXACTLY

All quotations are verbatim from `ROS_SRS_v1.0.pdf`.

| ID | Verbatim / exact meaning | Classification |
|---|---|---|
| **FR-FIN-005 [M]** | *"Cash variance SHALL be computed as **Counted Cash − Expected Cash** and SHALL be recorded on the session."* | **SOURCE-DECIDED** — variance is **signed**. |
| **FR-FIN-006 [M]** | *"**Variance beyond a configurable tolerance** SHALL require **a reason** and **approval by a user with `cash.variance.approve`**, who **SHALL NOT be the session owner**."* | **SOURCE-DECIDED** — configurability, reason, permission code, non-self-approval. **NOT decided:** the tolerance's dimension, its default, and whether the comparison is on the signed or absolute variance. |
| **FR-POS-096 [M]** | *"Shift close SHALL compute and record cash variance, and SHALL require **a reason and manager acknowledgement** when **variance exceeds a configurable tolerance**."* | **SOURCE-DECIDED.** Second, independent use of a strict-inequality verb ("exceeds"). FR-FIN-006 is the **stricter** of the two (named permission + non-self-approval) and therefore governs; satisfying FR-FIN-006 satisfies FR-POS-096. |
| **FR-POS-094 [M]** | *"Shift close SHALL require a physical cash count. The System SHALL support both **blind count** (expected amount hidden until after entry) and **open count**, **configurable per branch**."* | **SOURCE-DECIDED** — the configuration level is **branch**, literally. |
| **FR-POS-095 [M]** | *"**Blind count SHALL be the default configuration.**"* + rationale (*"a shortage can be concealed by 'counting' the expected number"*). | **SOURCE-DECIDED** — the default **is** `blind`. A DB/application default is therefore *authorised*, not invented. |
| **FR-PLT-025 [M]** | *"…hierarchical settings resolver with the precedence above"* — §6.4: **Platform Default → Country Pack → Tenant Setting → Brand Setting → Branch Setting → Terminal Setting**, *"A value set at a lower level overrides a higher level, unless the higher level marks it locked."* | **SOURCE-DECIDED** — six levels, exact order, override-downward semantics. |
| **FR-PLT-026 [M]** | *"A setting SHALL be **markable as locked at any level, preventing override at lower levels**. Locked settings SHALL be **visibly indicated in the UI at lower levels with the locking level named**."* | **SOURCE-DECIDED** — lock prevents *override at lower levels*, and the resolver must be able to *name* the locking level. **NOT decided:** whether a lock also freezes the locking level's own value; whether a lock is itself effective-dated; lock inheritance mechanics. |
| **FR-PLT-028 [M]** | *"Settings that **affect financial computation** (tax class, rounding policy, service charge) SHALL be **versioned with effective dates**, and **historical transactions SHALL be interpreted with the setting version in force at their transaction time, never the current version**."* | **SOURCE-DECIDED for its named scope.** Whether cash-variance tolerance falls inside *"affect financial computation"* is **NOT SOURCE-DECIDABLE** (§7). |
| **FR-POS-092 [M]** | *"Safe drops SHALL be enforceable by a **configurable drawer limit** that triggers a prompt or a block when exceeded."* | Out of scope; **compatibility only** (§15). |
| **§7.2 Money / BR-CORE-001** | `Money { amount: bigint /* minor units */, currency: Currency /* ISO 4217 + exponent */ }`; *"Arithmetic between different currencies SHALL raise an error."* | **SOURCE-DECIDED** — integer minor units, ISO currency, no float, no cross-currency arithmetic. |
| **FR-AUD-006 [M]** | Actions that **SHALL always** generate audit entries include *"**cash variances**"* and *"**configuration changes**"*. | **SOURCE-DECIDED** — both the settings write and the variance outcome must be audited. |
| **FR-SEC-016 [M]** | *"The System SHALL **block, not merely warn**… approving one's own cash variance."* + §15.4 SoD pair `cash.session.close (own)` × `cash.variance.approve`. | **SOURCE-DECIDED** — DB-level block required; already implemented by the Approval Runtime's `excluded_approver_user_id` fourth conjunct. |
| **FR-SEC-024 [M]** | MFA mandatory for any role holding `settings.tenant.manage`. | **SOURCE-DECIDED** — noted; MFA enforcement is not in this slice. |
| **§25.1** | Schema `org` contains *"brands, branches, warehouses, central_kitchens, stations, tables, **settings**"*. | **SOURCE-DECIDED** for a *generic* settings table's physical home. Silent about narrow typed domain configuration (§12). |

### 1.1 What the SRS does when it *does* decide a tolerance's shape or default — the negative evidence

This matters more than any other single finding, because it proves the silence in FR-FIN-006 is **deliberate**:

| Requirement | The SRS's own words |
|---|---|
| **FR-PRC-041 [M]** three-way match | A table of four tolerances, each with a **stated dimension and default**: *"Quantity: invoice vs receipt — **Configurable, default 0%**"*; *"Unit price: invoice vs PO — **Configurable, default 2%**"*; *"Total: computed vs stated — **1 minor unit** (rounding)"*; *"Tax: computed vs stated — **1 minor unit**"*. |
| **FR-INV-046 [M]** | *"Variances exceeding a configurable threshold (**by percentage or value**)"* — the dimension is named explicitly when both are meant. |
| **FR-POS-047 [M]** | Discount thresholds *"**Per role, per branch**"*, with max percentage **and** max absolute amount as separate configured facts. |
| **FR-KDS-025 [M]** | *"retained for a configurable period (**default 30 minutes**)"* — and this repository honoured it: `BranchKdsConfig.recallWindowSeconds Int @default(1800)`. |
| **FR-KDS-029 [M]** | configurable period, **no default named** — and this repository honoured *that*: `cancelledLineVisibilitySeconds Int?`, **nullable, no `@default`**, docblocked *"no source text authorizes a guessed number"*. |
| **FR-FIN-006 [M]** | *"a configurable tolerance"* — **no dimension, no default, no level, no percentage/value disjunction.** |

**Conclusion (REPOSITORY-DECIDED precedent + SOURCE evidence):** the SRS states a tolerance's dimension and default wherever it intends one. Its silence in FR-FIN-006 is therefore evidence of *non-decision*, not of an implied zero. The `FR-KDS-025` vs `FR-KDS-029` pair is this repository's own ratified handling of exactly this asymmetry and is followed literally below.

---

## 2. IS THERE A SOURCE-ESTABLISHED VARIANCE DEFAULT? — §4 ANSWERED

**Investigated and rejected, each with evidence:**

| Candidate authority for a default | Finding |
|---|---|
| Zero tolerance | **No source.** No SRS text, no governance ratification, no ADR, no approved-SQL column default. Zero would silently make *every* one-piastre variance an approval event — a fabricated financial control. |
| Unlimited tolerance | **No source, and affirmatively unsafe.** An unlimited default makes FR-FIN-006 [M] unreachable — the approval branch could never fire. This is the one option that **contradicts a mandatory requirement**. |
| Fixed currency amount | No source *for a value*. (The *representation* question is separate — §3, R-1.) |
| Percentage tolerance | No source *for a value*. |
| Country-pack-derived | **No support.** §22.2's pack has no cash block; `country-pack.model.ts` models only currency + tax (§0.3 correction 3). |
| Branch default / tenant default | No source names a level for tolerance at all (FR-POS-094 names branch for *count mode* only). |
| Governance register / ADRs | Searched: `D-13` explicitly says *"**No threshold amount is proposed here**"* and *"no SRS requirement states a threshold amount, a storage location, a precedence rule, or an owner."* |

### **TOLERANCE DEFAULT: `NOT SOURCE-DECIDABLE`. No value is invented in this gate.**

### 2.1 The three questions the brief asks — answered

**A. Is "configuration required before first cash close" a valid fail-closed design consequence? — YES.**

It is **derived, not chosen**. FR-FIN-006 [M] requires the system to determine whether a variance is *beyond a configurable tolerance*. With no configured tolerance the predicate is **undefined**. Only three behaviours are available:
* close and skip the control → **violates FR-FIN-006 [M]**;
* close using an assumed value → **invents a financial control threshold**;
* **refuse to close until the tolerance is configured** → violates nothing and invents nothing.

The third is the only option that neither breaks a mandatory requirement nor fabricates a number. It is also consistent with **FR-PLT-012 [M]** fail-closed posture already ratified for this repository's data layer, and with the *"NULL = not yet configured; a future slice supplies a value, not this one"* precedent already in `branch_kds_config`.

**B. Does it create a new business requirement requiring ratification? — It creates an operational CONSEQUENCE, not a new requirement.**
The consequence is real and must be stated plainly to the user: *a branch cannot close a cash session until a `settings.branch.manage` holder has configured that branch's cash-close policy.* Because the alternative is violating a `[M]` requirement, this is classified **DESIGN-DECIDABLE NOW (derived)**, and is surfaced as **acknowledgement item R-5** — an acknowledgement, **not a blocker**. If the user *wants* a system-wide default instead, that value must be ratified (it would be R-1b), and that would be a new business decision.

**C. Is a default value therefore migration-critical? — NO.**
The unconfigured state is represented by **the absence of any policy version row**, not by a column default. The `variance_tolerance` column is `NOT NULL` **with no `DEFAULT`** in every candidate schema, so no migration decision depends on a default existing. **This removes the tolerance default from the migration-critical set entirely** and is the single most important unblocking finding in this gate.

**Contrast — count mode is the opposite case.** FR-POS-095 [M] *states* the default. A DB `DEFAULT 'blind'` is therefore **source-authorised**, exactly as `recall_window_seconds DEFAULT 1800` was for FR-KDS-025.

---

## 3. WHAT EXACTLY IS THE TOLERANCE? — §5

**Source wording is the whole of the evidence:** FR-FIN-006 *"a configurable tolerance"*; FR-POS-096 *"a configurable tolerance"*. **No dimension is stated.** §1.1 proves the SRS names the dimension when it means to (`0%`, `2%`, `1 minor unit`, *"by percentage or value"*).

| Option | Source support | Engineering assessment |
|---|---|---|
| **A. Fixed money amount in minor units** | None *specific*; but §7.2/BR-CORE-001 give an exact, non-lossy representation, and the SRS uses *"1 minor unit"* tolerances elsewhere (FR-PRC-041). | **RECOMMENDED.** Exactly representable as `BIGINT`, no rounding rule needed, no degenerate case. Directly comparable with `variance`, which FR-FIN-005 defines in the same units. |
| **B. Percentage of expected cash** | None. | Requires a rounding rule the SRS does not supply (§7.2 `times(factor, rounding)` demands an explicit `RoundingMode`), and **degenerates**: expected cash can be zero (float 0, no sales) or negative (net pay-outs/safe drops exceed float + sales), making a percentage tolerance either 0 or sign-inverted. Choosing a rounding mode and a zero-expected fallback would be **two further inventions**. |
| **C. Both (hybrid)** | None. | Requires a *third* invention: whether "beyond tolerance" means beyond **both** or beyond **either**. FR-INV-046's *"by percentage or value"* shows the SRS says so when it means it; FR-FIN-006 does not. |
| **D. Another form** | None found. Exhaustive search of §16, §8.7, §15, §6.4, the register and the approved SQL yields no other candidate. |

### **TOLERANCE REPRESENTATION: `NOT SOURCE-DECIDABLE` → USER RATIFICATION REQUIRED (R-1). MIGRATION-CRITICAL.**

No representation is assumed anywhere below; §12/§28 present the schema for **R-1 option (a)** and state exactly what changes under (b)/(c).

---

## 4. CURRENCY SEMANTICS — §6

Applies if R-1 = (a) or (c).

| Question | Answer | Classification |
|---|---|---|
| Does `CashSession` already have a currency? | **YES.** `CashSession.currency String @db.Char(3)`, docblocked *"Snapshot of the branch's authoritative currency at open. Never client-supplied."* | **REPOSITORY FACT** |
| What is the currency source? | `org.branches.base_currency CHAR(3)` — SRS §7.3 #5 key invariant: *"one timezone; one base currency"*. Present in the approved SQL and in `schema.prisma:601`. | **SOURCE + REPOSITORY FACT** |
| Is it branch/base currency? | **Yes** — the branch's base currency, mirrored onto the session at open. `CashMovement.currency` follows the same pattern. | **REPOSITORY-DECIDED** |
| Must the tolerance configuration itself store a currency? | **YES.** A bare `BIGINT` tolerance is meaningless without its currency, and BR-CORE-001 forbids implicit cross-currency arithmetic. The policy version carries `currency CHAR(3) NOT NULL`. | **DESIGN-DECIDABLE** (compelled by BR-CORE-001) |
| Can the setting be reused across a currency change? | **NO — and it must not be.** If a branch's `base_currency` changes, the stored tolerance is denominated in the *old* currency. The resolver compares `policy.currency` to `cashSession.currency` and, on mismatch, **fails closed** with a distinct error requiring a new policy version in the new currency. Silent reuse would be exactly the cross-currency arithmetic BR-CORE-001 prohibits. | **DESIGN-DECIDABLE** (compelled by BR-CORE-001) |
| Historical correctness across a currency change | Guaranteed by the two mechanisms together: **effective-dated immutable versions** (§5) pin *which* policy applies, and each version carries its **own** currency. A session opened under EGP resolves an EGP-denominated version even after the branch moves to another currency. | **DESIGN-DECIDABLE** |

**No floating money anywhere.** `BIGINT` minor units only, per §7.2 and every existing money column in this repository (`opening_float`, `amount`, `price`, `grand_total`, `cogs_total`).

---

## 5. IS VARIANCE TOLERANCE A "FINANCIAL SETTING"? — §7

### 5.1 Does FR-PLT-028 literally apply?

FR-PLT-028's scope is *"Settings that **affect financial computation** (tax class, rounding policy, service charge)"*. All three named examples **change a monetary amount**. The cash variance tolerance **does not**: `variance = counted − expected` (FR-FIN-005) is computed identically at any tolerance. The tolerance changes a **control gate** (was approval required?), not a computed figure.

**Classification: whether FR-PLT-028 *literally* covers the cash variance tolerance is `NOT SOURCE-DECIDABLE`.** Two readings survive the text and neither can be eliminated from source.

### 5.2 Why this does not need ratification — the design takes the stricter posture

Adopting effective-dated, immutable versioning **satisfies FR-PLT-028 under the reading where it applies, and violates nothing under the reading where it does not.** A stricter posture cannot contradict a requirement that does not attach. It is additionally *independently required* by §17's historical-proof mandate. Therefore:

### **DESIGN-DECIDABLE NOW: the cash-close policy is stored as effective-dated, immutable versions, irrespective of how FR-PLT-028's scope is read. No ratification is consumed by this choice.**

**Cash count mode** is a *behavioural* setting (which screen the cashier sees) and is even further from *"financial computation"*. It is **not** independently subject to FR-PLT-028; it inherits versioning for free by living on the same policy version row, at zero extra cost. Recorded so no later reader infers that FR-PLT-028 was found to apply to it.

### 5.3 What "version / effective" means here, exactly

| Mechanic | Decision | Basis |
|---|---|---|
| Version identity | A **row**, not a counter. `id UUID` is the version's permanent identity; no `version_number` column (nothing in source requires an ordinal, and `effective_from` already orders them). | DESIGN-DECIDABLE |
| Effective dating | `effective_from TIMESTAMPTZ NOT NULL`. No `effective_to` — a version is superseded implicitly by the next row for the same branch. | DESIGN-DECIDABLE; mirrors the country-pack `effectiveFrom` model (§22.2) rather than `price_lists`' closed window, because settings supersede rather than expire |
| Immutable historical versions | **Yes, at the database.** `GRANT SELECT, INSERT` only; `REVOKE UPDATE, DELETE, TRUNCATE FROM ros_app`. RLS defines SELECT + INSERT policies only. | FR-PLT-028 *"never the current version"*; precedent `treasury.cash_movements`, `inventory.stock_movements`, `governance.approval_decisions` |
| Updates create new versions | **Yes** — the only write is an INSERT of a new version. | Consequence of the above |
| Editing an existing effective version | **Impossible** — no UPDATE grant, no UPDATE policy. Not an application rule. | DB-enforced |
| Cancelling / replacing a future version | **NOT possible in this slice, and deliberately so.** A future-dated version cannot be deleted (no DELETE) and cannot be edited (no UPDATE). Superseding it requires inserting another version with an `effective_from` between now and it. **Recorded as a known limitation**, not silently omitted. Adding a cancellation capability would need its own authorization semantics, which no source supplies. | DESIGN-DECIDABLE + honest gap |
| Is audit alone sufficient? | **No.** FR-AUD-006 requires configuration changes be audited, but FR-PLT-028 requires the *value* be re-readable as-of a past instant. An append-only audit trail records the change; it is not a resolution surface. **Both** are required: DB immutability **and** an audit entry. | SOURCE (FR-AUD-006 + FR-PLT-028) |
| **Backdating** | **FORBIDDEN, structurally.** `CHECK (effective_from >= created_at)`, with `created_at` excluded from the column-level `GRANT INSERT` so `ros_app` cannot supply it (exact precedent: `governance.approval_decisions`' column-level grant omitting `decided_at`, empirically verified in migration 32). | DESIGN-DECIDABLE — see §5.4, this is load-bearing |
| Future-dating | **Permitted** (`effective_from > created_at`), consistent with FR-MNU-023's future-dated price changes and §22.2's pack `effectiveFrom`. | DESIGN-DECIDABLE |

### 5.4 Which version controls a CashSession? — the temporal question, answered honestly

| Candidate | Argument for | Argument against |
|---|---|---|
| **A. Version effective at CashSession OPEN, resolved lazily at close** | (i) **Repository precedent, exact:** `Order.countryPackVersion` is pinned at order **creation** (`orders.service.ts:278`) and a *later* payment reads `order.countryPackVersion` (`sales-payment.service.ts:224`) — FR-LOC-021's *"in force at their transaction time"* is implemented in this repository as **the aggregate's own opening instant**, honoured by every later step. FR-PLT-028 uses **identical wording**. (ii) **Control:** combined with the backdating prohibition (§5.3), the answer becomes **immutable from the moment the session opens** — a manager cannot widen tolerance mid-drawer to cover a shortage. (iii) Requires **no change to accepted P1D-1 open code and no new column on `cash_sessions`** — the resolver simply reads `WHERE effective_from <= session.opened_at`. | The count itself happens at close; one could argue the "transaction" is the close. |
| **B. Version effective at CashSession CLOSE** | The variance and the tolerance test are both close-time computations. | **Opens a fraud vector the SRS's own FR-POS-095 rationale is written against:** a manager may insert a new version moments before the close is submitted, so the control threshold is chosen *after* the shortage is known. |
| **C. Snapshot captured at open (written onto `cash_sessions` at open)** | Same control property as A. | Strictly worse than A: requires **modifying the accepted P1D-1 open path** and adding columns to `cash_sessions`, for an outcome A already achieves, because backdating is structurally impossible. |
| **D. Another source-backed point** | **None found.** | — |

**The SRS does not decide between A, B and C.** FR-PLT-028 governs how a *closed* historical record is later re-read; it is silent on which instant an *in-flight* session takes its policy from.

### **CASHSESSION POLICY TIME: `NOT SOURCE-DECIDABLE` → USER RATIFICATION REQUIRED (R-3). P1G-1-BEHAVIOUR-CRITICAL, NOT migration-critical (A and B differ only in the resolver's `asOf` argument).** Recommendation: **A**, on two independent grounds (repository precedent under identical SRS wording; the only reading that closes the mid-drawer-widening vector).

---

## 6. SETTINGS HIERARCHY — FR-PLT-025 — §9

### 6.1 The exact hierarchy (not guessed — quoted)

SRS §6.4, verbatim, highest to lowest precedence:

```
Platform Default
  ↓ overridden by
Country Pack
  ↓ overridden by
Tenant Setting
  ↓ overridden by
Brand Setting
  ↓ overridden by
Branch Setting
  ↓ overridden by
Terminal Setting
```

*"A value set at a lower level overrides a higher level, unless the higher level marks it locked."*

**Repository entities backing each level:** Platform Default — **no entity exists** (nothing tenant-independent and configurable). Country Pack — `CountryPackRegistry` in-memory signed document, **no cash keys** (§0.3). Tenant — `identity.tenants`. Brand — `org.brands`. Branch — `org.branches`. Terminal — `identity.terminals`. So **four of six levels have a backing entity; two do not** (Platform Default has no home; Country Pack has no cash content).

### 6.2 Minimum resolution required, per setting

| | **Cash variance tolerance** | **Cash count mode** |
|---|---|---|
| Which levels *may* define it (per source) | **Not stated by any source.** FR-FIN-006 says only *"configurable"*. | **Branch — stated literally.** FR-POS-094: *"configurable per branch"*. |
| Which level P1G-1 **consumes** | **Branch.** It is resolved for a `CashSession`, which is bound to exactly one branch (`cash_sessions.branch_id`, composite-FK'd). | **Branch.** Same. |
| Fallback precedence implemented in this slice | **Branch only.** | **Branch, then the source-stated default `blind`.** |
| Is inheritance mandatory *for these settings*? | **NOT SOURCE-DECIDABLE.** FR-PLT-025 mandates a resolver for *settings*; no requirement says a cash tolerance must be definable above branch. | Same. |
| May an absent value fall through? | **Yes, to "unconfigured" → fail closed** (§2.1). | **Yes, to `blind`** — FR-POS-095 [M]. |
| Is branch override required? | Not required by source, but branch is the level consumed. | **YES, required literally by FR-POS-094.** |

### 6.3 Why branch-only is forward-compatible, and where the debt is

**Branch is the *lowest* level that exists for these settings** (Terminal is below it, but no source asks for a per-terminal tolerance or count mode, and a drawer is branch-scoped). Under FR-PLT-025's own semantics, a lower level **overrides** every higher one — so **a branch-level value is exactly what a complete six-level resolver would return whenever a branch value is set.** Adding Tenant/Brand rows later **cannot change any answer** where a branch row exists. The store is therefore *precedence-compatible* with the eventual resolver by construction, not by hope.

**The honest debt, stated plainly:** (i) FR-PLT-025's resolver across levels is **not implemented** (unchanged from HEAD — ADR 0008 D-11 deferred it); (ii) **FR-PLT-026 locks are not implemented** — see §7; (iii) when the platform resolver lands, `treasury.cash_close_policies` must be folded in as the branch-level source for its two keys, or migrated into it.

---

## 7. SETTINGS LOCKS — FR-PLT-026 — §10

| Question | Source answer | Classification |
|---|---|---|
| Which level may lock descendants? | *"markable as locked at **any** level"* | **SOURCE-DECIDED** |
| Does a lock prevent override only? | *"**preventing override at lower levels**"* — yes, that and only that is stated. | **SOURCE-DECIDED (mandatory semantic)** |
| Does it prevent editing the locked source value? | **Not stated.** | **NOT SOURCE-DECIDABLE** |
| Is lock inherited? | **Not stated** — "preventing override at lower levels" implies it binds *all* lower levels, but whether an intermediate level can re-lock or unlock is undefined. | **NOT SOURCE-DECIDABLE** |
| Is lock itself effective-dated? | **Not stated.** | **NOT SOURCE-DECIDABLE** |
| Must the locking level be nameable? | *"visibly indicated in the UI at lower levels **with the locking level named**"* — yes, the resolver must return it. | **SOURCE-DECIDED** |
| Relevance to FR-PLT-028 versioning | **Not stated.** | **NOT SOURCE-DECIDABLE** |

### 7.1 Decision: **no lock mechanism is built in this slice.**

**A lock has no meaning in a single-level store.** FR-PLT-026's entire mandatory semantic is *"preventing override at lower levels"*. With Branch as the only level that may hold a value, there is **no lower level to prevent an override at** and **no higher level from which to lock**. An `is_locked BOOLEAN` column here would be **decoration that could never be evaluated** — precisely what ADR 0008 D-12 refused for `is_active`, and precisely what the brief's §10 warns against (*"Do not invent a broad lock framework merely to unblock P1G-1"*).

**FR-PLT-026 therefore remains `NOT IMPLEMENTED`, unchanged from HEAD.** This is a truthful non-regression, not a claim of progress. It is recorded rather than papered over, and the three `NOT SOURCE-DECIDABLE` lock mechanics above are recorded so that the future settings slice must resolve them rather than inherit an invented answer.

---

## 8. STORAGE STRATEGY COMPARISON — §12

| Criterion | **S-1** existing JSONB | **S-2** generic versioned platform settings | **S-3** narrow Treasury financial-settings table | **S-4** minimal generic core + typed Treasury keys |
|---|---|---|---|---|
| Satisfies **FR-POS-094** "configurable per branch" | ❌ **No branch-level store exists at all** — only `tenants.settings` and `brands.default_settings` | ✅ | ✅ | ✅ |
| **FR-PLT-025** hierarchy | ❌ no resolver, no precedence | ⚠️ 3–4 of 6 levels at best (Platform Default has no tenant to anchor RLS; Country Pack has no cash content) → **still PARTIAL** | ❌ not implemented (branch is the winning level; §6.3) | ⚠️ same as S-2 → **still PARTIAL** |
| **FR-PLT-026** locks | ❌ | ⚠️ requires inventing 3 undecided mechanics (§7) | ❌ not implemented, and **meaningless at one level** | ⚠️ same invention as S-2 |
| **FR-PLT-028** version/effective | ❌ none | ✅ | ✅ | ✅ |
| **Type safety** | ❌ `unknown` JSON, no validation | ❌ opaque JSONB values; typing lives in per-key adapters | ✅ **typed columns; CHECK constraints; `BIGINT` money enforced by the DB** | ⚠️ typed only above the store |
| **Requires inventing setting-key literals** (§13) | n/a | ✅ **yes** — `cash.variance.tolerance` etc. must be minted | ✅ **yes** | ✅ **yes** |
| | | | ❌ **NO — typed columns need no key vocabulary at all** | |
| **RLS** | ❌ `tenants.settings` is a column on an already-RLS'd row (no independent policy); `org.settings` as approved **cannot be anchored** (ADR 0008 D-11) | ⚠️ polymorphic `scope_id` needs a `scope_type`-aware policy or three nullable FK columns | ✅ direct `tenant_id` + composite FK `(tenant_id, branch_id) → org.branches`, the exact `cash_movements` pattern | ⚠️ as S-2 |
| **Auditability** | ❌ no audit hook | ✅ | ✅ (`AUDIT_ENTITY` + new action) | ✅ |
| **Implementation scope before Tuesday** | trivial but non-compliant | ❌ **platform slice** — key registry, value grammar, validation ownership, lock mechanics, inspector, precedence tests | ✅ **one table, one enum, one resolver, one write route** | ⚠️ between the two, closer to S-2 |
| **Future drawer-limit reuse (FR-POS-092)** | ❌ | ✅ | ✅ **add one nullable `BIGINT` column to the same table; new version rows carry it** | ✅ |
| **Future settings reuse** | ❌ | ✅ | ⚠️ Treasury-local only | ✅ |
| **Migration complexity** | none | high | **low** | medium-high |
| **Risk of a second settings system** | n/a | low | ⚠️ **real, and recorded** (§6.3) | low |
| **Repository precedent** | — | none | ✅ **`BranchKdsConfig`** — narrow typed per-branch config in the consuming module's physical schema; its docblock states `org.settings` *"was considered and rejected"* | none |

### 8.1 SELECTED: **S-3 — a narrow, Treasury-owned, branch-scoped, effective-dated, immutable-versioned cash-close policy table.**

Four decisive reasons, in order of weight:

1. **S-2 and S-4 cost a platform slice and still yield FR-PLT-025 `PARTIAL`.** Neither can reach all six levels: **Platform Default has no tenant and therefore cannot live in a tenant-RLS'd table**, and **Country Pack carries no cash content** (§0.3). Paying the full generic price for a still-partial mandatory requirement, days before delivery, is the worst trade on the board.
2. **S-3 is the only option that invents no setting-key vocabulary.** §13 asks whether machine-readable keys are source-decided: **they are not** — the SRS names no settings key anywhere. S-2/S-4 *require* minting authoritative-looking literals (`cash.variance.tolerance`, `cash.count.mode`). **Typed columns need none.** This eliminates an entire class of invention the brief explicitly warns against.
3. **The repository's own ratified precedent is S-3-shaped.** `BranchKdsConfig` is exactly this: narrow, typed, per-branch, tenant-anchored, in the consuming module's physical schema, with `org.settings` *considered and rejected on the record*. And ADR 0008 D-11's binding instruction — *"must carry `tenant_id` and a `scope_type`-aware ownership check from the first migration"* — is satisfied trivially by a table whose only scope is `branch_id`, composite-FK'd to `org.branches(tenant_id, id)`.
4. **D-13 is RATIFIED and points here.** *"Option (b) — **domain-owned**; Governance stays generic"*, and *"no SRS requirement places thresholds in Governance"*. Cash is Treasury's domain; Treasury owns `CashSession`, `Drawer`, `CashMovement`.

**S-1 is rejected outright**: it has **no branch-level store**, so it cannot satisfy FR-POS-094 [M] at all — before any FR-PLT-028 consideration. Per the brief: *"Do not reuse an existing JSONB merely because it exists"* — and here it could not be reused even if one wanted to.

**What S-3 explicitly does not claim:** it does not implement FR-PLT-025 or FR-PLT-026, and this gate does not report them as improved.

---

## 9. OWNING MODULE, SCHEMA, AND THE READ CONTRACT — §16

| Question | Answer | Basis |
|---|---|---|
| Owning module | **Treasury** — logically **and** physically | **D-13 RATIFIED** (thresholds domain-owned); Treasury owns `CashSession`; ADR 0008 assigns no cash configuration to Organisation (unlike station config → D-06/D-07, which is why `BranchKdsConfig` is logically Organisation's) |
| Physical schema | `treasury` | Co-located with `cash_sessions` / `cash_movements`, the only consumers. §25.1's `org.settings` names a **generic** settings table, which is not what this is |
| Cross-module contract required? | **NO.** The consumer (`CashSessionsService`) and the store are both in Treasury. Publishing a `contract/` for an intra-module read would be ceremony. | SRS §5.4 — `contract/` is for *other* modules |
| Does Treasury query another module's table? | **No.** Its only cross-module edge is the composite FK `(tenant_id, branch_id) → org.branches(tenant_id, id)` — a schema-level constraint, identical to `cash_movements`' existing FK. `module-boundaries.spec.ts` is unaffected: **no new import edge, no new `KNOWN_DEVIATIONS` entry.** | Verified against the allow-list |

### 9.1 The internal resolution contract (implementation-ready)

`src/modules/treasury/cash-close-policy/cash-close-policy.resolver.ts` (PRIVATE to Treasury), `tx`-first per the repository's universal convention:

```ts
export interface ResolvedCashClosePolicy {
  readonly policyVersionId: string;      // §17 provenance / audit anchor
  readonly effectiveFrom: Date;
  readonly countMode: 'blind' | 'open';  // FR-POS-094
  readonly varianceToleranceMinorUnits: bigint;   // R-1 option (a)
  readonly currency: string;             // CHAR(3), must equal session currency
  readonly varianceApprovalExpirySeconds: number; // R-4 option (a)
}

export interface CashClosePolicyResolver {
  /**
   * Resolves the version in force at `asOf` for `branchId`.
   * `asOf` = cashSession.openedAt under R-3 option A; close instant under B.
   * Returns null when the branch has NO version effective at `asOf`.
   */
  resolve(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; branchId: string; asOf: Date },
  ): Promise<ResolvedCashClosePolicy | null>;

  /**
   * FR-POS-094/095 only. Returns 'blind' when no version resolves — the
   * SOURCE-STATED default, so a count-mode read never fails closed.
   */
  resolveCountMode(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; branchId: string; asOf: Date },
  ): Promise<'blind' | 'open'>;
}
```

Resolution SQL shape: `SELECT … WHERE tenant_id = $t AND branch_id = $b AND effective_from <= $asOf ORDER BY effective_from DESC LIMIT 1`. Deterministic: `UNIQUE (tenant_id, branch_id, effective_from)` makes ties impossible.

**Close-path behaviour:** `resolve()` returning `null` ⇒ the close command fails closed with a distinct, non-generic error (`CASH_CLOSE_POLICY_NOT_CONFIGURED`) and **no session state changes**. `policy.currency !== session.currency` ⇒ fails closed with `CASH_CLOSE_POLICY_CURRENCY_MISMATCH` (§4).

---

## 10. SETTING KEYS / VOCABULARY — §13

* **Are machine-readable setting keys source-decided? — NO.** The SRS names **no settings key anywhere**. Searched §6.4, §25.1, §15.2, the approved SQL (`org.settings.key VARCHAR(120)` — a column, never a value), the register and every ADR.
* **Consequence under S-3: the question dissolves.** A typed table has **columns**, not keys. `variance_tolerance_minor_units` and `count_mode` are **column names** — ordinary implementation identifiers of the same kind as `recall_window_seconds`, not governance vocabulary.
* **Literals such as `cash.variance.tolerance` / `cash.count.mode` are NOT minted by this gate**, exactly as the brief instructs.
* **If the user later selects S-2/S-4**, key literals become **governance vocabulary requiring ratification**, because they would be a durable public naming surface shared across modules and exposed by the FR-PLT-027 inspector. **Recorded as a consequence of that choice, not as a live ratification item.**

---

## 11. CASH COUNT MODE — §14

| Aspect | Decision | Classification |
|---|---|---|
| Values | `blind` \| `open` — the two the SRS names and no others | **SOURCE-DECIDED** |
| Storage | PostgreSQL enum `treasury."CashCountMode"`, column `count_mode` | **REPOSITORY-DECIDED** — ADR 0008 D-17 precedent: enums where the approved SQL used `VARCHAR`, constraining an open type |
| Default | **`blind`**, as a genuine DB `DEFAULT 'blind'` | **SOURCE-DECIDED** — FR-POS-095 [M] states it. Exact precedent: `recall_window_seconds Int @default(1800)` for FR-KDS-025, which states its default; contrast `cancelled_line_visibility_seconds Int?` for FR-KDS-029, which does not |
| Branch override | **Required and satisfied** — a branch policy version sets it | **SOURCE-DECIDED** (FR-POS-094 *"configurable per branch"*) |
| Hierarchy fallback | Branch → source-stated `blind`. No tenant/brand level in this slice | **DESIGN-DECIDABLE** (§6.3) |
| Lock behaviour | None — see §7 | **NOT IMPLEMENTED**, recorded |
| Effective-date requirement | **Not independently required.** Inherits versioning by living on the policy row (§5.2) | **DESIGN-DECIDABLE** |
| Is it a financial setting under FR-PLT-028? | **Not asserted.** It is behavioural, not amount-affecting. Recorded explicitly so no future reader infers otherwise | **NOT SOURCE-DECIDABLE; no claim made** |
| Server enforcement | The mode is resolved **server-side** and **never accepted from the client** — the prior gate's §5 blind protocol (expected cash disclosed only in the close *response*, after the declaration is durably accepted) is unchanged and remains the FR-POS-095 control | **REPOSITORY-DECIDED** (prior gate, retained) |

---

## 12. DRAWER LIMIT — FUTURE COMPATIBILITY ONLY — §15

**Not designed and not implemented here.** Compatibility assessment only, as instructed.

FR-POS-092 [M] needs *"a configurable drawer limit"* — a per-branch money amount, the same shape as the variance tolerance. Under **S-3** it is added as **one nullable `BIGINT` column** (`drawer_limit_minor_units`) on `treasury.cash_close_policies`; new version rows carry a value, historical rows keep `NULL` = not configured, and the existing resolver returns it with no structural change. **No second settings system is required for it.**

**It is NOT added to migration 33.** FR-POS-092's own undecided parameters (prompt vs block; whether the limit is evaluated per-movement or on drawer balance; its authorization) are untouched by this gate, and the brief forbids adding the column absent an independent requirement.

---

## 13. HISTORICAL PROOF / SNAPSHOT — §17

**Selected: C — BOTH the value snapshot AND the setting-version id**, written onto the CashSession close record by the future P1G-1 slice.

| Stored at close | Why |
|---|---|
| `variance_tolerance_minor_units` (**value snapshot**) | The record explains itself with **no join and no resolver**. FR-FIN-007 [M] makes a closed session immutable; a value that must be re-derived is not immutable. Same reasoning this repository already ratified for `unit_cost_snapshot` (BR-POS-004) and `posted_cogs_total`. |
| `tolerance_currency` | BR-CORE-001 — an amount without its currency is not money. |
| `cash_close_policy_version_id` (**version reference**) | Provenance: *which configuration act* produced that threshold, hence who configured it and when (via the audit entry keyed on that id). Value alone cannot answer that. |
| `count_mode` used | FR-POS-094 — proves which control environment the count occurred under. |
| `expected_cash`, `counted_cash`, `variance` | FR-FIN-005 [M] *"SHALL be recorded on the session"*. |
| `variance_reason` | FR-FIN-006 [M] (§14). |
| `approval_required` (boolean) | Records the **decision**, not merely its inputs, so reconstruction never depends on re-running a comparison whose operator may later be corrected. |
| `approval_request_id` | Present iff approval was required (§15). |

**Neither (D) alone is sufficient**: the policy table is immutable, so the version id *would* be a stable reference — but a snapshot additionally survives a future migration of the settings substrate into the platform resolver (§6.3), which is a foreseeable event. Storing both costs one `BIGINT`, one `CHAR(3)` and one `UUID`.

**Explicitly prohibited:** resolving today's policy to explain yesterday's close. The resolver is called **once**, inside the close transaction, and its output is persisted.

---

## 14. THE P1G-1 APPROVAL DECISION POINT — §18, §19, §20

### 14.1 The comparison — §18/§19

Variance is **signed**: `variance = counted − expected` (FR-FIN-005 [M]).

**Strictness (`>` vs `>=`):** FR-FIN-006 says *"beyond"*; FR-POS-096 says *"exceeds"*. Two independent mandatory statements, both meaning **strictly greater**. A value exactly equal to the tolerance is **within** tolerance. **This is a plain reading of the source, not an inference** — classified **SOURCE-DECIDED**.

**Absolute vs signed — this is where the honesty matters.** The source says only *"a configurable tolerance"* (singular, one scalar). Three candidate readings:

| Reading | Consequence |
|---|---|
| `variance > tolerance` (signed) | **Every shortage (negative variance) passes unapproved.** This nullifies FR-FIN-006 for the exact case the control exists for — SoD pair §15.4 names *"**Self-approved shortage**"*, and FR-POS-095's rationale is entirely about **concealing a shortage**. A reading that makes a `[M]` requirement inoperative in its own motivating case cannot be the intended one. |
| `abs(variance) > tolerance` | One scalar, symmetric, both directions controlled. Consistent with a **singular** "a configurable tolerance". |
| Separate positive/negative tolerances | Requires **two** configured values; the SRS says "a tolerance" (singular) and, unlike FR-INV-046/FR-POS-047, never enumerates two. |

**Engineering interpretation (labelled as such, not source):** `abs(variance) > tolerance` is the only reading that is both operative and expressible as a single configured scalar. It is **not baked in silently** — it is surfaced as **R-2** because the brief correctly calls the comparison implementation-critical, and because a reader could defensibly prefer asymmetric tolerances.

### **THRESHOLD OPERATOR: strictness `SOURCE-DECIDED`; absolute-value framing `ENGINEERING INTERPRETATION` → USER RATIFICATION REQUIRED (R-2). P1G-1-CRITICAL, not migration-critical.**

### 14.2 The reason — §20

| Question | Answer | Basis |
|---|---|---|
| Free text or reason code? | **Free text, mandatory, non-blank.** | **REPOSITORY-DECIDED** — the P1G-0 precedent is exact: `cash_movements.reason TEXT NOT NULL` + `CHECK (length(btrim("reason")) > 0)`, for FR-POS-091's *"each with reason and amount"*. FR-FIN-006's *"require a reason"* is the same grammatical form. |
| Does a reason catalogue exist? | **Yes, but it does not apply.** `inventory.reason_codes` exists with `category VARCHAR(16)` documented by the approved SQL as *"waste \| adjustment"* — **no cash category**, and it is an Inventory-schema table. Reusing it would be a cross-module reach into a private table for a catalogue whose cash values no source defines. **A cash reason catalogue is `NOT SOURCE-DECIDABLE` and is not invented.** | Repository + approved SQL |
| Immutable? | **Yes** — written once with the close facts, on an append-only/no-UPDATE close record. | FR-FIN-007 [M] |
| Where does it live? | **Treasury's close record is the single system of record.** | See below |
| Does it also go into the approval `value`? | **A copy MAY be carried** in the Governance `value` document **for the approver's context only**. Governance **never parses it** — `value` is a ratified **opaque carrier** (SB-2, item 7). The Treasury column is authoritative; the `value` copy is presentational. **These two roles are stated here precisely so the duplication is not an undefined dual source of truth.** | Register item 7 + `approval.contract.ts` docblock |

---

## 15. APPROVAL REQUEST FIELDS FOR P1G-1 — §21, §22

The runtime is FINAL ACCEPTED; this gate only fixes the consumer's arguments to `ApprovalCommands.createRequest(tx, tenantId, requestedByUserId, command)`.

| Field | Value | Classification |
|---|---|---|
| `requestType` | **`'cash.variance'`** | **DESIGN-DECIDABLE NOW — implementation-owned vocabulary.** D-16's *enumeration* is OPEN and the register's ratification says *"No closed enum to be invented"*; `approval.contract.ts` states the literals are *"opaque strings **the consuming domain supplies**"*; the column is `VARCHAR(32)` **with no CHECK** by ratified item 1. The consuming domain is Treasury, so Treasury names it. The form mirrors the source-named permission `cash.variance.approve` minus the verb. **This does not close D-16 and creates no governance vocabulary.** |
| `entityType` | **`'cash_session'`** | **REPOSITORY-DECIDED — the literal already exists**: `AUDIT_ENTITY.CASH_SESSION = 'cash_session'` (`audit.constants.ts:145`), already used by `cash-sessions.service.ts:255`. Nothing is minted. |
| `entityId` | the `CashSession.id` | REPOSITORY-DECIDED |
| `requiredPermission` | **`'cash.variance.approve'`** | **SOURCE-DECIDED** — FR-FIN-006 names it verbatim; §15.2 lists it. Not yet seeded (`treasury.permissions.ts` documents the deliberate omission); **P1G-1 seeds it**, since P1G-1 is the slice that gives it an executable consumer. |
| `value` | Opaque JSONB. Money as **base-10 integer strings of minor units** (binding Clarification A). Suggested contents: `{ expectedCash, countedCash, variance, tolerance, currency, countMode, reason }`. | RATIFIED constraint; contents design-decidable |
| `expiresAt` | See §15.1 — **R-4** | **NOT SOURCE-DECIDABLE** |
| `excludedApproverUserId` | **The `identity.users` id of the CashSession owner.** | **RATIFIED** (item 8 + binding Clarification B: *"an Identity USER ID… NOT an Employee ID"*). **Carried gap, and it is live for P1G-1:** `identity.employees.user_id` is **nullable** (`schema.prisma`: `userId String? @unique`; SRS §7.3 #25 *"May link to at most one User"*). If the session owner has no linked User the conjunct goes inert. **P1G-1 must fail closed** — refuse to create a variance approval request when `session.employee.userId IS NULL` — rather than submit `NULL` and silently disable the FR-SEC-016 [M] block. A PIN-opened session's owner necessarily has a linked User, so this is a guard, not a common path. |
| `requestedBy` | positional `requestedByUserId` = the acting cashier's `identity.users` id, from `TenantContext` — never from the payload | REPOSITORY-DECIDED (contract signature) |
| Persist `approval_request_id` in Treasury? | **YES** — on the close record (§13). D-17's strict-boundary ratification concerns *Inventory*; storing a UUID reference is not a cross-module import and Treasury needs it for FR-AUD-002's `approval_id` field. | DESIGN-DECIDABLE |

### 15.1 Approval expiry — §22

**Facts.** `expires_at` is `NOT NULL` and immutable (D-1, D-6, D-10 E2). **No default duration exists anywhere** — D-10: *"The SRS defines nothing about: detection, **default duration**, status effect…"*; the accepted design made `expiresAt` mandatory in the create command precisely so *"the consuming domain must state it"*. The decisions INSERT policy rejects a decision when `r.expires_at < statement_timestamp()`.

**Does synchronous approval dissolve the problem? — No, but it shrinks it.** Under FR-SEC-032's synchronous manager-PIN path the request is created and decided in the **same transaction**, microseconds apart. But `expires_at` is `NOT NULL`, and it must be strictly in the future at the decision statement's `statement_timestamp()`. A concrete future timestamp is therefore **unavoidable**, and **no source supplies a duration**. Setting it to `transaction_timestamp()` fails (the later statement's clock has advanced); any positive interval is a chosen number.

**Options, narrowest first — R-4:**

| Option | Description | Assessment |
|---|---|---|
| **(a) Configured, not invented** — **RECOMMENDED** | `variance_approval_expiry_seconds INTEGER NOT NULL` (**no DB default**, `CHECK > 0`) on the cash-close policy version. The tenant configures it in the same administrative act that configures the tolerance; the unconfigured state is already fail-closed (§2.1), so no number is invented **anywhere in the codebase**. | Source-consistent: FR-SEC-031 requires *"an expiry"*, and FR-SEC-034 [S] speaks of a *"**configured** period"* — the SRS treats approval timing as configuration, not as a constant. **Migration-relevant** (one column on the same table). |
| (b) Constant in Treasury code | `transaction_timestamp() + INTERVAL 'N'` with `N` chosen by the implementer. | **Invents a duration** — the brief explicitly forbids `5m / 15m / 30m`. Rejected. |
| (c) Caller-supplied absolute `expiresAt` on the close request | The terminal states it. | Relocates the invention to the client and makes a **security-relevant validity window client-controlled**. Rejected. |
| (d) Reuse FR-SEC-026's stated *"default 15 minutes on POS"* | Source-stated number, right context. | **The number is source-stated; the *linkage* is not.** FR-SEC-026 governs *authentication session idle timeout*, not approval validity. Offered only as a ratifiable value **if** the user prefers a constant. |

### **APPROVAL EXPIRY: `NOT SOURCE-DECIDABLE` → USER RATIFICATION REQUIRED (R-4). MIGRATION-CRITICAL under the recommended option (a).**

---

## 16. OFFLINE / POS TERMINAL IMPLICATIONS — §23

**Nothing offline is implemented, designed, or claimed here.**

| Question | Finding |
|---|---|
| Does §21.3's local data model list settings? | **It lists "Tax configuration and country pack — Down — On change, version-pinned"** and menu/prices/recipes/employees/customers/loyalty/stock. **Cash-close policy is not listed.** The table is illustrative, not closed, so its silence is neither authorisation nor prohibition. |
| Is offline availability required for **P1G-1 as scoped**? | **No.** The accepted close design is **server-executed**: the count declaration is submitted, expected cash is computed server-side inside the transaction, and disclosure happens in the response (prior gate §5). Policy resolution happens on the server, where the table is. |
| Is it MVP-relevant? | **Yes — deferred but MVP-relevant.** FR-OFF-003 [M] requires 72 hours isolated without degradation of **sales capture**; it does not name shift close. But a terminal that cannot close a drawer offline is a real operational gap, and FR-POS-094's blind/open mode must be known *locally* to render the count screen correctly. |
| If it is later synced, what is needed? | The **effective policy version for the branch**, version-pinned exactly as the country pack is (FR-OFF-011 delta-by-version, FR-LOC-024 ship-ahead-and-activate-by-date). Under **R-3 option A** the pinned version is fixed at session open, which is the offline-friendly choice: the terminal caches one row and needs no server round trip at close. |
| Already provided by another payload? | **No.** The country pack carries no cash block (§0.3), so there is no existing configuration payload to piggyback on. |

**No FR-OFF requirement is claimed complete, partial, or advanced by this gate.**

---

## 17. SECURITY / TENANCY / RLS — §24

Per FR-PLT-003/010/011/012/013/014 and ADR 0003, matching `treasury.cash_movements` (migration 31) exactly.

* **`tenant_id UUID NOT NULL`** — a real column on the table, not inherited through a join (ADR 0008 D-11's binding instruction).
* **Branch structural FK:** `FOREIGN KEY (tenant_id, branch_id) REFERENCES org.branches(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE` — the D-09 composite tenant-safe FK. A cross-tenant `branch_id` is a **foreign-key violation**, not a missed service check.
* **`created_by`:** `FOREIGN KEY (created_by) REFERENCES identity.users(id) ON DELETE RESTRICT` — untenanted, mirroring `cash_movements.performed_by` and `stock_movements.performed_by`.
* **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** — both, always.
* **Fail-closed predicate:** `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. With no tenant GUC set the predicate is `NULL` ⇒ no row matches ⇒ **fail closed** (FR-PLT-012).
* **Policies:** `SELECT` and `INSERT` only. **No UPDATE policy. No DELETE policy.**
* **Grants:** `GRANT SELECT ON … TO ros_app;` plus a **column-level** `GRANT INSERT ("id","tenant_id","branch_id","effective_from","count_mode","variance_tolerance_minor_units","currency","variance_approval_expiry_seconds","created_by")` that **deliberately omits `created_at`**, so `ros_app` cannot forge the creation instant and the anti-backdating CHECK cannot be defeated. Then `REVOKE UPDATE, DELETE, TRUNCATE … FROM ros_app;`. This is the exact, empirically-verified `governance.approval_decisions` pattern from migration 32.
* **Append-only** — versions are facts, never edited (§5.3).
* **No `BYPASSRLS`** anywhere; no superuser path in application code.
* **Cross-tenant CI tests** — §19 items 1, 2, 17.

---

## 18. WRITE AUTHORIZATION AND HTTP SURFACE — §25, §26

### 18.1 Write authorization — **SOURCE-DECIDED**

**`settings.branch.manage`** — SRS §15.2, Governance & Platform group, described verbatim as **"Branch configuration"**. Already seeded at HEAD (`ORGANISATION_PERMISSIONS.BRANCH_MANAGE`, ADR 0008 D-01). A per-branch cash-close policy is branch configuration on the catalogue's own wording.

**Nothing is invented.** `settings.manage`, `cash.settings.manage`, `finance.settings.update` are **not** created — the brief's prohibition is honoured and, as §0.3 records, was never actually needed.

**Boundary note (load-bearing).** The literal must be declared **locally in `treasury.permissions.ts`** as a plain string constant. Importing `ORGANISATION_PERMISSIONS` would be a **new `treasury->organisation` private-path import** and `module-boundaries.spec.ts` fails any new inner path. **No duplicate `PermissionDef` is added** — Organisation already seeds the code, and the permission table is keyed by `code`; a second def would be a redundant upsert, not a second permission.

**Not in scope:** `settings.tenant.manage` (no tenant-level rows exist in this design), and FR-SEC-024's MFA mandate for tenant-settings roles (unchanged, unimplemented, unclaimed).

### 18.2 HTTP write surface — needed, and permitted

| Option | Assessment |
|---|---|
| **(A) Seed/provision administratively, no API** | Technically sufficient for a **demo** tenant (`src/scripts/seed-dev-data.ts` exists and is additive-only). **Not sufficient for MVP correctness**: without a write path, no real tenant can ever configure a tolerance, so **every branch's first cash close is permanently blocked** by the fail-closed rule. |
| **(B) Reuse an existing settings API** | **None exists.** Only brand create/update accepts an opaque `defaultSettings` blob with no schema, no validation and no resolver (§0.2). Routing a financial control through it would be worse than S-1. |
| **(C) New minimal endpoint** — **RECOMMENDED** | `POST /v1/branches/{branchId}/cash-close-policy` on the **Treasury** controller, guarded by `settings.branch.manage`, `Idempotency-Key` required per FR-API-020 [M], creating **one new immutable version**. No PATCH, no DELETE — there is no UPDATE/DELETE grant to back them. |

**The two readiness axes the brief asks to separate:**
* **Runtime storage + read readiness:** ready to build once R-1/R-3/R-4 are ratified.
* **Administrative write readiness:** **also** ready — its permission is source-named and already seeded. Unlike the Approval slice (D-14 A-1 forbade a Governance HTTP surface), **nothing prohibits a Treasury settings route**, and Treasury already owns HTTP routes.

**Audit (FR-AUD-006 [M], *"configuration changes"*):** the write emits an audit entry — proposed action `CASH_CLOSE_POLICY_VERSION_CREATED`, `entityType` a new `AUDIT_ENTITY.CASH_CLOSE_POLICY = 'cash_close_policy'`, `after` = the new version. Repository-owned vocabulary in an existing constants file; no governance vocabulary.

---

## 19. MIGRATION PLAN — §28 (PLANNED ONLY — NOT CREATED)

**Next migration number: 33.** Verified: 32 migration directories at HEAD, newest `20260829010000_governance_approval_runtime`. **Owning module: Treasury.** **Migration 34 is not planned** — the P1G-1 close schema (counted cash, denominations, variance facts, the `cash_sessions` UPDATE grant it will require) belongs to the P1G-1 slice itself and is out of this gate's fence.

**Contingent on R-1 = (a) and R-4 = (a).** If R-1 = (b) or (c), the money column is replaced by a percentage column (`NUMERIC`, never float money) or by both plus a ratified combination rule, and `currency` may become inapplicable under (b) — **materially different schema, which is exactly why R-1 is migration-critical and why no migration is written now.**

```
-- treasury."CashCountMode"
CREATE TYPE treasury."CashCountMode" AS ENUM ('blind', 'open');

CREATE TABLE treasury.cash_close_policies (
  id                                UUID        NOT NULL,   -- client/server ULID-as-UUID (FR-OFF-015)
  tenant_id                         UUID        NOT NULL,
  branch_id                         UUID        NOT NULL,
  effective_from                    TIMESTAMPTZ(6) NOT NULL,
  count_mode         treasury."CashCountMode"   NOT NULL DEFAULT 'blind',  -- FR-POS-095 [M] states it
  variance_tolerance_minor_units    BIGINT      NOT NULL,   -- NO DEFAULT: FR-FIN-006 states none
  currency                          CHAR(3)     NOT NULL,   -- BR-CORE-001
  variance_approval_expiry_seconds  INTEGER     NOT NULL,   -- NO DEFAULT (R-4 option a)
  created_by                        UUID        NOT NULL,
  created_at                        TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

  CONSTRAINT cash_close_policies_pkey PRIMARY KEY (id),
  CONSTRAINT ck_ccp_tolerance_non_negative CHECK (variance_tolerance_minor_units >= 0),
  CONSTRAINT ck_ccp_expiry_positive        CHECK (variance_approval_expiry_seconds > 0),
  CONSTRAINT ck_ccp_currency_iso           CHECK (currency ~ '^[A-Z]{3}$'),
  -- Anti-backdating (§5.3). created_at is NOT in the column-level INSERT grant,
  -- so ros_app cannot supply it and cannot defeat this check.
  CONSTRAINT ck_ccp_no_backdating          CHECK (effective_from >= created_at)
);

CREATE UNIQUE INDEX cash_close_policies_tenant_id_id_key
  ON treasury.cash_close_policies (tenant_id, id);
-- Makes resolution deterministic: no two versions can share an instant for a branch.
CREATE UNIQUE INDEX uq_ccp_branch_effective_from
  ON treasury.cash_close_policies (tenant_id, branch_id, effective_from);
-- The resolver's only access path.
CREATE INDEX cash_close_policies_resolve_idx
  ON treasury.cash_close_policies (tenant_id, branch_id, effective_from DESC);

ALTER TABLE treasury.cash_close_policies
  ADD CONSTRAINT cash_close_policies_tenant_id_branch_id_fkey
  FOREIGN KEY (tenant_id, branch_id)
  REFERENCES org.branches (tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE treasury.cash_close_policies
  ADD CONSTRAINT cash_close_policies_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES identity.users (id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- GRANTS
GRANT SELECT ON treasury.cash_close_policies TO ros_app;
GRANT INSERT ("id","tenant_id","branch_id","effective_from","count_mode",
              "variance_tolerance_minor_units","currency",
              "variance_approval_expiry_seconds","created_by")
  ON treasury.cash_close_policies TO ros_app;      -- created_at deliberately omitted
REVOKE UPDATE, DELETE, TRUNCATE ON treasury.cash_close_policies FROM ros_app;

-- RLS
ALTER TABLE treasury.cash_close_policies ENABLE  ROW LEVEL SECURITY;
ALTER TABLE treasury.cash_close_policies FORCE   ROW LEVEL SECURITY;
CREATE POLICY cash_close_policies_select ON treasury.cash_close_policies FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_close_policies_insert ON treasury.cash_close_policies FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy. No DELETE policy. Versions are immutable facts.
```

**Not in migration 33:** no `drawer_limit_minor_units` (§12); no `is_locked` (§7); no tenant/brand scope columns (§6.3); no touch of `cash_sessions`, `cash_movements`, `org.*`, `governance.*`.

---

## 20. TEST MATRIX — §29 (real Postgres, deterministic clocks, no sleeps)

Effective-date tests use **explicit `effective_from` values supplied by the test** and DB-side `statement_timestamp()` for `created_at`; ordering is asserted by value comparison, never by wall-clock waiting.

| # | Test | Expected |
|---|---|---|
| 1 | Tenant isolation — tenant B `SELECT`s tenant A's policy | 0 rows |
| 2 | Missing tenant GUC — `SELECT`/`INSERT` with `app.tenant_id` unset/empty | 0 rows / insert rejected (**fail closed**, FR-PLT-012) |
| 3 | Hierarchy resolution — branch has one version effective before `asOf` | that version resolves |
| 4 | Branch override — two branches, different tolerances, same tenant | each resolves its own; no leakage |
| 5 | Inherited setting — **N/A in this slice**, asserted as a documented gap: a branch with no version resolves `null` (tolerance) and `'blind'` (count mode). **Recorded as FR-PLT-025 not implemented, not as a pass** |
| 6 | Locked parent prevents forbidden override — **N/A**, asserted as a documented gap (§7). **No test may claim FR-PLT-026 coverage** |
| 7 | Effective version before activation — version with `effective_from` in the future | does **not** resolve for an earlier `asOf` |
| 8 | Effective version after activation — same version, `asOf` after `effective_from` | resolves |
| 9 | **Historical stability** — resolve at `T0`; insert a new version effective `T1 > T0`; resolve again at `T0` | **identical result** (FR-PLT-028) |
| 10 | Blind default when no branch version exists | `resolveCountMode()` → `'blind'` (FR-POS-095) |
| 11 | Open mode when explicitly configured | `'open'` |
| 12 | **Boundary** — `abs(variance) == tolerance` | **within** tolerance, no approval required (§14.1, under R-2) |
| 13 | Inside tolerance — `abs(variance) < tolerance` | no approval required |
| 14 | Above, positive side — `variance = +(tolerance+1)` | approval required |
| 15 | Below, negative side — `variance = −(tolerance+1)` | **approval required** — the test that fails under a signed comparison, and the reason R-2 exists |
| 16 | Currency mismatch — policy `EGP`, session `USD` | close fails closed; **no session state change** (§4) |
| 17 | Cross-tenant reference blocked — insert a policy whose `branch_id` belongs to another tenant | **FK violation** (D-09 composite FK), not a service-layer error |
| 18 | Forbidden historical mutation — `UPDATE` / `DELETE` a version as `ros_app` | `permission denied` at the **database**, verified against real Postgres (the migration-32 method) |
| 18b | Forged `created_at` — `INSERT` explicitly supplying `created_at` as `ros_app` | `permission denied` (column-level grant), so anti-backdating cannot be defeated |
| 18c | Backdating — `INSERT` with `effective_from < now()` | `ck_ccp_no_backdating` violation |
| 19 | Concurrent version creation at the same instant for one branch | second writer fails on `uq_ccp_branch_effective_from` — deterministic under any interleaving, no advisory lock |
| 20 | Deterministic policy snapshot — resolve twice in one transaction with identical inputs | byte-identical `ResolvedCashClosePolicy`, same `policyVersionId` |
| 21 | Write authorization — `POST` without `settings.branch.manage` | 403; **with** it, 201 and exactly one audit entry (FR-AUD-006) |
| 22 | Idempotent write — same `Idempotency-Key` replayed | identical stored response; **exactly one** version row (FR-API-020) |

---

## 21. P1G-1 READINESS OUTPUT — §30

| Item | What P1G-1 can rely on | Blocks? |
|---|---|---|
| Tolerance representation | **Unresolved — R-1.** Recommended: `BIGINT` minor units + `CHAR(3)` currency | **P1G-1 IMPLEMENTATION** *and* migration |
| Tolerance value source | `treasury.cash_close_policies`, branch-scoped, effective-dated, immutable | — |
| Default / no-default | **No default.** Unconfigured ⇒ close fails closed (derived, §2.1) | — (acknowledgement R-5) |
| Threshold operator | Strict `>` **SOURCE-DECIDED**; absolute-value framing **R-2** | **P1G-1 IMPLEMENTATION** (not migration) |
| Count mode | `treasury."CashCountMode"` = `blind` \| `open`, per branch | — |
| Blind default | **SOURCE-DECIDED**, DB `DEFAULT 'blind'` + resolver fallback | — |
| Settings hierarchy | **Branch level only.** FR-PLT-025 not implemented; forward-compatible (§6.3) | only FUTURE FULL-SRS COMPLETION |
| Locks | **Not implemented**; meaningless at one level (§7) | only FUTURE FULL-SRS COMPLETION |
| Version / effective semantics | Immutable append-only versions; `effective_from`; backdating structurally impossible | — |
| Policy resolution contract | `CashClosePolicyResolver` (Treasury-private, `tx`-first, §9.1) | — |
| Historical snapshot | Value **+** version id **+** currency **+** count mode **+** `approval_required`, on the close record (§13) | — |
| Settings write authorization | **`settings.branch.manage` — SOURCE-DECIDED, already seeded** | — |
| Approval `request_type` | **`'cash.variance'`** — implementation-owned, design-decidable | — |
| Approval `entity_type` | **`'cash_session'`** — already exists in `AUDIT_ENTITY` | — |
| Approval expiry | **Unresolved — R-4.** Recommended: configured per policy version | **P1G-1 IMPLEMENTATION** *and* migration (under option a) |
| CashSession policy time | **Unresolved — R-3.** Recommended: effective at **open**, resolved at close | **P1G-1 IMPLEMENTATION** (not migration) |
| Excluded approver | Session owner's **User** id; **fail closed when `employee.userId IS NULL`** (§15) | — |
| Currency | `CashSession.currency` already exists; mismatch ⇒ fail closed | — |
| Offline | Not required for P1G-1; deferred, MVP-relevant (§16) | only FUTURE FULL-SRS COMPLETION |

---

## 22. MVP / TUESDAY SCOPE — §27

The deadline authorises **narrowness**, never an invented default, never a missing DB enforcement, never a false requirement claim.

**MUST HAVE FOR P1G-1** — migration 33 (table, enum, CHECKs, composite FK, column-level grants, ENABLE+FORCE RLS, SELECT/INSERT policies); `CashClosePolicyResolver`; the fail-closed close-path behaviour; tests 1–4, 7–20.

**MUST NOT DEFER FOR MVP CORRECTNESS** — the `POST` write route + `settings.branch.manage` guard + `Idempotency-Key` + audit entry (§18.2: without it every branch's first close is permanently blocked); DB-level immutability (grants/REVOKE, not an application rule); the anti-backdating CHECK (it is what makes R-3 option A tamper-proof); tests 21–22.

**CAN DEFER AFTER P1G-1** — a read/inspector endpoint (FR-PLT-027 is `[S]`); tenant/brand levels; locks; the FR-POS-092 drawer-limit column; offline sync of the policy; migrating into the eventual platform resolver.

**Sequence that makes P1G-1 executable soonest:** ratify R-1…R-4 → build migration 33 + resolver + write route (one slice, small) → P1G-1 close consumes the resolver and the already-accepted Approval Runtime.

---

## 23. REQUIREMENT CLASSIFICATION — §31

**Honest prediction after the settings substrate is built, and separately after P1G-1 lands.**

| Requirement | At HEAD `1f9ea1f` | After settings substrate | After P1G-1 |
|---|---|---|---|
| **FR-PLT-025** [M] hierarchy | NOT IMPLEMENTED | **NOT IMPLEMENTED** (branch-only store is not a resolver; unchanged) | NOT IMPLEMENTED |
| **FR-PLT-026** [M] locks | NOT IMPLEMENTED | **NOT IMPLEMENTED** (§7) | NOT IMPLEMENTED |
| **FR-PLT-028** [M] financial version/effective | NOT IMPLEMENTED | **PARTIAL** — implemented for the cash-close settings; **not** for the three the SRS names (tax class, rounding policy, service charge) | PARTIAL |
| **FR-POS-094** [M] blind/open per branch | NOT IMPLEMENTED | **PARTIAL** — the "configurable per branch" half is met; *"Shift close SHALL require a physical cash count"* is not | **COMPLETE** |
| **FR-POS-095** [M] blind default | NOT IMPLEMENTED | **PARTIAL** — the default is expressible and enforced by the resolver, but no close consumes it | **COMPLETE** |
| **FR-FIN-006** [M] variance tolerance + approval | NOT IMPLEMENTED | **DESIGNED ONLY** — tolerance configurable and the approval runtime exists, but **no close exists**, so the requirement is not exercised | **COMPLETE**, contingent on R-1 + R-2 |
| **FR-POS-092** [M] drawer limit | NOT IMPLEMENTED | **NOT IMPLEMENTED** (compatible substrate only, §12) | NOT IMPLEMENTED |

**FR-FIN-006 is explicitly NOT claimed complete before P1G-1 exists**, as the brief requires. Related, for accuracy: **FR-POS-096** [M] becomes COMPLETE with P1G-1 (FR-FIN-006's stricter approval satisfies its "manager acknowledgement"); **FR-FIN-007** [M] remains **PARTIAL** (immutability met, adjusting entries unmet — prior gate §9, unchanged).

---

## 24. IMPLEMENTATION READINESS — §32

### 24.1 The four ratification items — narrowest possible form

> **R-1 — Tolerance representation.** MIGRATION-CRITICAL · P1G-1-CRITICAL.
> **(a) Absolute money amount in minor units, in the branch's base currency (RECOMMENDED)** — exact under §7.2, no rounding rule needed, no degenerate case.
> (b) Percentage of expected cash — requires ratifying a rounding mode **and** a zero/negative-expected fallback.
> (c) Both — additionally requires ratifying whether "beyond tolerance" means beyond **both** or **either**.

> **R-2 — Comparison semantics.** P1G-1-CRITICAL (not migration-critical).
> **(a) `abs(variance) > tolerance` (RECOMMENDED)** — strictness is source-decided (*"beyond"* / *"exceeds"*); the absolute-value framing is the only reading that keeps FR-FIN-006 operative for shortages, which §15.4 and FR-POS-095's rationale identify as the motivating case.
> (b) Separate positive/negative tolerances — requires two configured values and a second column.

> **R-3 — Which effective version governs a CashSession.** P1G-1-CRITICAL (not migration-critical).
> **(a) The version effective at CashSession OPEN, resolved lazily at close (RECOMMENDED)** — matches this repository's own FR-LOC-021 implementation under identical SRS wording, needs no change to accepted open code, and (with the anti-backdating CHECK) makes the threshold immutable from the moment the drawer opens.
> (b) The version effective at CLOSE — simpler to describe; permits a manager to insert a new tolerance moments before a close is submitted.

> **R-4 — Approval expiry source for the synchronous manager-PIN path.** MIGRATION-CRITICAL under (a).
> **(a) A configured `variance_approval_expiry_seconds` on the cash-close policy version, no DB default (RECOMMENDED)** — nothing is invented anywhere in the codebase; consistent with FR-SEC-031's *"an expiry"* and FR-SEC-034's *"configured period"*.
> (b) A ratified constant, e.g. **15 minutes** by analogy to FR-SEC-026's stated POS idle default — the number is source-stated, the **linkage is not**.
> (c) Caller-supplied absolute timestamp — rejected as a client-controlled security window.

> **R-5 — Acknowledgement (not a blocker).** Accept that **a branch cannot close a cash session until its cash-close policy is configured** by a `settings.branch.manage` holder. This is derived (§2.1), not chosen; only a request for a *system-wide default tolerance value* would turn it into a ratification.

### 24.2 Full classification of every item this gate touched

| Item | Classification |
|---|---|
| Six-level cascade and its exact order (§6.4) | **SOURCE-DECIDED** |
| Lock's core semantic ("prevents override at lower levels"; locking level nameable) | **SOURCE-DECIDED** |
| Count mode values `blind`/`open`; branch as its configuration level; **blind as default** | **SOURCE-DECIDED** |
| `variance = counted − expected` (signed) | **SOURCE-DECIDED** |
| Reason mandatory; `cash.variance.approve`; approver ≠ session owner | **SOURCE-DECIDED** |
| Strictness of the comparison (`>` not `>=`) | **SOURCE-DECIDED** |
| Money as integer minor units + ISO currency; no cross-currency arithmetic | **SOURCE-DECIDED** |
| Settings writes and cash variances must be audited | **SOURCE-DECIDED** |
| **`settings.branch.manage` as the write permission** | **SOURCE-DECIDED** (corrects the brief's premise) |
| Thresholds are domain-owned, not Governance | **RATIFIED** (D-13, 2026-08-17) |
| `expires_at` mandatory, immutable, decision-time validity, no default duration | **RATIFIED** (D-10 E2, D-1, D-6) |
| `value` opaque; money as base-10 minor-unit strings | **RATIFIED** (item 7 + Clarification A) |
| Excluded approver is an Identity **User** id | **RATIFIED** (item 8 + Clarification B) |
| `request_type VARCHAR(32)`, no CHECK; enumeration stays OPEN | **RATIFIED** (item 1; D-16 OPEN) |
| `org.settings` deferred and unusable as approved | **RATIFIED** (ADR 0008 D-11) |
| `entity_type = 'cash_session'` | **REPOSITORY-DECIDED** (`AUDIT_ENTITY.CASH_SESSION`) |
| `CashSession.currency` exists; branch base currency is the source | **REPOSITORY FACT** |
| Reason as mandatory non-blank free text | **REPOSITORY-DECIDED** (`cash_movements.reason` precedent) |
| Column-level INSERT grant excluding a server-set timestamp | **REPOSITORY-DECIDED** (`approval_decisions` precedent) |
| Default only where the SRS states one | **REPOSITORY-DECIDED** (`recall_window_seconds` vs `cancelled_line_visibility_seconds`) |
| **S-3 selected**; Treasury ownership; `treasury` schema; migration 33 | **DESIGN-DECIDABLE NOW** |
| Effective-dated immutable versioning regardless of FR-PLT-028's scope | **DESIGN-DECIDABLE NOW** (stricter posture) |
| Backdating prohibited; future-dating permitted | **DESIGN-DECIDABLE NOW** |
| `request_type = 'cash.variance'` | **DESIGN-DECIDABLE NOW** (implementation-owned) |
| Snapshot = value **+** version id | **DESIGN-DECIDABLE NOW** |
| Fail-closed when unconfigured | **DESIGN-DECIDABLE NOW (derived)** — acknowledgement R-5 |
| Currency-mismatch fail-closed | **DESIGN-DECIDABLE NOW** (compelled by BR-CORE-001) |
| Fail closed when the session owner has no linked User | **DESIGN-DECIDABLE NOW** (closes the carried §3 note of the ratification record) |
| **Tolerance default value** | **NOT SOURCE-DECIDABLE** — and **not needed** (§2.1) |
| **Tolerance representation** | **NOT SOURCE-DECIDABLE → USER RATIFICATION REQUIRED (R-1)** |
| **Absolute vs signed comparison** | **ENGINEERING INTERPRETATION → USER RATIFICATION REQUIRED (R-2)** |
| **Which effective version governs a session** | **NOT SOURCE-DECIDABLE → USER RATIFICATION REQUIRED (R-3)** |
| **Approval expiry duration/source** | **NOT SOURCE-DECIDABLE → USER RATIFICATION REQUIRED (R-4)** |
| Whether FR-PLT-028 literally covers a control threshold | **NOT SOURCE-DECIDABLE** — dissolved by taking the stricter posture (§5.2) |
| Lock mechanics beyond the core semantic (self-freeze, inheritance, effective-dating) | **NOT SOURCE-DECIDABLE** — recorded for the future settings slice |
| Cash reason catalogue | **NOT SOURCE-DECIDABLE** — not invented |
| Cancelling a future-dated version | **NOT SOURCE-DECIDABLE** — recorded limitation |
| Platform Default and Country Pack cascade levels | **BLOCKED OUTSIDE THIS SLICE** — no backing entity; no cash content |
| Terminal-level settings | **BLOCKED OUTSIDE THIS SLICE** — no requirement asks for one here |
| FR-PLT-027 settings inspector `[S]` | **BLOCKED OUTSIDE THIS SLICE** |
| Offline sync of cash-close policy | **BLOCKED OUTSIDE THIS SLICE** — deferred, MVP-relevant |
| FR-POS-092 drawer-limit parameters | **BLOCKED OUTSIDE THIS SLICE** — compatibility only |
| FR-FIN-007 adjusting entries; denomination catalogue; X-report permission; Shift-close trigger | **BLOCKED OUTSIDE THIS SLICE** — carried unchanged from the prior gate |

### 24.3 Why no implementation prompt is issued

Per §32: **R-1 and R-4 are migration-critical and remain `USER RATIFICATION REQUIRED`.** Writing migration 33 now would mean choosing the tolerance's representation and the expiry's source unilaterally — the two decisions this gate exists to refuse. **No Sonnet implementation prompt is provided.**

---

## 25. FINAL VERDICT — §34

# **C. USER RATIFICATION REQUIRED — NARROW ITEMS PROVIDED**

**Four items: R-1 (migration-critical), R-2, R-3, R-4 (migration-critical), plus acknowledgement R-5.**
Everything else — storage strategy, owning module, schema, RLS, grants, immutability, snapshot design, resolver contract, count-mode default, write authorization, HTTP surface, approval literals, audit, and the full test matrix — is **resolved and implementation-writable**, with **no invented default, no invented permission code, no invented setting key, and no invented duration**.

---

## Scope compliance

No product implementation. No migration created (33 planned only; 34 not planned). No commit. No push. No deployment. No `D-21+`. No accepted Approval Runtime code modified. No destructive git command used at any point (`reset`, `restore`, `checkout`, `clean`, `stash`, `rebase` — none). HEAD `1f9ea1f` unchanged. The four uncommitted prior reports and every pre-existing `INDEX.md` row are byte-identical; `INDEX.md` is appended to only.
