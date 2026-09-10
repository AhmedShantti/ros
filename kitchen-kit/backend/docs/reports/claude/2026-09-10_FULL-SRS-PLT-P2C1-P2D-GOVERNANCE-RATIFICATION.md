# FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION

**Report type:** Governance recording only. No implementation.
**Authority statement:** This report is non-authoritative evidence. The
binding record of this ratification is
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, entries `P2C1-R1` and
`P2D-R1`. Where this report's own narrative differs from those register
entries, THE REGISTER ENTRIES GOVERN.
**Date:** 2026-09-10
**Task identifier:** `FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION`
**Previous HEAD:** `5dc916c20f909306dfcc3e3b2beeaa420686bc42`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree before this task:** clean except pre-existing untracked
reports from other, unrelated sessions (unchanged from the P2C/P2C1/P2C2
baseline — not touched by this task).

## Governance action

The project owner, by explicit user governance action on 2026-09-10,
**RATIFIED BOTH** of the following governance packages in full:

1. **`P2C1-R1`** — Cash-Rounding Settings Ownership Clarification, using
   the CORRECTED six-clause text from
   `docs/reports/claude/2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-CONFIG-SHAPE-AND-LOCK-COHERENCE-P2C2.md`
   §6 (superseding the earlier, uncorrected draft in
   `docs/reports/claude/2026-09-10_FULL-SRS-PLT-CASH-ROUNDING-SETTINGS-COHERENCE-GATE-P2C1.md`
   §8 wherever the two differ), plus the Country-Pack lock test-causality
   implementation note from `P2C2` §7.
2. **`P2D-R1`** — ServiceChargePolicy Configuration/Version Semantics,
   using the twelve-clause text from `P2C2` §8.

Both are recorded in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` as
**unnumbered ratified entries**, matching the established `P1C / P1G-1 /
RCPT-R1 / D1-1 / AUD-R1 / P2A-R1` convention: no `D-21` is created, and the
20-decision numbered tally (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN)
is unchanged.

**`P2C2` is the controlling design report for both decisions.** For
`P2C1-R1` specifically, `P2C2` §6's corrected text supersedes the earlier
`P2C1` draft wherever they differ (two corrections: a distinct,
non-"locked" rejection message; an explicit requirement-status-impact
clause).

## Register entries recorded

Both tags were verified UNUSED before recording (`grep -n "P2C1-R1\|P2D-R1"
docs/governance/GOVERNANCE_DECISION_REGISTER.md` returned no hits prior to
this task). Both entries were appended at the end of the register,
immediately after the existing `P2A-R1` entry (the register's prior last
entry), following the file's own established structural convention for a
narrow, unnumbered ratification (`RECORDED ... by explicit user governance
action` header blockquote → `The question` → `RATIFICATION` clauses →
`Not decided by this entry` → `Preservation` → `Evidence (non-
authoritative)` → `Status:`), the same shape `P1G-1`/`P2A-R1` already use.

### `P2C1-R1` — Cash-Rounding Settings Ownership Clarification

Records, as RATIFIED, the six substantive clauses given verbatim in this
task's own instruction: `payments.cash_rounding_policy` is
PROVIDER-EXCLUSIVE (grounded in FR-POS-063/FR-FIN-035/BR-FIN-004/FR-LOC-020);
invalid lower-level writes are rejected 409 (existing `ConflictException`
class/status, distinct non-"locked" message required); provider-exclusivity
is structurally distinct from `FR-PLT-026` locking (`isProviderExclusive`
static per-key capability vs. `CountryPack.settingsLocks`'s dynamic per-pack
declaration — never fabricate `locked=true`); applies only to
`payments.cash_rounding_policy` at ratification time, no blanket rule for
future keys; no data migration required; and formal requirement statuses
are explicitly unchanged (`FR-PLT-025`=COMPLETE, `FR-PLT-026`=COMPLETE,
`FR-PLT-027`=COMPLETE, `FR-PLT-028`=PARTIAL, `BR-FIN-004`=COMPLETE). Also
records, as a non-blocking "Implementation/testing note," the Country-Pack
lock test-causality guidance (Cases A/B/C, the P2B e2e test's write-
rejection comments needing correction, and the explicit prohibition on
inventing a fake production Country-Pack key or weakening
`COUNTRY_PACK_SETTING_KEYS`) — stated explicitly as NOT altering
`FR-PLT-026`'s COMPLETE status.

### `P2D-R1` — ServiceChargePolicy Configuration/Version Semantics

Records, as RATIFIED, the twelve substantive clauses given verbatim in
this task's own instruction: Sales ownership (`sales.service_charge_
policies`, not generic `SettingValue`); tenant→brand→branch hierarchy only;
the complete version-row content (typed `rules` JSONB rule-set —
`orderType | null`, `minGuestCount | null` meaning "`guestCount >=
minGuestCount`", `ratePercent` exact-decimal — `orderType: null` = all
order types, `rules: []` = explicitly no service charge, no
`maxGuestCount`/ranges invented, `OrderType` values validated against the
existing authoritative vocabulary); one immutable version row with `rules
JSONB NOT NULL`, no child-rule table, app validation + `jsonb_typeof` CHECK
backstop, ADR-008 exact-decimal discipline; immutability/effective-dating
carried forward from `P2A-R1` verbatim (DB-time defaults, anti-backdating
CHECK, excluded `created_at` INSERT grant, no UPDATE ever, future-only RLS
DELETE); `locked` on each version row, never sourced from mutable generic
`SettingValue`; governing instant = `Order.openedAt` (the same instant
already pinning `Order.countryPackVersion`; offline `originDeviceTime`
does not substitute); `Order.serviceChargePolicyVersionId` (nullable,
tenant-leading composite FK, `ON DELETE RESTRICT`); the P2D/P2E boundary
(P2D = complete configuration substrate; P2E = rule matching, real
`serviceChargeTotal`, `serviceChargeTaxable` application, tips, discount
interaction, receipt/event consequences) with the explicit statement that
`FR-PLT-028` remains PARTIAL after P2D and becomes COMPLETE-eligible only
after P2E; audit action names; permission reuse
(`ORGANISATION_PERMISSIONS.TENANT_MANAGE`/`BRANCH_MANAGE`, no new
permission minted); and FR-PLT-027 inspector integration as NOT required
by P2D (a narrow current-policy read suffices).

## Requirement status — recorded explicitly, unchanged by ratification

```
FR-PLT-025 = COMPLETE
FR-PLT-026 = COMPLETE
FR-PLT-027 = COMPLETE
FR-PLT-028 = PARTIAL
```

Ratification is a governance action, not an implementation action — it
changes no formal requirement status on its own. `P2C1-R1` removes the
governance blocker that previously stood in front of the cash-rounding
coherence correction; `P2D-R1` removes the governance blocker that
previously stood in front of the `ServiceChargePolicy` configuration
substrate. Neither entry itself implements anything, and `FR-PLT-028`
explicitly cannot become COMPLETE from either ratification alone (per
`P2D-R1` clause 9) — it requires a future P2E-era implementation and
evidentiary report.

## Scope discipline

Per instruction, this task is GOVERNANCE RECORDING ONLY. Verified:

- `src/` — untouched (no `git status` change under this path).
- `prisma/` — untouched (no schema/migration change).
- `docs/api/` — untouched (no OpenAPI regeneration was run; no diff
  possible since nothing that affects the API surface changed).
- NOT implemented, per instruction: `isProviderExclusive`, the
  cash-rounding correction itself, `ServiceChargePolicy` (table, model,
  service, resolver, controller), `Order.serviceChargePolicyVersionId`,
  service-charge calculation, tips, or any discount-interaction change.

Only three files were touched, all within the explicitly authorized
governance-recording scope: `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
(the two new entries), this report, and `docs/reports/claude/INDEX.md`.

## Files changed / commit

```
M  docs/governance/GOVERNANCE_DECISION_REGISTER.md
A  docs/reports/claude/2026-09-10_FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION.md
M  docs/reports/claude/INDEX.md
```

Committed together as one commit on `full-srs/lane-d4-reporting-demo`. Not
pushed, per instruction.

---

## RETURN

```
PREVIOUS_HEAD: 5dc916c20f909306dfcc3e3b2beeaa420686bc42

P2C1_DECISION_ID: P2C1-R1
P2C1_STATUS: RATIFIED — CLOSED

P2D_DECISION_ID: P2D-R1
P2D_STATUS: RATIFIED — CLOSED

RATIFIED_BY_EXPLICIT_USER_ACTION: YES, both, 2026-09-10.

FR_PLT_025_STATUS: COMPLETE (unchanged)
FR_PLT_026_STATUS: COMPLETE (unchanged)
FR_PLT_027_STATUS: COMPLETE (unchanged)
FR_PLT_028_STATUS: PARTIAL (unchanged — becomes COMPLETE-eligible only
  after a future P2E implementation, per P2D-R1 clause 9)

REGISTER_PATH: docs/governance/GOVERNANCE_DECISION_REGISTER.md
REPORT_PATH: docs/reports/claude/2026-09-10_FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION.md
INDEX_UPDATED: YES

FILES_CHANGED: docs/governance/GOVERNANCE_DECISION_REGISTER.md (modified,
  two new unnumbered entries appended), docs/reports/claude/2026-09-10_FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION.md
  (new), docs/reports/claude/INDEX.md (modified, one new row appended)
COMMIT: recorded below, this task's own commit hash

SOURCE_FILES_TOUCHED: none
PRISMA_TOUCHED: none
OPENAPI_TOUCHED: none

SAFE_TO_BEGIN_P2C1_IMPLEMENTATION: YES — governance blocker removed.
SAFE_TO_BEGIN_P2D_IMPLEMENTATION: YES — governance blocker removed. Both
  may proceed in parallel or in either order (P2C1 baseline §9, reaffirmed
  across P2C1/P2C2, unchanged by this ratification — no shared code,
  table, or key between the two corrections).
```
