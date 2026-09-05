# P0-REBASE-2 — FULL SRS v1.0 CURRENT-HEAD TRACEABILITY REBASE AFTER MW1F (CORRECTED)

| Field | Value |
|---|---|
| **Task / slice name** | P0-REBASE-2 — Full SRS v1.0 current-HEAD traceability rebase onto the canonical integration branch after `MW1F` |
| **Report type** | AUDIT / ANALYSIS / TRACEABILITY (no implementation) |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was observed and measured this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. |
| **Date** | 2026-09-03 |
| **HEAD** | `7ba8a71d4ac223ee533b8e1970490e7f9fd11bb3` (verified at session start; unchanged throughout — audit/analysis only) |
| **Branch** | `full-srs/4day-integration` |
| **Working tree** | Clean at session start and end. Product/test/schema/migration files untouched throughout. |
| **Task identifier** | P0-REBASE-2 |
| **Status** | **COMPLETE — SUPERSEDES `2026-09-03_FULL-SRS-current-head-traceability-rebase.md` (§0)** |

---

## 0. Correction notice — read this first

This is the **`_02`** report for this slice, produced the same day as an earlier attempt. The
original `2026-09-03_FULL-SRS-current-head-traceability-rebase.md` / `.csv` files are **left
untouched, byte-for-byte**, as the historical record of what happened — per this repository's
"never overwrite, use `_02`" convention — but **their content is superseded and must not be used**.

**What went wrong.** This task was executed by decomposing the 733-row requirement set into 8
domain-scoped fragments (Inventory, Security & Identity/Platform & Tenancy/API Platform/Audit &
Governance, Offline & Sync, NFR Observability, NFR Performance, Critical Test Scenarios, DevOps &
Operations/QA/NFR Reliability, NFR Maintainability), each independently re-assessed against
current-HEAD evidence. Three of these fragments were delegated to background subagents; the rest
were done directly in-session. One subagent, assigned only the 36-row Offline & Sync fragment,
instead independently merged **all** fragments, wrote the full report, and created a git commit
(`664a60a`) — without waiting for review, and before two of the other fragments (this session's
own Observability/Performance/CT/DevOps-QA work) had been read from their final, correct versions.
A second, separate defect was found independently: concurrent background processes writing into
the same shared scratch directory caused four of this session's own fragment files to be silently
overwritten mid-task.

**How it was caught.** Every fragment's "changed" rows were diffed against the committed final CSV
by exact `(implementation_status, verification_status)` identity, with vocabulary normalization
applied first to avoid false positives. This surfaced **5 real content mismatches** (`FR-INV-010`,
`FR-INV-031`, `FR-INV-045`, `FR-SEC-049`, plus the overwritten-fragment risk to the Observability/
Performance/CT/DevOps-QA rows) and, separately, **5 rows with internally inconsistent blocking
flags** (a row correctly marked `COMPLETE`/`VERIFIED-PASSING` that still carried a stale
`pilot_blocking`/`production_blocking`/`full_srs_blocking` = `YES` from its pre-upgrade state:
`CT-08`, `FR-OFF-021`, `FR-OFF-022`, `FR-OFF-023`, `FR-OFF-025`).

**What this report does differently.** All 8 fragments were re-verified or, where overwritten,
re-authored from this session's own original analysis (the content is identical to what was first
produced — nothing new was invented to "fix" the numbers, only the merge integrity was restored).
The Offline & Sync domain's 36 rows, found on inspection to be well-reasoned, internally
consistent, and closely tracking the accepted D4-1A/D4-1B reports' own language, were extracted
from the flawed commit and used as-is as the eighth verified fragment — they were not the source
of the defect. A full integrity sweep (every fragment `changed=YES` row matches the final CSV
exactly; every `UNCHANGED` row matches the prior baseline exactly, normalized; every `CHANGED` row
in the final CSV is explained by some fragment; zero duplicate/missing/extra requirement IDs) now
passes with **zero discrepancies**. The 5 blocking-flag inconsistencies were corrected to match
their corrected status. No git history was rewritten — this is a new commit, not an amend.

---

## 1. Prior baseline (verbatim, unchanged)

The existing canonical baseline is **P0-REBASE**, `2026-09-02_FULL-SRS-current-head-traceability-rebase.md`
+ `.csv` (captured at commit `358feb4`, the second commit on `full-srs/4day-integration`, i.e. the
branch's own fork point plus one commit). Its exact prior totals, reconfirmed by this session
reading the CSV programmatically (not quoting the report's prose):

- **733 requirement rows.**
- Implementation: **COMPLETE 110 · PARTIAL 171 · NOT IMPLEMENTED 451 · OUT OF SCOPE 1.**
- Verification (old vocabulary): **VERIFIED 83 · PARTIALLY VERIFIED 80 · UNVERIFIED 473 ·
  NOT YET VERIFIABLE 44 · EXTERNAL CERTIFICATION REQUIRED 53.**
- Production readiness: **READY 82 · NOT READY 565 · EXTERNAL BLOCKER 53 · NOT APPLICABLE 33.**
- Blocking: pilot **25 YES / 708 NO** · production **95 YES / 638 NO** · full-SRS **622 YES / 111 NO.**
- **4 dangling/unmapped IDs** (referenced in the SRS text but never defined, and therefore absent
  from the 733-row set, unchanged since the SRS PDF itself has not changed): `FR-SEC-018`,
  `FR-RPT-055`, `FR-INT-020`, `FR-PLT-041`.

This report **inherits the 733-row requirement inventory unchanged** — the SRS PDF did not change
between P0 and now, so no ID was added, removed, or renumbered.

## 2. Scope of this rebase — what could plausibly have changed

`full-srs/4day-integration` forks from `0887193` **exactly** (`git merge-base` confirmed), and the
P0-REBASE report's own commit (`358feb4`) is the branch's very next commit. The **46 commits** from
there to current HEAD `7ba8a71` are therefore *exactly* the accepted work this rebase accounts for:

- **A1-1** (movement write-path exact-decimal/atomicity fix + acceptance correction), **A1-2**
  (FIFO lock grouping), **A1-3** design gate **+ A1-3A** (effect reservation) **+ A1-3B** (group
  write path, 28-statement set-oriented depletion), **A1-4** (concurrency-matrix closure).
- **B1-1** (branch-scoped-RBAC governance gate + ratification), **B1-2** (scoped role assignments,
  migration 36), **B1-3** (route-wide scoped authorization) **+ acceptance correction**.
- **D4-1A** (offline sync protocol kernel), **D4-1B** (offline domain operations: `kds.ticket.
  bump_line`, live authorization, revoked-terminal recovery) **+ acceptance correction**.
- **G1-1** (CI pipeline), **G1-2** (deterministic e2e harness), **G1-3** (observability baseline).
- **MW1A** through **MW1F** (every integration wave that merged the above onto this branch, with
  their own cross-lane reconciliation).

A **full sweep of 252 rows** across the 8 domains these 46 commits could plausibly touch (Inventory
+ Business Rules — Inventory; Security & Identity + Platform & Tenancy + API Platform + Audit &
Governance + Business Rules — Platform; Offline & Sync; NFR Observability; NFR Performance;
Critical Test Scenarios; DevOps & Operations + Quality Assurance + NFR Reliability; NFR
Maintainability) was performed, row by row, deciding for each whether its substance is plausibly
affected by the enumerated work. The remaining **481 rows** (every other domain: POS/Sales,
Catalogue & Recipes, Kitchen Display, Branch & Central Kitchen, Costing & Profitability,
Procurement, Workforce/HR, CRM & Loyalty, Finance & Treasury, Fiscal Country Packs, Localisation,
Reporting & Analytics, External Integrations, Data Architecture & DR, and the remaining NFR/BR/CR/
UC/IR categories) were carried forward **verbatim** — no commit in this integration range touches
any code, test, migration, or design surface those rows depend on. `FR-KDS-024`/`FR-KDS-025`
(online bump/recall UI, Kitchen Display domain) were spot-checked explicitly and confirmed
unaffected: they depend on the pre-existing online HTTP bump/recall routes, a mechanism entirely
distinct from D4-1B's offline sync handler (which reuses the same underlying `kds.operate`
permission but is a separate code path with its own registration).

## 3. Result — 53 rows changed, out of 252 swept, out of 733 total

Every changed row is listed in the CSV's `delta_from_p0`/`delta_reason` columns, with a specific
current-HEAD citation (file, test suite + pass count, migration name, or accepted-report section).
Summary by domain fragment:

| Fragment | Rows swept | Rows changed |
|---|---:|---:|
| Inventory (+ Business Rules — Inventory) | 53 | 5 |
| Security & Identity (+ Platform & Tenancy, API Platform, Audit & Governance) | 89 | 14 |
| Offline & Sync | 36 | 14 |
| NFR Observability | 7 | 4 |
| NFR Performance | 16 | 5 |
| Critical Test Scenarios | 15 | 5 |
| DevOps & Operations / QA / NFR Reliability | 27 | 3 |
| NFR Maintainability | 9 | 3 |
| **Total** | **252** | **53** |

Of the 53: **35 upgrades**, **1 downgrade**, **17 same-status evidence-only refreshes** (repo_
evidence/test_evidence corrected to reflect current-HEAD reality without moving the status —
e.g. `CT-01`/`CT-03`/`CT-14`, whose prior evidence text ("no offline capability exists" / "no CRDT
machinery" / "no sync backlog") predates D4-1A/D4-1B and is now factually wrong even though the
hard status rules correctly cap the requirement below COMPLETE).

**The one downgrade**: `FR-SEC-028` (terminal revocation + local-data wipe) **COMPLETE → PARTIAL**,
propagating B1-1's own governance-gate finding — "local-data wipe on next contact is not
implemented" — into the traceability record for the first time; the P0 baseline had missed this.

Every hard status rule given for this task was honoured, verbatim, with a citation:

- `BR-INV-003`, `FR-INV-011`, `FR-INV-051` all **stay PARTIAL** — no scheduler exists anywhere in
  the repository; a synchronous count-posting variance calculation was explicitly **not** credited
  as evidence of a *scheduled* daily reconciliation job.
- Offline `kds.ticket.recall` is confirmed **UNREGISTERED**; `CT-03`, `FR-OFF-040`, `FR-OFF-043`,
  `FR-OFF-045`–`047` all stay short of COMPLETE, each citing the missing persisted HLC watermark
  by name.
- Recovery stays **CANDIDATE, NOT RATIFIED**; recovery invariants **#4 NOT PROVEN**, **#7 FAIL**,
  **#9 NOT PROVEN**; the **lossless recovery hard gate stays NOT CLOSED**; **D4-1 FULL stays NOT
  COMPLETE** — none of these are claimed anywhere in the CSV or this report.
- `NFR-PERF-032` moved **NOT IMPLEMENTED → PARTIAL** only, with `notes` explicitly distinguishing
  this session's local, suite-level, mixed-workload measurements (800 ms–2.5 s, under budget for
  the paths exercised) from a certified, isolated, 500-operation-at-p95 reference benchmark, which
  does not exist.
- `FR-PLT-013` stays **PARTIAL**: the literal SRS text (a CI-executed, information-schema-
  *generated* cross-tenant RLS isolation suite) is a different mechanism from B1-3's hand-written
  route-classification coverage gate, even though G1-1 now runs that gate in real CI.
- `NFR-OBS-005`/`006` stay **PARTIAL**: allowlist redaction covers the metadata channel only (not
  free-text messages); alerting covers 2 named backend-API SLOs + 1 error-rate SLO, not "every SLO
  breach."
- Authorization coverage cited exactly as measured this session (MW1F): **159 total routes, 142
  permission-bearing declared, 0 undeclared, 17 reviewed auth-only/tenant-target exemptions.**

## 4. Exact new totals

| Axis | Value |
|---|---|
| **Total requirement rows** | **733** (unchanged — SRS did not change) |
| **Dangling/unmapped IDs** | **4** (unchanged — SRS did not change) |
| Implementation: COMPLETE | **127** (was 110, **+17**) |
| Implementation: PARTIAL | **177** (was 171, **+6**) |
| Implementation: NOT IMPLEMENTED | **428** (was 451, **−23**) |
| Implementation: OUT OF SCOPE | **1** (unchanged) |
| Verification: VERIFIED-PASSING | **97** (was 83 `VERIFIED`, **+14**) |
| Verification: PARTIALLY VERIFIED | **92** (was 80, **+12**) |
| Verification: UNVERIFIED | **448** (was 473, **−25**) |
| Verification: NOT YET VERIFIABLE | **43** (was 44, **−1**) |
| Verification: EXTERNAL CERTIFICATION | **53** (was 53 `EXTERNAL CERTIFICATION REQUIRED`, unchanged — mechanical rename only) |
| Pilot-blocking (YES) | **16** (was 25, **−9**) |
| Production-blocking (YES) | **86** (was 95, **−9**) |
| Full-SRS-blocking (YES) | **605** (was 622, **−17**) |

Verification vocabulary was normalized project-wide (`VERIFIED`→`VERIFIED-PASSING`,
`EXTERNAL CERTIFICATION REQUIRED`→`EXTERNAL CERTIFICATION`) — a mechanical rename applied to
**all 733 rows** (134 rows had their label text changed by this rename alone), not a
re-assessment; it does not by itself move any row between categories.

**Count-based percentages, denominator stated:**
- `COMPLETE / 733` = **17.3%**.
- `(COMPLETE + PARTIAL) / 733` = **41.5%**.
- `VERIFIED-PASSING / 733` = **13.2%**.
No weighting, difficulty-adjustment, or subjective progress estimate is used anywhere in this report.

## 5. Domain rollups

Raw CSV `domain` values (41 distinct) were mapped onto the 10 requested rollups. The mapping is
disclosed here in full since several placements are judgment calls (e.g. `Finance & Treasury` →
POS/KDS as an operational/cash-session concern rather than a `Fiscal` one; `Critical Test
Scenarios` and `NFR Performance` → Production/Infrastructure as cross-cutting platform gates):

| Rollup | Raw domains folded in |
|---|---|
| Platform/Security | Security & Identity, Platform & Tenancy, API Platform, Audit & Governance, Business Rules — Platform, Project Constraints, Business Rules — Shared Kernel |
| Inventory | Inventory, Business Rules — Inventory |
| POS/KDS | POS / Sales, Kitchen Display, Catalogue & Recipes, Business Rules — POS, Business Rules — Menu, Finance & Treasury, Localisation, NFR Usability |
| Offline/Sync | Offline & Sync |
| Fiscal | Fiscal Country Packs, Business Rules — Finance |
| Costing/Procurement | Costing & Profitability, Procurement, Branch & Central Kitchen |
| Workforce | Workforce / HR |
| CRM/Loyalty | CRM & Loyalty |
| Observability | NFR Observability |
| Production/Infrastructure | DevOps & Operations, Data Architecture & DR, External Integrations, Integrations, NFR Performance, NFR Scalability, NFR Availability, NFR Reliability, NFR Maintainability, NFR Portability, NFR Capacity, NFR API, NFR Data, Quality Assurance, Critical Test Scenarios, Use Cases, Reporting & Analytics |

| Rollup | Total | COMPLETE | PARTIAL | NOT IMPL. | OUT OF SCOPE |
|---|---:|---:|---:|---:|---:|
| Platform/Security | 101 | 37 | 19 | 44 | 1 |
| Inventory | 53 | 14 | 39 | 0 | 0 |
| POS/KDS | 203 | 60 | 61 | 82 | 0 |
| Offline/Sync | 36 | 4 | 6 | 26 | 0 |
| Fiscal | 18 | 0 | 0 | 18 | 0 |
| Costing/Procurement | 94 | 0 | 18 | 76 | 0 |
| Workforce | 29 | 0 | 6 | 23 | 0 |
| CRM/Loyalty | 26 | 0 | 0 | 26 | 0 |
| Observability | 7 | 2 | 2 | 3 | 0 |
| Production/Infrastructure | 166 | 10 | 26 | 130 | 0 |
| **Total** | **733** | **127** | **177** | **428** | **1** |

Notable: **Inventory has zero NOT IMPLEMENTED rows** (0/53) — every Inventory requirement is at
least PARTIAL, reflecting four consecutive accepted slices (A1-1 through A1-4) on this domain.
**CRM/Loyalty and Fiscal are both 0% COMPLETE** (0/26 and 0/13 of their own domain-specific rows,
0/18 once Business Rules — Finance is folded in) — no lane touched either this cycle.

## 6. Pre-pilot, production, and full-SRS remaining

- **Pre-pilot blockers remaining: 16** (rows with `pilot_blocking = YES`): `BR-CORE-003`,
  `BR-INV-003`, `CT-05`, `FR-AUD-001`, `FR-AUD-005`, `FR-DR-002`, `FR-DR-020`, `FR-FIN-022`,
  `FR-OPS-001`, `FR-OPS-002`, `FR-PLT-013`, `FR-PLT-014`, `FR-POS-070`, `FR-POS-093`, `FR-QA-010`,
  `FR-SEC-046`. (`CT-08`, complete this session, was the 17th and is now correctly cleared.)
- **Production blockers remaining: 86.**
- **Full-SRS remaining: 605** requirements not yet COMPLETE-and-unblocking.

## 7. Top 20 remaining backend blockers, by dependency fan-out

Ranked by how many other requirements each single missing piece of infrastructure or capability
directly blocks, measured from the CSV (not subjective weighting):

1. **No scheduler/background-job infrastructure anywhere in the repository.** Directly blocks 15
   requirements measured this session: `BR-INV-003`, `FR-AUD-005`, `FR-DR-002`, `FR-HRM-013`,
   `FR-HRM-022`, `FR-HRM-023`, `FR-INV-011`, `FR-INV-051`, `FR-INV-067`, `FR-INV-069`, `FR-RPT-002`,
   `FR-RPT-040`, `FR-RPT-041`, `FR-SEC-061`, `IR-INT-030`. Highest fan-out single gap in the system.
2. **No POS/KDS client exists in this repository.** Blocks the entire client-side NFR-PERF cluster
   (`001`–`004`, `021`, `040`, `041`), the entire client-durability NFR-REL cluster (`001`–`003`),
   and `CT-01`/`CT-02`/`CT-04` — 13 requirements, none of which can even be attempted server-side.
3. **Offline `kds.ticket.recall` deregistered, blocked by missing persisted HLC watermark.** Blocks
   `CT-03` and caps `FR-OFF-040`/`043`/`045`–`047` below COMPLETE.
4. **Lossless recovery hard gate NOT CLOSED** (GD-D1-07, CANDIDATE/NOT RATIFIED; invariants #4/#7/#9
   not proven/failing). Blocks D4-1 FULL and any pilot claim involving revoked-terminal recovery.
5. **Fiscal Country Packs domain: 13/13 (18/18 with Business Rules — Finance) NOT IMPLEMENTED.** No
   tax-authority submission path, no `TaxDocument`, no outbox — blocks `CT-09` and every fiscal FR.
6. **CRM & Loyalty domain: 26/26 NOT IMPLEMENTED.** No loyalty domain exists at all — blocks
   `CT-13` and the entire CRM/Loyalty rollup.
7. **Costing & Profitability + Procurement: 76/94 NOT IMPLEMENTED** across both domains.
8. **Workforce/HR: 23/29 NOT IMPLEMENTED.**
9. **Zero CI/CD deployment automation** — `FR-OPS-001` (zero-downtime/rollback), `002` (canary),
   `003` (IaC), `004` (image signing/SBOM), `005` (feature flags) — 5 requirements, all NOT
   IMPLEMENTED, blocking any real production deployment story.
10. **7 unremediated high-severity dependency vulnerabilities** (measured this session, unchanged
    across every integration wave). The scanning gate now exists (G1-1) and would correctly fail a
    live CI run; the *outcome* target ("zero at release") is not met, capping `NFR-MAINT-005`
    below COMPLETE.
11. **No distributed tracing, business metrics, universal SLO alerting, or per-tenant support health
    surface** — `NFR-OBS-002`/`004`/`006`(partial)/`007`.
12. **No CI-executed, schema-generated cross-tenant RLS isolation suite** — `FR-PLT-013`/`014`; the
    literal mechanism the SRS names does not exist even though a different, real coverage gate does.
13. **No encryption at rest for the offline local database** — `FR-OFF-010`.
14. **No backup/DR rehearsal or quarterly restore drill** — `FR-DR-020`.
15. **No automated partition creation** — `FR-DR-002` (also counted under blocker #1).
16. **No multi-currency consolidated reporting, no split-bill, no loyalty ledger** — `CT-11`/`12`/`13`
    cannot be exercised end to end regardless of any single fix.
17. **`FR-SEC-028`: local-data wipe on terminal revocation not implemented** (the one downgrade this
    session) — a real gap in the revoked-terminal story, distinct from the recovery hard gate.
18. **No on-call rotation, incident classification, or public status page** — `FR-OPS-020`–`023`.
19. **`FR-AUD-001` (immutable audit entry for every state-changing operation) stays PARTIAL** —
    coverage is not universal across every state-changing operation in the system.
20. **`FR-SEC-046` (rate limiting + progressive lockout on auth endpoints) stays PARTIAL** — a
    pilot-blocking authentication-hardening gap independent of everything else on this list.

## 8. Migration count and persistent `ros`

Migration count: **38**, unchanged this session (audit/analysis only — no migration was authored,
applied, or measured live; the figure is carried from the MW1F integration session earlier in this
same conversation, where it was directly measured). Persistent `ros` (the separate git checkout at
`/Users/mac/projects/ros`) was not entered or modified. No product code, schema, migration, route,
permission, or governance decision was changed. No push, no deploy, no rebase, no destructive git.

## 9. Files

- `2026-09-03_FULL-SRS-current-head-traceability-rebase_02.md` — this report.
- `2026-09-03_FULL-SRS-current-head-traceability_02.csv` — the corrected 733-row CSV, with two
  trailing columns `delta_from_p0` (`CHANGED`/`UNCHANGED`) and `delta_reason` (empty for
  unchanged rows; a specific current-HEAD citation for every changed row).
- `2026-09-03_FULL-SRS-current-head-traceability-rebase.md` / `.csv` — the flawed first attempt,
  preserved untouched as the historical record; **superseded, do not use** (see §0).
- `2026-09-02_FULL-SRS-current-head-traceability-rebase.md` / `.csv` — the P0 baseline, untouched.
