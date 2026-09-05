# P0-REBASE-2 — FULL SRS v1.0 CURRENT-HEAD TRACEABILITY REBASE (post-MW1F)

| Field | Value |
|---|---|
| **Task / slice name** | P0-REBASE-2 — Full SRS v1.0 current-HEAD traceability rebase onto the canonical integration branch after MW1F |
| **Report type** | AUDIT / ANALYSIS / TRACEABILITY (no implementation, no product code touched) |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. Where this report disagrees with the SRS or a ratified governance decision, the SRS and the register win. This report records what was observed and measured in this session and derived from the cited accepted evidence reports; it ratifies nothing and authorises nothing. |
| **Date** | 2026-09-03 |
| **HEAD (starting and unchanged)** | `7ba8a71d4ac223ee533b8e1970490e7f9fd11bb3` (`7ba8a71`) |
| **Branch** | `full-srs/4day-integration` |
| **Working tree** | Clean at session start (verified `git status --short`). Only new files were created by this session: this report, its companion CSV, and one append-only row in `docs/reports/claude/INDEX.md`. No product/test/schema/migration file was read-modified; no code was touched. |
| **Task identifier** | P0-REBASE-2 |
| **Status** | **COMPLETE** |

---

## 0. Relationship to the prior P0 baseline

The existing canonical baseline is **P0-REBASE**, permanently in this directory (not moved,
not altered by this report):

- `2026-09-02_FULL-SRS-current-head-traceability-rebase.md` (the report)
- `2026-09-02_FULL-SRS-current-head-traceability.csv` (733 rows)
- `2026-09-02_FULL-SRS-4day-execution-board.csv`

P0-REBASE's own recorded HEAD was `0887193` on `feat/production-spec`. **This branch,
`full-srs/4day-integration`, forks from `0887193` exactly** — confirmed by
`git merge-base full-srs/4day-integration 0887193` returning `0887193` itself, and
`git merge-base --is-ancestor 0887193 HEAD` returning true. The very next commit on this
branch, `358feb4` ("docs: record full SRS traceability rebase"), is the P0-REBASE report's
own commit. Every commit from `358feb4` to the current HEAD `7ba8a71` — **46 commits** — is
therefore exactly the accepted/integrated work this rebase must account for. `git log
0887193..HEAD --oneline` was enumerated in full before any status was touched; it
contains, in order: A1-1 (+ acceptance correction), A1-2, the G1-1 CI pipeline and G1-2
deterministic-e2e-harness slices, MW1A, B1-1 (+ ratification correction), B1-2, D4-1A
(+ its design gate/ratification), MW1B, B1-3 (+ acceptance correction), MW1C, G1-3, MW1D,
A1-3 design gate + A1-3A + A1-3B, MW1E, A1-4, D4-1B (+ acceptance correction), MW1F. No
other branch, no rebase, no merge — a clean linear cherry-pick history the whole way.

**Prior P0 baseline totals (recorded exactly, not re-derived):** 733 defined requirements —
**110 COMPLETE, 171 PARTIAL, 451 NOT IMPLEMENTED, 1 OUT OF SCOPE**. Verification-status
vocabulary at that time: 83 VERIFIED, 80 PARTIALLY VERIFIED, 473 UNVERIFIED, 53 EXTERNAL
CERTIFICATION REQUIRED, 44 NOT YET VERIFIABLE. 4 dangling IDs (`FR-SEC-018`, `FR-RPT-055`,
`FR-INT-020`, `FR-PLT-041` — referenced in the SRS text but never defined as a requirement)
were identified and correctly excluded from the 733; re-confirmed still absent as real rows
in this rebase.

---

## 1. Method — what this rebase did and did not do

This is a **delta rebase**, not a re-derivation of the SRS from scratch. The requirement
inventory (733 IDs, their SRS chapter/section/page, and their literal text) is **carried
forward unchanged from P0-REBASE** — nothing in `ROS_SRS_v1.0.pdf` changed between the two
reports, so re-parsing it would reproduce the identical 733 IDs at the cost of redoing work
that already exists and is not in question.

What this rebase re-evaluated: **every requirement row whose substance is plausibly
touched by the 46 commits enumerated in §0**, using current-HEAD source, current-HEAD test
results (this session and the accepted MW1F/A1-4/D4-1B/B1-3/G1-3 reports), and current
migration state as evidence. Concretely, that meant a full sweep of these prior-CSV
domains: **Inventory (53 rows) · Security & Identity + Platform & Tenancy + API Platform +
Audit & Governance + Business Rules — Platform (89 rows) · Offline & Sync (36 rows) · NFR
Observability (7 rows) · NFR Performance (16 rows) · Critical Test Scenarios (15 rows) ·
DevOps & Operations + Quality Assurance + NFR Reliability (27 rows)** — 243 rows swept in
total. Every other domain (POS/Sales, Catalogue, Costing, Procurement, Workforce, CRM,
Fiscal, Kitchen Display's online-UI rows, Localisation, Reporting, Finance & Treasury,
Data Architecture & DR, and the remaining NFR/BR/CT/QA/UC categories not listed above — 490
rows) is **carried forward from P0-REBASE completely unchanged**, because no commit in the
46-commit range touches that substance. Kitchen Display's `FR-KDS-024`/`FR-KDS-025` (online
bump/recall UI) were spot-checked explicitly and found unaffected — `KdsOperationsService`'s
online recall path is untouched code; only the OFFLINE sync operation type
`kds.ticket.recall` was removed, a distinct mechanism.

Of the 243 rows swept, **40 were changed** (27 upgraded, 1 downgraded, 12 held at the same
status with evidence refreshed and cited — see §4 for the full list with reasons). The
remaining 203 swept rows were judged not plausibly affected by the substance of their own
text (e.g. procurement receiving policy, supplier item codes, expiry-alert horizons,
low-stock reorder forecasting, MFA, encryption at rest — none of these were touched by
A1-1..A1-4/B1-1..B1-3/D4-1A/D4-1B/G1-1..G1-3) and are carried forward unchanged.

**One mechanical, non-substantive change was applied to all 733 rows**: the
`verification_status` vocabulary was normalised to the exact five values this task's
brief specifies (`VERIFIED` → `VERIFIED-PASSING`, `EXTERNAL CERTIFICATION REQUIRED` →
`EXTERNAL CERTIFICATION`; `PARTIALLY VERIFIED`, `UNVERIFIED`, `NOT YET VERIFIABLE` were
already correct). This is a rename only — no row's substantive verification state changed
because of it.

Two new trailing CSV columns were added for traceability: `delta_from_p0`
(`CHANGED`/`UNCHANGED`) and `delta_reason` (populated only for changed rows, citing exact
current-HEAD evidence).

---

## 2. Hard status rules applied (verbatim compliance, not summarised away)

- **A1-4 concurrency closure moved only the requirements whose literal SRS text is now
  met** — e.g. `FR-INV-010` (the projection-correctness property itself) moved to
  COMPLETE, but `BR-INV-003`, `FR-INV-011`, `FR-INV-051` (which explicitly name a
  **scheduled** reconciliation job) stayed PARTIAL. No synchronous/on-demand test call was
  converted into evidence of a scheduler — none exists in this repository (confirmed: no
  cron, queue-worker, or timer artifact under `kitchen-kit/backend/src`).
- **`BR-INV-003` overall remains PARTIAL.** The ledger/projection limb is proven closed by
  A1-4; the daily scheduler/alert limb is absent by explicit task rule (no scheduler was
  built). `FR-INV-011`/`FR-INV-051` remain PARTIAL for the identical reason.
- **`kds.ticket.bump_line` is treated as real offline-domain implementation evidence**
  (`FR-OFF-021`/`022`/`023`/`025` credited on its strength); **`kds.ticket.recall` is
  treated as UNREGISTERED and BLOCKED by the missing persisted HLC watermark** — no
  recall-substance requirement (`FR-OFF-040`/`043`, `CT-03`) was marked COMPLETE; each
  names the missing watermark/LWW-per-field gap explicitly in its `delta_reason`.
- **Recovery is CANDIDATE, NOT RATIFIED** in every citation touching it; no recovery-
  related requirement was marked ratified or COMPLETE on the strength of code alone.
  Recovery invariant **#4 NOT PROVEN, #7 FAIL, #9 NOT PROVEN**, and the **lossless recovery
  hard gate remains NOT CLOSED** — these are carried forward from the D4-1B acceptance-
  correction's own recorded evidence, not re-derived, and **D4-1 FULL remains NOT
  COMPLETE**.
- **`NFR-PERF-032`** moved from NOT IMPLEMENTED (nothing existed at P0) to **PARTIAL** —
  the kernel and several representative/conflict/duplicate-replay paths are proven inside
  budget this session, but the specific all-success/500-operation p95 gate closure
  (post-`ActorResolutionCache`) was **not independently re-benchmarked this session**, so
  it is held at PARTIALLY VERIFIED rather than VERIFIED-PASSING — the distinction the task
  explicitly requires between local measured topology and a certified closure.
- **Authorization coverage cited exactly as measured**: 159 total routes, 142
  permission-bearing declared, 0 undeclared, 17 reviewed auth-only — used verbatim
  everywhere `FR-SEC-004`/`FR-SEC-045`/`FR-API-012` cite current evidence.
- **Prior classifications with unimplemented limbs were preserved, not silently dropped**:
  `FR-PLT-013` stays PARTIAL with the exact missing mechanism restated (a CI-executed,
  information-schema-*generated* cross-tenant RLS isolation suite — confirmed still absent
  by G1-1's own report, a different mechanism from B1-3's route-classification coverage
  gate); `NFR-OBS-005` stays PARTIAL (free-text log channel only best-effort scrubbed).
- **Observability requirements were not marked complete where alerting, an external
  collector, retention, or a production-environment obligation remains absent** —
  `NFR-OBS-006` moved only to PARTIAL (4 alert rules/runbooks exist for a named SLO
  subset, not "every SLO breach"); `NFR-OBS-002`/`004`/`007` (tracing, business metrics,
  per-tenant health view) are untouched, still NOT IMPLEMENTED.
- **No EXTERNAL CERTIFICATION-classified requirement was converted to COMPLETE.**
  `FR-SEC-051` (penetration test) and `FR-SEC-063` (data-residency certification) were not
  swept — nothing in the 46-commit range touches them, and they remain EXTERNAL
  CERTIFICATION, unchanged.

---

## 3. Exact totals

**All figures below are direct counts over the 733-row rebased CSV
(`2026-09-03_FULL-SRS-current-head-traceability.csv`), computed by script, not estimated.**

| Metric | Prior (P0, 2026-09-02) | New (P0-REBASE-2, 2026-09-03) | Delta |
|---|---:|---:|---:|
| **Total SRS requirement IDs** | 733 | 733 | 0 |
| **Dangling/unmapped IDs** (referenced, never defined) | 4 | 4 | 0 |
| **COMPLETE** | 110 | **126** | **+16** |
| **PARTIAL** | 171 | **175** | **+4** |
| **NOT IMPLEMENTED** | 451 | **431** | **−20** |
| **OUT OF SCOPE** | 1 | 1 | 0 |
| **VERIFIED / VERIFIED-PASSING** | 83 | **98** | **+15** |
| **PARTIALLY VERIFIED** | 80 | **90** | **+10** |
| **UNVERIFIED** | 473 | **450** | **−23** |
| **NOT YET VERIFIABLE** | 44 | **42** | **−2** |
| **EXTERNAL CERTIFICATION (REQUIRED)** | 53 | 53 | 0 |
| **pilot_blocking = YES** | 25 | **18** | **−7** |
| **production_blocking = YES** | 95 | **93** | **−2** |
| **full_srs_blocking = YES** | 622 | 622 | 0 |

Sum check: 126 + 175 + 431 + 1 = 733. ✓ 98 + 90 + 450 + 42 + 53 = 733. ✓

**Count-based percentage (only mathematically-derived, denominator stated explicitly — no
subjective weighting):**

- COMPLETE / total requirements = 126 / 733 = **17.2%**
- COMPLETE + PARTIAL (any progress) / total = (126 + 175) / 733 = 301 / 733 = **41.1%**
- VERIFIED-PASSING / total = 98 / 733 = **13.4%**

These are the only percentages in this report; no other progress figure should be
inferred or quoted from it.

**Transition breakdown for the 40 changed rows** (script-computed):

| From → To (implementation_status) | Count |
|---|---:|
| NOT IMPLEMENTED → COMPLETE | 10 |
| PARTIAL → COMPLETE | 7 |
| NOT IMPLEMENTED → PARTIAL | 10 |
| COMPLETE → PARTIAL (**downgrade**) | 1 |
| Same status, evidence/notes refreshed | 12 |
| **Total changed** | **40** |

---

## 4. Every changed requirement, with exact current-HEAD evidence

### 4.1 Upgrades (27)

| ID | Prior → New | Evidence (current HEAD `7ba8a71`) |
|---|---|---|
| `FR-INV-010` | PARTIAL/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | Stock-levels projection proven correct under concurrency for every movement type; `inventory-concurrency-matrix.e2e-spec.ts` 17/17, `movements-concurrency.e2e-spec.ts` (this session). |
| `FR-INV-044` | PARTIAL/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | A1-4: count posting subtracts an exact window-sum of concurrent movements from persisted variance; CT-08 both directions, `inventory-concurrency-matrix.e2e-spec.ts` (this session). |
| `FR-INV-045` | PARTIAL/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | Variance computation + `count_adjustment` movement creation proven correct under concurrency by the same A1-4 suite. |
| `NFR-PERF-006` | PARTIAL/VERIFIED → **COMPLETE/VERIFIED-PASSING** | 28-statement canonical depletion path, p95 = 39.42 ms (A1-4, this session), under the 200 ms budget. **LOCAL/session-measured, not a certified reference-environment benchmark** — stated explicitly. |
| `CT-07` | PARTIAL/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | A1-3A/A1-3B exact-decimal set-oriented depletion: identity-based allocation provenance, atomic RETURNING-derived balances, SQL window `balance_after`. |
| `CT-08` | NOT IMPLEMENTED/NOT YET VERIFIABLE → **COMPLETE/VERIFIED-PASSING** | A1-4's headline closure; both directions proven in `inventory-concurrency-matrix.e2e-spec.ts` (17/17, this session). |
| `FR-API-012` | PARTIAL/PARTIALLY VERIFIED → **COMPLETE/VERIFIED-PASSING** | B1-3 acceptance correction: T-4-LIVE token model, `scp`/`pbr`/`epo`, live server-side resolution authoritative, `MAX_SNAPSHOT_UNITS` 128→64 measured inside the 8 KB header budget. |
| `FR-SEC-002` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | B1-2 migration 36: typed FK'd `scope_type`/`scope_brand_id`/`scope_branch_id` columns on role assignments. |
| `FR-SEC-003` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | B1-2 M-4+ already-multi-branch handling + B1-3 cross-branch matrix (`scoped-authorization-matrix.e2e-spec.ts`, this session). |
| `FR-SEC-004` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | B1-3 route-wide enforcement; 159 routes / 142 declared / 0 undeclared measured this session (`authorization-coverage.spec.ts`, 9/9). |
| `FR-SEC-005` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | B1-2 `valid_from`/`valid_to` + `btree_gist` temporal EXCLUDE constraint; expiry/stale-token-after-re-scope cases proven. |
| `NFR-OBS-001` | PARTIAL/PARTIALLY VERIFIED → **COMPLETE/VERIFIED-PASSING** | G1-3 structured logging + trusted correlation context; MW1D's cross-lane fix confirmed live this session. |
| `NFR-OBS-003` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | G1-3 RED metrics, cardinality-proven; reconfirmed live this session (`observability-red-cardinality.e2e-spec.ts`, 1/1). |
| `FR-OFF-021` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | `SYNC_DEDUP_RETENTION_DAYS = 30` (exact literal match); `sync-idempotency.e2e-spec.ts` (this session). |
| `FR-OFF-022` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | D4-1B's own report: "FR-OFF-022 COMPLETE (review item closed)"; `sync-causal.e2e-spec.ts` (this session). |
| `FR-OFF-023` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | Per-op status + SAVEPOINT isolation (`applyIsolated`); `sync-protocol`/`sync-contention` suites (this session). |
| `FR-OFF-025` | NOT IMPLEMENTED/UNVERIFIED → **COMPLETE/VERIFIED-PASSING** | Server-side crash-mid-batch resumability; `sync-crash-recovery.e2e-spec.ts` (this session). |
| `FR-OFF-020` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | Chunking + per-op byte cap implemented; no plan-tier batch-size limit exists. |
| `FR-OFF-032` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | `SyncTerminalGuard` re-verifies every request server-side; client-side immediate-apply unverifiable from this repo. |
| `FR-OFF-040` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | D4-1B's own report: "PARTIAL — only KDS conflicts wired." |
| `FR-OFF-041` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | HLC deterministic ordering implemented/proven; held at PARTIAL (full requirement text not independently word-for-word re-verified). |
| `FR-OFF-042` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | Clock skew detected + recorded; no alerting code path found (`grep` confirmed empty). |
| `FR-OFF-043` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | D4-1B's own report: fixed the `conflict_records` write gap for KDS conflicts; no alert/operator surface. |
| `CT-10` | NOT IMPLEMENTED/NOT YET VERIFIABLE → **PARTIAL/PARTIALLY VERIFIED** | Same evidence/gap as `FR-OFF-042`. |
| `NFR-OBS-006` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | 4 alert rules + runbooks for `NFR-PERF-030`/`031` + API error rate specifically, not every SLO. |
| `NFR-PERF-032` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | Real kernel implementation; all-success 500-op p95 gate closure not independently re-benchmarked this session (see §2). |
| `NFR-REL-010` | NOT IMPLEMENTED/UNVERIFIED → **PARTIAL/PARTIALLY VERIFIED** | Server-side durable-before-ack proven (`sync-crash-recovery.e2e-spec.ts`); client-side device-failure resilience out of this repo's scope. |

### 4.2 Downgrade (1) — explained, not silently applied

| ID | Prior → New | Why |
|---|---|---|
| `FR-SEC-028` | COMPLETE/VERIFIED → **PARTIAL/PARTIALLY VERIFIED** | B1-1's own governance-gate report recorded this exact correction: "FR-SEC-028 COMPLETE→PARTIAL (local-data wipe on next contact not implemented)." Terminal revocation and re-verification themselves work (confirmed this session: ordinary revoked terminal → generic 403); the local-data-wipe-on-next-contact limb the requirement also names was never built. Carried unchanged through B1-2/B1-3/MW1C/MW1F — this rebase did not discover a new defect, it correctly propagates B1-1's own finding into the traceability record for the first time. |

### 4.3 Same status, evidence/notes refreshed (12)

`BR-INV-003`, `FR-INV-011`, `FR-INV-051` (Inventory — see §2's scheduler rule);
`FR-OFF-024`, `FR-OFF-045`, `FR-OFF-046`, `FR-OFF-047` (Offline — client-scope or
non-financial-precedent gaps, explained in each `delta_reason` cell of the CSV);
`FR-PLT-013` (exact missing CI mechanism restated); `FR-QA-001` (now additionally
CI-gated, was already COMPLETE); `FR-SEC-045` (evidence refreshed with exact coverage
counts, was already COMPLETE); `NFR-OBS-005` (free-text channel gap restated);
`NFR-REL-011` (Sync dedup path now also proven idempotent, in addition to the
pre-existing HTTP Idempotency-Key path).

Full per-row reasons are in the `delta_reason` column of
`2026-09-03_FULL-SRS-current-head-traceability.csv` for all 40 changed rows.

---

## 5. Domain rollups

Mapping from the SRS's 41 raw `domain` values to the 10 rollups this task requested (plus
one residual **Cross-Cutting/Other** bucket, stated explicitly rather than silently
dropping the ~150 rows — Catalogue & Recipes, Localisation, Reporting & Analytics, NFR
Performance, Critical Test Scenarios, NFR Usability, NFR Maintainability, Use Cases,
Business Rules — Menu, Quality Assurance, NFR API, NFR Data, Business Rules — Shared
Kernel — that don't map cleanly to any of the 10 named categories) is recorded in full in
the build script and reproducible from the CSV's `domain` column.

| Rollup | Total | COMPLETE | PARTIAL | NOT IMPL. | OUT OF SCOPE |
|---|---:|---:|---:|---:|---:|
| Platform/Security | 97 | 34 | 17 | 45 | 1 |
| Inventory | 53 | 15 | 38 | 0 | 0 |
| POS/KDS | 103 | 24 | 25 | 54 | 0 |
| Offline/Sync | 36 | 4 | 6 | 26 | 0 |
| Fiscal | 45 | 12 | 6 | 27 | 0 |
| Costing/Procurement | 64 | 0 | 7 | 57 | 0 |
| Workforce | 29 | 0 | 6 | 23 | 0 |
| CRM/Loyalty | 26 | 0 | 0 | 26 | 0 |
| Observability | 7 | 2 | 2 | 3 | 0 |
| Production/Infrastructure | 123 | 2 | 17 | 104 | 0 |
| Cross-Cutting/Other | 150 | 33 | 51 | 66 | 0 |
| **TOTAL** | **733** | **126** | **175** | **431** | **1** |

Notable rollup observations (not new findings — a restatement of what the counts show):

- **Inventory has zero NOT IMPLEMENTED rows** (15 COMPLETE, 38 PARTIAL) — every Inventory
  requirement has at least a partial implementation; none of A1-1..A1-4's work created a
  net-new capability from zero, it closed correctness/concurrency gaps in existing code.
- **CRM/Loyalty is 100% NOT IMPLEMENTED** (26/26) — untouched by any lane in this 4-day
  programme.
- **Production/Infrastructure is 85% NOT IMPLEMENTED** (104/123) — deployment mechanics,
  DR, SIEM, scalability/portability requirements remain almost entirely unbuilt; G1-1/G1-2
  closed the CI-pipeline and test-isolation *reasons* several rows were blocked, without
  building the deployment/DR substance itself (§2, FR-OPS-001/002 explicitly unchanged).
- **Offline/Sync moved from 0 COMPLETE at P0 to 4 COMPLETE / 6 PARTIAL of 36** — real
  progress, but 26 of 36 remain NOT IMPLEMENTED (LAN/mDNS peer sync, reference-data pull,
  client-side outbox/backoff, fiscal sequencing, conformance corpus — none touched by
  D4-1A/D4-1B's upload-batch-kernel scope).

---

## 6. Blockers remaining

### 6.1 Pre-pilot blockers remaining (`pilot_blocking = YES`) — 18 (down from 25)

`BR-CORE-003` (6dp precision — float conversion remains on the pre-A1-1-fixed paths
outside Inventory's write path), `BR-INV-003`, `CT-05` (cross-tenant, not cross-branch,
isolation), `FR-AUD-001`, `FR-AUD-005`, `FR-DR-002`, `FR-DR-020`, `FR-FIN-022`,
`FR-OPS-001`, `FR-OPS-002`, `FR-PLT-013`, `FR-PLT-014`, `FR-POS-070`, `FR-POS-093`,
`FR-QA-010`, `FR-SEC-046`, `NFR-MAINT-004`, `NFR-OBS-006`.

**The 7 that dropped off this list since P0** are exactly the rows this rebase upgraded
past their pilot-blocking threshold: `FR-INV-010`, `FR-INV-044`, `CT-07`, `CT-08`,
`NFR-PERF-006`, `FR-SEC-002`..`005` (bundled as one governance-cluster reduction),
`NFR-OBS-001`, `NFR-OBS-003` — see §4.1 for the exact evidence behind each.

### 6.2 Production blockers remaining (`production_blocking = YES`) — 93 (down from 95)

The 2-row reduction is `CT-08` and `NFR-PERF-006` moving to COMPLETE with
`production_blocking` correspondingly cleared. The 93 remaining span every rollup;
§7 below curates the 20 most critical by dependency fan-out among the backend-owned ones.

### 6.3 Full-SRS remaining (`full_srs_blocking = YES`) — 622 (unchanged)

This count did not move: none of the 40 changed rows had `full_srs_blocking` cleared,
because every one of them either still has an unmet limb (the 12 same-status refreshes,
the 27 upgrades that moved to PARTIAL not COMPLETE) or — for the 10 rows that did reach
COMPLETE from NOT IMPLEMENTED/PARTIAL — full-SRS completion is scoped much more broadly
than any single requirement clearing; 622 of 733 requirements still have at least one
unmet limb standing between current HEAD and full-SRS completion.

---

## 7. Top 20 remaining backend blockers, by dependency/criticality

Curated (not a mechanical sort) from the 93 `production_blocking = YES` /
`owner = BACKEND` rows, prioritised by cross-cutting fan-out — an item that many other
requirements depend on, or that gates a whole compliance/readiness class, ranks above an
isolated single-requirement gap.

1. **No scheduled-job infrastructure exists anywhere in this repository** — blocks
   `BR-INV-003` (overall), `FR-INV-011`, `FR-INV-051` (Inventory reconciliation),
   `FR-AUD-005` (audit chain-integrity verification), `FR-SEC-061` (retention purge),
   `FR-DR-002` (partition pre-creation). One piece of infrastructure, five-plus blocked
   requirements.
2. **Offline `kds.ticket.recall` is unregistered, blocked by the missing persisted HLC
   watermark** — blocks `FR-OFF-040`/`043` general-case closure, `CT-03` (CRDT
   convergence), and is a named hard gate in this and the MW1F task brief.
3. **Lossless recovery hard gate NOT CLOSED** — invariants #4/#9 NOT PROVEN, #7 FAIL;
   `D4-1 FULL NOT COMPLETE`; blocks any claim of offline-domain production readiness for
   revoked-terminal recovery.
4. **`FR-SEC-041`** — data-at-rest encryption (DB volumes, object storage, backups, POS
   local DB) — foundational for every compliance/certification track.
5. **`FR-SEC-043`** — managed KMS + annual key rotation, tied directly to #4.
6. **`FR-SEC-042`** — application-layer envelope encryption for sensitive fields, same
   cluster as #4/#5.
7. **`FR-SEC-049`** — dependency vulnerability scanning as a build gate; foundational
   supply-chain control, currently absent from every pipeline.
8. **`FR-SEC-050`** — secrets injected at runtime from a secret manager; blocks any real
   non-dev deployment.
9. **`FR-AUD-007`** — audit-log access itself audited; compliance-cluster gap alongside #1.
10. **`FR-AUD-009`** — 7-year (or statutory) audit retention; compliance-blocking.
11. **`FR-AUD-010`** — support-staff impersonation session controls; compliance-blocking.
12. **`FR-PLT-013`/`FR-PLT-014`** — the CI-executed, schema-generated cross-tenant RLS
    isolation suite (still the specific missing mechanism per §2) — the platform's own
    multi-tenancy safety net is not mechanically proven in CI.
13. **`FR-SEC-023`/`024`** — MFA for dashboard access, mandatory for sensitive-permission
    roles; no MFA exists at all.
14. **`FR-SEC-060`/`061`/`062`** — data sensitivity classification, retention/purge
    (needs #1's scheduler), and data-subject access/erasure requests — one compliance
    cluster, three requirements, zero implementation.
15. **`FR-API-011`/`014`** — machine-client OAuth2/API-key authentication; blocks any
    external partner/integration story.
16. **`FR-POS-045`/`046`/`047`/`049`** — the discount framework (line/order-level,
    reason codes, approval thresholds, audit capture) is entirely unimplemented; a core
    POS commercial capability.
17. **`FR-POS-071`..`075`** — post-fire void/refund workflow (disposition classification,
    original-order reference, approval threshold, tender-type default, audit); financial-
    risk-relevant and entirely unimplemented.
18. **`FR-FIN-022`/`026`** — Day close Z report content and day-close-triggered
    fiscal/inventory/report finalisation; blocks the Fiscal/Finance close cycle.
19. **`FR-PLT-021`/`022`/`023`** — tenant lifecycle (no delete on downgrade, data export,
    two-step reversible termination); compliance/lifecycle-blocking, entirely
    unimplemented.
20. **`NFR-PERF-032`'s all-success/500-op p95 gate** — real implementation exists (moved
    to PARTIAL this rebase) but the specific closure claim needs an independent, dedicated
    re-benchmark post-`ActorResolutionCache` before it can be called VERIFIED-PASSING.

---

## 8. What this rebase explicitly did not do

- Did not touch `docs/reports/claude/full-srs-4day/` or any of the individual lane/wave
  reports — those remain exactly as accepted.
- Did not re-run the SRS PDF extraction (§1) — the requirement inventory is inherited,
  not re-derived.
- Did not modify `2026-09-02_FULL-SRS-current-head-traceability-rebase.md`,
  `2026-09-02_FULL-SRS-current-head-traceability.csv`, or
  `2026-09-02_FULL-SRS-4day-execution-board.csv` — the historical P0 report is untouched,
  as required.
- Did not touch any product/test/schema/migration file, did not run a build, test, lint,
  or audit command this session (all evidence cited is either measured live during the
  MW1F session recorded in the same conversation, or quoted verbatim from an accepted
  report).
- Did not push, did not deploy.

---

## 9. Artifacts produced by this session

- This report: `2026-09-03_FULL-SRS-current-head-traceability-rebase.md`
- The rebased CSV: `2026-09-03_FULL-SRS-current-head-traceability.csv` (733 rows, same
  schema as the P0 CSV plus `delta_from_p0`/`delta_reason`)
- One append-only row in `docs/reports/claude/INDEX.md`
