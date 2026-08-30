# P1G-1 R-6 — Cash Variance Approval Rejection Recovery — Ratification Recorded

**Report type:** Governance recording. **No product code, no migration, no test changes, no OpenAPI change, no implementation, no commit, no push.**
**Authority statement:** This report is **non-authoritative evidence**. The **binding record is the Governance Decision Register entry** appended by this task (`## R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30`, plus its Ratification-log bullet). Where this report and the register differ, **the register governs**. The four occasioning CashSession Close design reports remain non-authoritative evidence.
**Date:** 2026-08-30
**HEAD:** `0f10afe` (unchanged; no commit performed)
**Branch:** `feat/production-spec`
**Working tree:** register + `INDEX.md` modified; this report added. Unrelated uncommitted reports (the 4 pre-existing reports plus the 4 P1G-1 CashSession Close design reports) untouched.
**Task identifier:** P1G-1 R-6(a) ratification recorded

> ## STATUS
> ## **A. R-6(a) RATIFICATION RECORDED CLEANLY**
>
> The user's explicit ratification of **R-6(a)** (variance-approval rejection
> recovery) is recorded in the register as an **unnumbered ratification
> entry**, in the established forward-supersession style — the exact pattern
> the *P1G-1 Cash-Close Policy Ratification — 2026-08-30* and *Approval Runtime
> Minimum Resolution — 2026-08-29* entries already use.
>
> **The register diff is `156 insertions, 0 deletions`** — mechanical proof
> that **no historical text was rewritten**, no decision renumbered, and **no
> `D-21` created**. Exactly one new `##` heading was added
> (`## R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30`),
> and it is **unnumbered**, matching the register's own convention for
> user-ratified operational items that are not among the original D-1…D-20
> design-gate decisions.

---

## 1. WHAT WAS RECORDED, AND WHERE

Two additive edits to `docs/governance/GOVERNANCE_DECISION_REGISTER.md`:

| # | Location | Content |
|---|---|---|
| 1 | New `##` section **`R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30`**, appended immediately after the *P1G-1 Cash-Close Policy Ratification — 2026-08-30* entry and immediately before `## Final Decision Matrix` | Header block, *The question*, the RATIFICATION (14 numbered clauses of R-6(a)), an *Expiry is explicitly OUT OF SCOPE for R-6* subsection, *Authority classification*, *Preservation*, *Implementation consequence*, `Status: RATIFIED — CLOSED` |
| 2 | New bullet appended to the **Ratification log** (inside the Final Decision Matrix section, immediately after the P1G-1 Cash-Close Policy Ratification's own log bullet and before the *"6 decisions remain fully unratified"* paragraph) | Condensed authoritative summary of the R-6(a) semantics, the expiry exclusion, the authority classification, and every preservation clause |

**Placement rationale.** The register appends **dated, unnumbered** ratification sections in chronological order before the Final Decision Matrix — the pattern of *P1A / P1C / P1D*, *Fire Authorization*, *P1F-2 Completion Economics*, *FIFO Exhaustion Carry-Forward*, *Approval Runtime Minimum Resolution*, and *P1G-1 Cash-Close Policy Ratification*. This entry follows that convention exactly, including the header-block form (*"RECORDED … by explicit user governance action"* / *"NOT a new numbered decision — no D-21 is created and the 20-decision tally is unchanged"*).

**Tally.** Unchanged: **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**. No numbered decision was added, amended by number, or renumbered. **D-16 remains the OPEN one; D-12 remains BLOCKED.**

---

## 2. THE R-6(a) SEMANTICS AS RECORDED — EXACT USER RATIFICATION

All 14 numbered clauses from the user's ratification are recorded **verbatim in substance**:

1. CashSession **remains `CLOSING`**.
2. Physical count **remains immutable**.
3. `closeAttemptId` **remains unchanged**.
4. The immutable `cash_session_close_attempt` **remains authoritative**.
5. Payments **remain blocked**.
6. Cash movements (pay-in, pay-out, safe-drop) **remain blocked**.
7. The CashSession **MUST NOT** reopen, return to `OPEN`, permit a recount, or replace/delete the close attempt.
8. The close **MAY be retried** with a **NEW** `ApprovalRequest` id and a **NEW** `ApprovalDecision` id.
9. The retry **MAY** use another qualified manager and **MAY** carry a different variance reason.
10. Every rejected `ApprovalRequest`/`ApprovalDecision` **remains immutable and auditable in Governance**.
11. A later **APPROVED** retry may transition `CLOSING → CLOSED`.
12. The final `cash_sessions.variance_reason` is the reason on the **APPROVED** close, never a prior rejected attempt's.
13. **No supervisor-override or escalation permission is introduced.**
14. **D-12 remains BLOCKED.**

---

## 3. EXPIRY — EXPLICITLY EXCLUDED FROM R-6

Recorded as a **distinct subsection**, not folded into the 14 clauses, precisely because expiry is **not** a business-ratified state:

- expiry is checked **at decision time** (`D-10` E2, unchanged);
- the synchronous P1G-1 flow computes `expiresAt` from the **database's own `statement_timestamp()`**, read immediately before request creation — not `transaction_timestamp()`, not an application clock;
- if a decision is attempted after `expires_at` has passed, the Approval Runtime's RLS `WITH CHECK` rejects the INSERT and **throws**;
- the **whole finalize transaction rolls back**, taking the just-created `ApprovalRequest` with it;
- **no expired `ApprovalRequest` survives** — there is no orphan Governance state for a business policy to govern;
- the CashSession **remains `CLOSING`**, the attempt is **untouched**, and retry creates a **fresh** request.

**`D-10` is NOT amended by this entry.** The register states this in terms: *"Expiry is therefore a technical rollback/retry path, not an R-6 business state, and `D-10` is NOT amended by this entry."*

---

## 4. AUTHORITY LABEL — RECORDED PRECISELY

The register states plainly: **R-6(a) is USER-RATIFIED business behaviour resolving a source-silent operational recovery question. It is NOT an SRS-derived requirement.** Its compatibility rationale (not mandate) is recorded against exactly four requirements — `FR-POS-095` [M] (blind-count integrity), `FR-FIN-006` [M] (variance approval), `FR-SEC-016` [M] (self-approval prevention), `FR-SEC-033` [M] (immutable approval decisions) — with an explicit disclaimer that **none of those requirements themselves specifies retry-after-rejection semantics**, so no false SRS-derivation claim is made.

---

## 5. WHAT WAS PRESERVED — VERIFIED, NOT MERELY ASSERTED

| Item | Status after this entry |
|---|---|
| R-1(a), R-2(a), R-3(a), R-4(a), R-5 | **Unchanged** — not referenced for amendment anywhere in the new text |
| D-1 … D-20 | **Unchanged** — the Final Decision Matrix table itself has zero diff lines (confirmed: the only additions are the new `##` section and the one log bullet) |
| D-12 (Escalation Semantics) | **Remains BLOCKED** — stated twice (clause 14 and the Preservation paragraph) |
| D-16 (`request_type` Enumeration) | **Remains OPEN** — restated in Preservation |
| P-1 (parent linkage) | **Remains RATIFIED and UNCHANGED** — restated in Preservation |
| D-15 (one-decision-per-request amendment) | **Untouched** — restated in Preservation |
| D-14 A-1 (no Governance HTTP surface) | **Remains unchanged** — restated in Preservation |
| Decision tally | **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN** — unchanged |
| New permission codes | **None created** |
| New schema | **None created by this entry** |

---

## 6. VERIFICATION (§10 of the brief)

### 6.1 Mechanical

```
git diff --check                                    → clean (exit 0)
git diff --numstat -- …/GOVERNANCE_DECISION_REGISTER.md
                                                    → 156    0
git diff -U0 -- …/GOVERNANCE_DECISION_REGISTER.md \
  | grep '^-' | grep -v '^---' | wc -l              → 0    (real deleted lines)
git diff -U0 | grep -E '^\+## D-[0-9]' | wc -l      → 0    (new numbered-decision headings)
git diff -U0 | grep -E '^\+## '                     → exactly one:
    +## R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30
```

**`156 insertions, 0 deletions` is the proof that no historical text was rewritten.** All prior sections — including the Final Decision Matrix table itself, D-1…D-20, P-1, PL, SB, and every earlier dated ratification — are **byte-identical**.

### 6.2 Substantive — every check the brief required

| Check | Result |
|---|---|
| Governance edit is additive | ✅ — 156/0, zero real deletions |
| R-6(a) semantics exactly match the user ratification | ✅ — all 14 numbered clauses recorded verbatim in substance (§2 above) |
| No `D-21+` | ✅ — 0 new `## D-nn` headings; the new heading is unnumbered `## R-6 —…` |
| No existing decision status changed | ✅ — D-12 still BLOCKED, D-16 still OPEN, P-1 still RATIFIED, tally unchanged at 17/1/1/1 |
| No existing ratified text silently rewritten | ✅ — 0 deleted lines anywhere in the file |
| No product/schema/test/OpenAPI file changed | ✅ — `git status` shows only the register and `INDEX.md` modified, plus this report added |

### 6.3 Repository invariants

`git status --short` (scoped to this task's effect): only `docs/governance/GOVERNANCE_DECISION_REGISTER.md` and `docs/reports/claude/INDEX.md` modified, plus this report added. **No product code. No migration** (33, unchanged — migration 34 remains uncreated). **No test changes. No OpenAPI change** (3.1.0 / 139, unchanged). **HEAD `0f10afe` unchanged. No commit. No push. No deployment.**

---

## 7. WHAT THIS UNBLOCKS, AND WHAT REMAINS

The CashSession Close design track's **sole outstanding `USER RATIFICATION REQUIRED` item is now resolved.** All four prior design/closure reports converge on this single ratification, and R-6(a) is exactly the option each recommended and none contested.

**Not authorised by this recording:** migration 34 (planned in full across the four design reports, **not created**); the close state machine, routes, Sales tender-totals contract, the Payment advisory-lock correction, or the `CashSessionsService.open` boundary fix (all designed, **none implemented**). A separate, explicitly authorised implementation task is required before any of that lands.

**This report does not self-declare P1G-1 implementation complete**, per the brief's own instruction.

---

## 8. VERDICT

# **A. R-6(a) RATIFICATION RECORDED CLEANLY**

---

## Scope compliance

Governance recording only. No product code. No migration created (33 unchanged; migration 34 remains a plan only). No test changes. No OpenAPI change. No commit, no push, no deployment. No `D-21+`. No numbered decision added, amended by number, or renumbered. No destructive git command used. HEAD `0f10afe` unchanged. Every pre-existing uncommitted report — the 4 unrelated ones and the 4 P1G-1 CashSession Close design reports — left byte-identical; `INDEX.md` appended to only.
