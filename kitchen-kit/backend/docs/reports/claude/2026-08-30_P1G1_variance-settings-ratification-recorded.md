# P1G-1 Cash-Close Policy — Ratification RECORDED

**Task / slice:** P1G-1 variance tolerance / cash-close settings — governance recording of the user's ratification of R-1(a), R-2(a), R-3(a), R-4(a) and acknowledgement R-5
**Report type:** Governance recording. **No product code, no migration, no test change, no implementation, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. The **binding record is the Governance Decision Register entry** appended by this task — `## P1G-1 Cash-Close Policy Ratification — 2026-08-30` plus its Ratification-log bullet. **Where this report and the register differ, the register governs.** The occasioning report (`2026-08-30_P1G1_variance-settings-final-design-gate.md`) remains non-authoritative evidence; the SRS and ratified governance decisions remain authoritative.
**Date:** 2026-08-30
**HEAD:** `1f9ea1f` — *feat: add governance approval runtime* (unchanged; **no commit performed**)
**Branch:** `feat/production-spec`
**Working tree at start:** `docs/reports/claude/INDEX.md` modified; five untracked reports (`2026-08-26_MVP_…`, `2026-08-27_RENDER_…`, `2026-08-28_P1G1_…`, `2026-08-28_POST-P1F2_…`, `2026-08-30_P1G1_variance-settings-final-design-gate.md`).
**Working tree at report time:** the above, plus `GOVERNANCE_DECISION_REGISTER.md` modified (**284 insertions, 0 deletions**), plus one appended `INDEX.md` row, plus this report. **No product code, no migration, no test file touched.**
**Migrations:** 32 (unchanged — **migration 33 NOT created**).
**Task identifier:** P1G-1 variance/settings ratification recorded

> ## STATUS
> ## **RECORDED — FIVE RESOLUTIONS BINDING, TWO DESIGN CONSTRAINTS RECORDED**
>
> The user's ratification of **R-1(a), R-2(a), R-3(a), R-4(a)** and the
> **R-5 acknowledgement** is recorded in the register as an **unnumbered
> ratification entry**, in the established forward-supersession style, together
> with the two binding design constraints (**C-1** API versioning, **C-2** no
> backdating).
>
> **The register diff is `284 insertions, 0 deletions`** — mechanical proof that
> **no historical text was rewritten**, no decision renumbered, and **no `D-21`
> created**.
>
> **No substantive correction to the ratified content was required.** Unlike the
> 2026-08-29 recording, nothing in the user's instruction misdescribed an
> existing governance position. Two characterisations were **tightened during
> recording** so the register states them precisely rather than loosely — see §4;
> neither changes the ratified substance.

---

## 1. WHAT WAS RECORDED, AND WHERE

Two purely additive edits to `docs/governance/GOVERNANCE_DECISION_REGISTER.md`:

| # | Location | Content |
|---|---|---|
| 1 | New `##` section **`P1G-1 Cash-Close Policy Ratification — 2026-08-30`**, at line **6084** — appended chronologically **after** `## Approval Runtime Minimum Resolution — 2026-08-29` (line 5862) and **immediately before** `## Final Decision Matrix` (now line 6314) | Header block, *The question*, the five binding resolutions **R-1(a) … R-5**, *Binding design constraints* (**C-1**, **C-2**), *Not decided by this entry*, *Preservation*, *Implementation consequence*, `Status: RATIFIED — CLOSED` (230 lines) |
| 2 | New bullet appended to the **Ratification log** (line **6533**, inside the Final Decision Matrix section, immediately before the *"6 decisions remain fully unratified"* paragraph) | Condensed authoritative summary of all five resolutions, both design constraints, and every preservation clause (54 lines) |

**Placement rationale.** The register appends **dated, unnumbered** ratification sections in chronological order before the Final Decision Matrix — the pattern of *P1A / P1C / P1D*, *Fire Authorization — 2026-08-24*, *P1F-2 Completion Economics — 2026-08-25*, *FIFO Exhaustion Carry-Forward — 2026-08-25* and *Approval Runtime Minimum Resolution — 2026-08-29*. This entry follows that convention exactly, including the header-block form (*"RECORDED … by explicit user governance action"* / *"NOT a new numbered decision — no D-21 is created and the 20-decision tally is unchanged"*).

**Tally.** Unchanged: **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**. No numbered decision was added, amended by number, or renumbered. **D-16 remains the OPEN one.**

---

## 2. THE FIVE RESOLUTIONS AS RECORDED

| # | Resolution | Governance effect |
|---|---|---|
| **R-1(a)** | Variance tolerance is an **ABSOLUTE MONEY AMOUNT** — `BIGINT` **integer minor units** + **ISO 4217 currency**; policy currency corresponds to the CashSession/branch operational currency used for the comparison; **no floating-point money**; **no percentage tolerance in this phase**; no hybrid form | Resolves the design gate's **R-1**, which was `NOT SOURCE-DECIDABLE` and **migration-critical**. Consistent with **D-13** (thresholds domain-owned). **Recorded explicitly as user ratification resolving source silence — NOT as an SRS finding** |
| **R-2(a)** | Threshold test is **`abs(counted − expected) > tolerance`**; `<` and `=` are **within** tolerance, `>` is **beyond**. One scalar governs shortages and overages alike | Resolves **R-2**. The **strict `>` is source-backed** (`FR-FIN-006` *"beyond"*, `FR-POS-096` *"exceeds"*); the **absolute-value framing is the user's choice**. `FR-FIN-005`'s signed variance definition is **unchanged** — only the *threshold test* uses the magnitude |
| **R-3(a)** | A CashSession is governed by the policy version **effective at its OPEN time**, resolvable **lazily at close** via `cash_session.opened_at` as `asOf`; **never** the close-time current configuration | Resolves **R-3**. **No snapshot column is written at open** merely to implement the rule; the accepted **P1D-1 session-open path is NOT modified**. Does not disturb `FR-PLT-028`'s rule for closed historical records — it settles only the **in-flight** case the SRS does not address |
| **R-4(a)** | Synchronous cash-variance `ApprovalRequest.expiresAt` is derived from a **CONFIGURED POSITIVE DURATION on the immutable policy version** (`variance_approval_expiry_seconds INTEGER NOT NULL`, `CHECK > 0`); **no DB default, no application default, no `5m`/`15m`/`30m` constant** | Resolves **R-4**, which was **migration-critical**. **D-10 (E2) is UNCHANGED** — `expires_at` stays mandatory, explicit, immutable, evaluated lazily at decision INSERT, with no `expired` status and no scheduler. This entry supplies the **consuming domain's source** for the value, not a change to the generic runtime |
| **R-5** | **ACKNOWLEDGEMENT** — a branch cannot complete a CashSession close with **no valid policy version effective at the governing policy time**; **no default tolerance is invented**; `settings.branch.manage` (existing, source-named, already seeded) must configure the branch first; **`blind` remains independently source-defaulted under `FR-POS-095`** | Records the **derived** fail-closed consequence as accepted. The unconfigured state is the **absence of a version row**, not a column default — which is why **no default value enters the schema** |

### 2.1 The two binding design constraints, recorded as constraints — not requirements

* **C-1 — API versioning.** The slice **MUST NOT** perform an isolated **`/v1` retrofit**; the repository's current routing convention stands for the cash-close-policy administration route; **the global SRS `/v1` compliance gap remains separate and MUST NOT be silently declared fixed**; **no route URL is ratified**.
* **C-2 — No backdating** (a consequence of R-3(a)). Policy versions **MUST NOT be backdated by the application role**; enforcement **MAY** use a server-created immutable timestamp (excluded from the application role's column-level `INSERT` grant) plus `effective_from >= created_at`. Consequently a session opened **before** the first applicable version **cannot become eligible via a backdated version**; **no historical configuration may be invented**; and **already-open sessions at rollout are an explicit future implementation/operational decision**, never a silent weakening of R-3(a) or C-2.

---

## 3. WHAT WAS DELIBERATELY NOT RECORDED

The register entry carries an explicit **"Not decided by this entry"** block naming every item the brief listed, so none can later be read as settled by implication: the **system-wide settings architecture**; **Platform Default** storage; **Country Pack** cash settings; **Tenant / Brand / Terminal** cash-tolerance overrides; **`FR-PLT-026` lock mechanics** beyond existing source wording; the **settings inspector** (`FR-PLT-027` [S]); the **drawer-limit value or behaviour** (`FR-POS-092`); the **denomination catalogue**; **offline cash-close policy sync**; **transition handling for already-open sessions at rollout**; the **full CashSession Close implementation**; **Day Close**; **X / Z reports**; and **`NFR-PERF-006`**.

The block additionally names the **implementation details deliberately left to the Design Gate**, mirroring how the 2026-08-29 entry treated the same class of item: exact table/column/index names, exact RLS predicate SQL, the resolver interface shape, the route URL, and the audit action literal.

---

## 4. TWO CHARACTERISATIONS TIGHTENED DURING RECORDING

Neither changes the ratified substance. Both are recorded so the tightening is visible rather than silent.

### 4.1 R-2(a) — the strictness and the absolute value have **different** authority, and the register says so separately

The instruction states *"The strict `>` is source-backed by 'beyond'/'exceeds'"* and *"The absolute-value framing is the user-ratified choice."* Both are correct, and the register **keeps them apart in the binding text** rather than recording one undifferentiated ratified rule. This matters because a future reader must be able to tell which half survives if the source is ever re-read: the strictness is a **plain reading of two independent mandatory statements** (`FR-FIN-006` [M], `FR-POS-096` [M]) and would survive; the absolute-value framing is an **architectural ratification** and would not.

The entry also records, explicitly, that **`FR-FIN-005` [M]'s signed definition of variance is unchanged** — `Counted − Expected` is still what is computed and recorded on the session. Only the *threshold test* consumes the magnitude. Without that sentence, R-2(a) could later be misread as redefining the recorded variance as unsigned, which would contradict a mandatory requirement.

### 4.2 R-3(a) — "no snapshot needs to be written at open" is recorded as a **preservation of accepted code**, not merely an efficiency note

The instruction's phrasing (*"No snapshot needs to be physically written at open merely to implement this selection rule"*) is recorded together with its operative consequence: **no column is added to `treasury.cash_sessions` by this entry, and the accepted P1D-1 session-open path is NOT modified.** Stated as an efficiency note alone, an implementation slice could have read it as permissive; stated as a preservation clause, it is binding. This is the same treatment the 2026-08-29 entry gave to *"`authenticate()` is byte-unchanged"*.

**No claim was made that the SRS selected the tolerance representation.** The register's R-1(a) clause says so in terms: *"The SRS did NOT select this representation… This clause is the resolution, by user ratification, not an SRS finding."*

---

## 5. VERIFICATION (§9 of the brief)

### 5.1 Mechanical — executed in this session

```
git diff --check                                    → clean (exit 0)
git diff --numstat -- …/GOVERNANCE_DECISION_REGISTER.md
                                                    → 284    0
git diff -U0 -- …/GOVERNANCE_DECISION_REGISTER.md \
  | grep '^-' | grep -v '^---' | wc -l              → 0    (real deleted lines)
git diff -U0 | grep -E '^\+## D-[0-9]' | wc -l      → 0    (new numbered-decision headings)
git diff -U0 | grep -E '^\+## '                     → exactly one:
    +## P1G-1 Cash-Close Policy Ratification — 2026-08-30
git status --short                                  → only the register, INDEX.md,
                                                       and the untracked reports
```

**`284 insertions, 0 deletions` is the proof that no historical text was rewritten.** 230 lines are the new section, 54 the new Ratification-log bullet; the two sum exactly to 284, so **every changed line is an added line and none replaces existing text**. D-1 … D-20, P-1, PL, SB, the P0/P1A/P1C/P1D carried items, the Fire Authorization, P1F-2 Completion Economics, FIFO Exhaustion Carry-Forward and Approval Runtime Minimum Resolution entries are **byte-identical**.

### 5.2 Substantive — every check the brief required

| Check | Result | Evidence |
|---|---|---|
| No historical register text deleted or replaced | ✅ | 0 real deleted lines; 284/284 changed lines are insertions |
| **No `D-21+` created** | ✅ | 0 new `## D-nn` headings; entry declares *"no D-21 is created and the 20-decision tally is unchanged"* |
| **R-1(a) recorded** | ✅ | Section §"RATIFICATION" clause R-1(a) + log bullet |
| **R-2(a) recorded** | ✅ | Clause R-2(a) with the three-case table and the strict-`>` / absolute-value split |
| **R-3(a) recorded** | ✅ | Clause R-3(a), `cash_session.opened_at` as `asOf`, close-time selection excluded |
| **R-4(a) recorded** | ✅ | Clause R-4(a), `variance_approval_expiry_seconds INTEGER NOT NULL`, `CHECK > 0` |
| **R-5 acknowledgement recorded** | ✅ | Clause R-5, marked **(ACKNOWLEDGEMENT)** |
| **No default tolerance invented** | ✅ | *"No default tolerance is invented — the unconfigured state is the **absence of any policy version row**, not a column default"* |
| **No approval TTL constant invented** | ✅ | *"NO database default and NO application default duration… No `5m` / `15m` / `30m` constant is authorised"* |
| **Six-level hierarchy NOT falsely claimed implemented** | ✅ | *"`FR-PLT-025` [M]'s six-level hierarchy … remains **NOT IMPLEMENTED** by this narrow slice — the ratified policy is branch-scoped only"*, in **both** the section and the log bullet |
| **Locks NOT falsely claimed implemented** | ✅ | *"`FR-PLT-026` [M] settings locks remain **NOT IMPLEMENTED** by this narrow slice"*, in both places |
| Narrow policy not described as the Settings platform | ✅ | *"is NOT the generic Settings platform, and MUST NOT be described as implementing it"*; **ADR 0008 D-11 unchanged** |
| Approval Runtime Minimum Resolution preserved | ✅ | Preservation block: **P-1 unchanged · D-12 BLOCKED · D-16 enumeration OPEN · D-13 RATIFIED · async `FR-SEC-032` deferred · D-14 A-1 no Governance HTTP surface · D-20 no read surface · D-11 no notifications · `value` opaque `JSONB` with base-10 minor-unit strings · excluded approver = Identity USER id · `expires_at` semantics unchanged** |
| C-1 recorded as a design constraint, not a requirement | ✅ | *"recorded as implementation/design constraints, **NOT** as new business requirements"*; **no route URL ratified**; global `/v1` gap left open |
| C-2 recorded, with the rollout case left explicit | ✅ | *"already-open sessions at rollout … MUST be handled explicitly by a future implementation or operational decision"* |
| No new permission code | ✅ | *"No new permission code is created by this entry"*; `settings.branch.manage` cited as **existing and already seeded** (ADR 0008 D-01) |
| No product code changed | ✅ | `git status --short` — no file under `src/`, `prisma/` or `test/` |
| **No migration created** | ✅ | 32 migration directories, unchanged; entry states *"Migration 33 is NOT created by this entry"* |
| **No commit, no push** | ✅ | HEAD `1f9ea1f` unchanged; no `git commit`, no `git push` executed |
| No destructive git command | ✅ | No `reset`, `restore`, `checkout`, `clean`, `stash` or `rebase` at any point |
| Pre-existing uncommitted `INDEX.md` rows preserved | ✅ | `INDEX.md` diff is append-only (**0 deletions**) |

### 5.3 Repository invariants

`git status --short` reports exactly: `M` the Governance Decision Register, `M` `docs/reports/claude/INDEX.md`, and six untracked reports (five pre-existing, plus this one). **HEAD `1f9ea1f` unchanged.**

---

## 6. WHAT THIS UNBLOCKS, AND WHAT REMAINS

**Unblocked.** The design gate returned verdict **C — USER RATIFICATION REQUIRED**, blocked on exactly four items, **two of them migration-critical** (R-1, R-4). All four are now ratified. The accepted **S-3** design is therefore **implementation-writable** as **migration 33**, Treasury-owned: a typed, branch-scoped, immutable, effective-dated `treasury.cash_close_policies` carrying `count_mode` (`blind` | `open`, `blind` defaulted under `FR-POS-095` [M]), a `BIGINT` variance tolerance **with no default**, its currency, a **configured positive** approval-expiry duration, `tenant_id`, a branch composite FK, `ENABLE` + `FORCE` RLS, append-only grants, audit on write (`FR-AUD-006` [M] — *"configuration changes"*), `settings.branch.manage` write authorization, and a Treasury-private resolver.

**Still outstanding, and unaffected by this entry.** `FR-PLT-025` and `FR-PLT-026` remain **NOT IMPLEMENTED**. `FR-PLT-028` will reach **PARTIAL** (cash-close settings only — not tax class, rounding policy or service charge). `FR-FIN-006` remains **DESIGNED ONLY** until the P1G-1 close itself lands, and **is not claimed complete here**. `FR-POS-092` remains **NOT IMPLEMENTED** (compatibility only). The rollout/transition case for sessions already open before their branch is configured (C-2) is **explicitly open**. `FR-FIN-007`'s adjusting-entry clause, the denomination catalogue, the X-report permission and Shift-close semantics remain carried from the earlier gates.

**No implementation is authorised by this recording.** Building migration 33 requires a separate, explicitly authorised implementation task.

---

## 7. RECOMMENDED NEXT STEP

**Implement migration 33 + the Treasury cash-close policy substrate** to the accepted S-3 design, as a single narrow slice: table, enum, CHECK constraints, composite FK, column-level grants, RLS (`ENABLE` + `FORCE`), the Treasury-private resolver, the `settings.branch.manage`-guarded write route with `Idempotency-Key` and audit, and the real-Postgres test matrix (22 tests) — with items 5 and 6 asserted as **documented gaps**, never as `FR-PLT-025`/`026` coverage. P1G-1 CashSession Close then consumes the resolver and the already-accepted Approval Runtime.

---

## Scope compliance

Governance recording only. No product code. No migration created. No test change. No commit. No push. No deployment. No `D-21+`. No numbered decision added, amended by number, or renumbered. No destructive git command used. HEAD `1f9ea1f` unchanged. Every pre-existing uncommitted `INDEX.md` row and every prior report left byte-identical; `INDEX.md` appended to only.
