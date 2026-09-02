# P0-REBASE — FULL SRS v1.0 CURRENT-HEAD TRACEABILITY REBASE + 4-DAY PARALLEL EXECUTION MAP

| Field | Value |
|---|---|
| **Task / slice name** | P0-REBASE — Full SRS v1.0 current-HEAD traceability rebase + 4-day parallel execution map |
| **Report type** | AUDIT / ANALYSIS / TRACEABILITY (no implementation) |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was observed and measured in this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. |
| **Date** | 2026-09-02 |
| **HEAD** | `088719307bbb173150cac7971705f15fc36b32e6` (`0887193`) |
| **Parent** | `ec616a0e44b679a83203e01d118cd813997d2170` (`ec616a0`) |
| **Branch** | `feat/production-spec` |
| **Working tree** | *(final post-audit state)* The 4 pre-existing untracked report files are preserved **byte-for-byte**. The **only tracked repository file modified by P0 is `docs/reports/claude/INDEX.md`, by one append-only report-index row**. The 3 P0 report/data artifacts were newly created. No product code, schema, migration, route, permission, test or governance file was touched. `git diff --check` clean. *(At the initial baseline observed in §2, before this audit wrote any artifact, there was no tracked modification.)* |
| **Task identifier** | P0-REBASE |
| **Status** | **COMPLETE** |

---

## 1. Executive status

The Internal MVP closure commit is verified exactly and is documentation-only. Against the
**full SRS v1.0**, the reconstructed baseline is:

**733 defined requirements** — **110 COMPLETE (15.0%)**, **171 PARTIAL (23.3%)**,
**451 NOT IMPLEMENTED (61.5%)**, **1 OUT OF SCOPE**.

Three findings dominate the plan and are stated up front because each contradicts something a
reader might otherwise assume:

1. **NFR-PERF-006 fails, and it fails structurally, not because of load.** Benchmarked live this
   session on an isolated scratch database with no competing workload: **p50 = 440.44 ms,
   p95 = 568.73 ms** against a **≤ 200 ms p95** target. The **fastest of twenty iterations was
   375.80 ms** — nearly twice the p95 budget. Variance is not the problem; the median path is
   2.2× over. The cause is round-trip count (≈ 1,050 sequential statements per 30-line
   completion), not contention. The lock-grouping optimization the brief proposes removes only
   ~16% of those statements and **cannot** reach the target alone (§11, §29).

2. **A silent, irreversible inventory-correctness defect exists on the non-completion write
   path**, and it is more dangerous than the latency finding. `MovementsService.post` —the write
   path for **transfers, stock counts, waste and adjustments**— reads `stock_levels`, computes
   `balanceAfter` in **IEEE-754 floating point**, and writes it back as an **absolute value with
   no lock**. Two concurrent movements on one `(item, location)` silently lose one of them, and
   `stock_levels` then diverges permanently from the ledger, violating **BR-INV-003**. The
   correct atomic pattern already exists in this codebase — `SaleDepletionService.writeAllocation`
   uses `ON CONFLICT DO UPDATE … RETURNING` — but was applied to only one of the two write paths
   (§12).

3. **Branch-scoped authorization does not exist and cannot be started without a governance
   action.** `MembershipRole` carries no scope column; `organisation/branch-scope.ts` asserts only
   that a branch is *visible under tenant RLS*, never that the caller is permitted on it. Any
   tenant user holding a permission can act on **every** branch in the tenant. Ratified decision
   **D-2 (CORE ONLY, 2026-08-17)** still defers this, so it is **BLOCKED on governance**, not on
   engineering (§14).

**Selected next implementation unit: `P1-PERF`, scoped as *Inventory movement write-path
correctness and performance*** — findings (1) and (2) unified, because they are the same surgery
on the same primitive. A design gate is required. Full reasoning and the rejected alternatives
are in §29.

**Do not read Internal-MVP completion as SRS progress.** Every carve-out the MVP took —
online-only, single-active-branch, non-fiscal receipt, two tenders, minimum reporting, no
procurement/HR/CRM/costing-analytics — is re-opened here and counted as outstanding.

---

## 2. Verified repository baseline

Executed first, before any analysis:

```
$ git rev-parse HEAD          088719307bbb173150cac7971705f15fc36b32e6   ✓ matches expected
$ git rev-parse HEAD^         ec616a0e44b679a83203e01d118cd813997d2170   ✓ matches expected
$ git branch --show-current   feat/production-spec
$ git show --stat HEAD        docs: record internal MVP completion
                              .../2026-09-01_INTERNAL-MVP-final-exit-gate.md | 960 +++
                              kitchen-kit/backend/docs/reports/claude/INDEX.md |   1 +
                              2 files changed, 961 insertions(+)             ✓ documentation-only
$ git status --short -uall    4 untracked files, all pre-existing report .md files
```

**HEAD is documentation-only, confirmed by file list, not assumed.** Product implementation state
at HEAD therefore equals its parent `ec616a0`. No other product change is present.

Remotes: `origin` → `OffBrand-org/kitchen-kit-backend.git`, `upstream` → `AhmedShantti/ros.git`.

Pre-existing untracked files, preserved untouched:

- `2026-08-26_MVP_current-state-and-next-slice.md`
- `2026-08-27_RENDER_empty-db-demo-provisioning-check.md`
- `2026-08-28_P1G1_cash-close-design-gate.md`
- `2026-08-28_POST-P1F2_MVP_next-slice-rebase.md`

---

## 3. SRS source-integrity findings

The requirement inventory was reconstructed **from scratch** from `ROS_SRS_v1.0.pdf`
(161 pages, LibreOffice 24.2, `ROS-SRS-001`) by per-page text extraction and grammar-based
identifier parsing. No previously quoted count was trusted.

### 3.1 SIG-01 — The document's own headline requirement count is wrong

Document Control (p. 1) states:

> Total Requirement Count — **612 functional, 148 non-functional**

Actually defined in the delivered file: **561 FR** and **74 NFR**.
The document overstates FR by **51** and NFR by **74** (NFR by exactly 2×). Neither figure is
reachable from the delivered content by any parsing rule. **Do not use 612/148 anywhere.**

### 3.2 SIG-02 — Four requirements are referenced but never defined

Confirmed by full-document reference/definition differencing. These are the *only* four; the
brief's suspected list was exactly right and also exhaustive.

| Dangling ID | Referenced at | Reference text |
|---|---|---|
| `FR-SEC-018` | p. ~12 (§3 traceability table) | *"Provide defensible internal … FR-AUD-001..026, FR-SEC-018"* |
| `FR-RPT-055` | p. ~14 | *"daily 'morning brief' summary (FR-RPT-055)"* |
| `FR-INT-020` | p. ~14 | *"Export mapping configuration (FR-INT-020) and the immutability …"* |
| `FR-PLT-041` | p. ~24 | *"… mandatory (FR-PLT-041)."* |

`FR-PLT-041` is the most consequential: the repository already cites it in source
(`treasury/day-close.service.ts:211`, `treasury/contract/events.ts:98`) as the authority for a
**transactional outbox** that the SRS never actually specifies. Slice **B2-3** carries this
forward as an explicit governance question, not as an implementation assumption.

The same table also references `FR-AUD-001..026`, but only **FR-AUD-001..010** are defined —
a range reference overshooting the defined set by 16 identifiers.

### 3.3 SIG-03 — Referenced chapters and appendices that are absent

| Referenced | Where | Present in the delivered PDF? |
|---|---|---|
| **Chapter 30 — Roadmap** | p. 3 (*"roadmap in Chapter 30 defines what ships in which phase"*) and p. 3 again | **NO** — the document ends at Chapter 29 |
| **Chapter 31 — Risk Register** | p. 3 (*"…Chapter 30 (Roadmap), and Chapter 31 (Risk Register) to evaluate the venture"*) | **NO** |
| **Appendix B — traceability matrix** | §28.1, cited as the verification mechanism for **FR-QA-002** | **NO** |
| **Appendix C — full permission catalogue** | §15.3 (*"the full catalogue is maintained in Appendix C"*) | **NO** |

**Consequences, stated rather than resolved:**

- **FR-QA-002** (*every FR traces to at least one automated test, verified by the matrix in
  Appendix B*) is **unsatisfiable as written** — its verification instrument does not exist.
  Classified `NOT IMPLEMENTED` with owner `GOVERNANCE/SPEC`, not charged to engineering.
- **FR-SEC-010/011/012** depend on a permission catalogue that is absent. The repository
  independently records the same gap in `identity/authz/permissions.constants.ts`:
  *"the SRS business permission catalog is not present in this repository."* The 40 permission
  codes now in the repo were derived from SRS prose, not from a catalogue.
- **No roadmap or risk register exists to defer work into.** The 4-day plan in this report is
  therefore constructed from dependency analysis alone.

None of these are counted as implementation gaps. Nothing was invented to fill them.

### 3.4 SIG-04 — Section §19.3 "Report Catalogue" defines no identifiers

FR-RPT is defined only in §19.2 (5), §19.4 (5) and §19.5 (8) = 18. The report catalogue in §19.3
is presented as an untagged table, so the individual reports it names carry no requirement IDs and
cannot be traced. `FR-RPT-055`'s dangling reference (SIG-02) is most plausibly a casualty of this.

### 3.5 Confirmed NOT to be defects

- **No duplicate ID definitions.** 733 distinct IDs, 733 first-definitions, zero collisions.
- **NFR restatement is consistent.** The `NFR-PERF-*` and `NFR-REL-*` identifiers are defined in
  their domain chapters (§8.9, §9.5, §11.9, §19.6, §21.10, §26.6) and *restated* in the Chapter 27
  summary tables. Every restatement was checked against its primary definition and agrees.
  The primary definition is used throughout this audit.
- **No malformed identifiers.** Four ID grammars are in use and all parse cleanly:
  `FR-XXX-nnn`, `NFR-XXX-nnn`, `IR-LOC-<CC>-nnn` (4-part), and bare `CR-nn`/`CT-nn`/`UC-XXX-nn`.
- **96 identifiers carry no `[M]`/`[S]`/`[C]` tag.** This is *by design*, not ambiguity: it is
  exactly the set defined in tables rather than prose (all 15 CT, all 8 CR, all 21 BR, all 6 UC,
  and 46 NFR table rows). All are treated as mandatory. Reported separately in §4 so the two
  populations are never silently merged.

---

## 4. Canonical requirement counts

### 4.1 Total

**733 defined requirements.** 737 distinct identifiers appear in the document; 4 are referenced
but never defined (SIG-02) and are excluded from every count below.

### 4.2 By type

| Type | Count |
|---|---:|
| FR (functional) | 561 |
| NFR (non-functional) | 74 |
| IR (interface) | 48 |
| BR (business rule) | 21 |
| CT (critical test scenario) | 15 |
| CR (project constraint) | 8 |
| UC (use case) | 6 |
| **Total** | **733** |

There is no separate `DR` requirement class — `FR-DR-*` is a sub-family of FR (Data Architecture),
defined in Chapter 25.

### 4.3 By priority — exactly as printed in the SRS

| Priority | Count |
|---|---:|
| `[M]` Must | 445 |
| `[S]` Should | 166 |
| `[C]` Could | 26 |
| Untagged (table-defined: CT, CR, BR, UC, 46 NFR rows) | 96 |
| **Total** | **733** |

The 96 untagged are treated as mandatory for gating purposes (the SRS itself calls CT scenarios
"release-blocking" and CR items "MUST"), which yields **468 effectively-mandatory** requirements
in the ledger's `priority` column. Both numbers are given so neither is mistaken for the other.

### 4.4 By requirement sub-family

| Family | n | Family | n | Family | n |
|---|---:|---|---:|---|---:|
| FR-POS | 76 | FR-BRN | 30 | FR-OPS | 15 |
| FR-INV | 50 | FR-HRM | 29 | CT | 15 |
| FR-SEC | 45 | FR-FIN | 27 | IR-LOC | 13 |
| FR-MNU | 38 | FR-CRM | 26 | FR-API | 12 |
| FR-OFF | 36 | FR-KDS | 23 | NFR-USA | 11 |
| IR-INT | 35 | FR-PLT | 21 | FR-AUD | 10 |
| FR-PRC | 33 | FR-LOC | 20 | FR-DR | 10 |
| FR-CST | 31 | FR-RPT | 18 | NFR-MAINT | 9 |
| NFR-PERF | 16 | NFR-SCALE | 8 | CR | 8 |
| NFR-OBS | 7 | NFR-REL | 7 | FR-INT | 6 |
| NFR-PORT | 6 | UC | 6 | BR-FIN | 5 |
| FR-QA | 5 | NFR-AVAIL | 5 | BR-CORE | 4 |
| BR-MNU | 4 | BR-POS | 4 | BR-INV | 3 |
| NFR-API | 2 | NFR-DATA | 2 | BR-PLT | 1 |
| NFR-CAP | 1 | | | | |

### 4.5 Implementation counts

| Status | Count | Share |
|---|---:|---:|
| COMPLETE | 110 | 15.0% |
| PARTIAL | 171 | 23.3% |
| DESIGNED ONLY | 0 | 0.0% |
| BLOCKED | 0 | 0.0% |
| NOT IMPLEMENTED | 451 | 61.5% |
| OUT OF SCOPE | 1 | 0.1% |

`DESIGNED ONLY` and `BLOCKED` are zero **by classification discipline**, not by accident: this
audit records governance/design blockage in the separate `can_start_now` / `blocking_reason`
columns rather than collapsing it into the implementation axis. **88 rows carry
`can_start_now = NO`.** The single `OUT OF SCOPE` row is `CR-06` (Phase 1 engineering team capped
at 9 engineers) — an organisational constraint, not software.

### 4.6 Verification counts

| Status | Count |
|---|---:|
| VERIFIED | 83 |
| PARTIALLY VERIFIED | 80 |
| UNVERIFIED | 473 |
| NOT YET VERIFIABLE | 44 |
| EXTERNAL CERTIFICATION REQUIRED | 53 |

A measurable NFR is never marked `VERIFIED` on code inspection alone. **NFR-PERF-006 is
`VERIFIED` and *fails*** — it was actually measured this session, and the measurement is the
verification. Verification status and pass/fail are different questions.

### 4.7 Production-readiness counts

| Status | Count |
|---|---:|
| READY | 82 |
| NOT READY | 565 |
| EXTERNAL BLOCKER | 53 |
| NOT APPLICABLE | 33 |

### 4.8 Ownership counts

| Owner | Count |
|---|---:|
| BACKEND | 508 |
| SHARED | 77 |
| INFRA/DEVOPS | 57 |
| EXTERNAL-PROVIDER | 53 |
| FRONTEND-EXTERNAL | 32 |
| GOVERNANCE/SPEC | 6 |
| UNKNOWN | 0 |

### 4.9 Blocker counts

| Gate | Blockers |
|---|---:|
| PRE-PILOT | **25** |
| PRODUCTION | **95** |
| FULL SRS v1.0 | **622** |

### 4.10 Source-integrity counts

| Category | Count |
|---|---:|
| Source-integrity gaps | **4** (SIG-01 … SIG-04) |
| Dangling / undefined references | **4** (`FR-INT-020`, `FR-PLT-041`, `FR-RPT-055`, `FR-SEC-018`) |
| Referenced-but-absent chapters/appendices | **4** (Ch. 30, Ch. 31, App. B, App. C) |
| Overshooting range references | **1** (`FR-AUD-001..026` vs 10 defined) |
| Duplicate ID definitions | **0** |
| Malformed identifiers | **0** |

### 4.11 Evidence basis — how each row was classified

| Basis | Rows | Meaning |
|---|---:|---|
| DIRECT | 251 | This exact requirement was inspected in source, schema, migration or test **this session** |
| MODULE | 256 | The owning module's file surface, route surface, tables and tests were inspected this session; the requirement was classified against that surface |
| DOMAIN | 226 | Whole-domain substrate absence was established this session (no model, no module, no route) |

This column is in the CSV so no reader has to guess how firm any given row is. See §30 for the
one place this granularity is genuinely too coarse.

---

## 5. Status vocabulary

Three axes, never collapsed. `implementation = COMPLETE ∧ verification = VERIFIED ∧
production_readiness = NOT READY` is a valid and frequently occurring combination.

**Axis 1 — Implementation:** `COMPLETE` · `PARTIAL` · `DESIGNED ONLY` · `BLOCKED` ·
`NOT IMPLEMENTED` · `OUT OF SCOPE`.
`OUT OF SCOPE` is used **only** where the SRS itself places the requirement outside scope.
`COMPLETE` is **not** granted because a table exists, a column exists, a governance decision
exists, a prior report says done, or neighbouring tests pass.

**Axis 2 — Verification:** `VERIFIED` · `PARTIALLY VERIFIED` · `UNVERIFIED` ·
`NOT YET VERIFIABLE` · `EXTERNAL CERTIFICATION REQUIRED`.

**Axis 3 — Production readiness:** `READY` · `NOT READY` · `EXTERNAL BLOCKER` ·
`NOT APPLICABLE`.

---

## 6. Current implementation summary

Independently inspected at HEAD — not read off prior reports.

| Surface | Measured this session |
|---|---:|
| Prisma models | 92 across 12 schemas |
| Migrations | 35, applied clean from zero on a fresh scratch DB |
| Tables with RLS ENABLE + FORCE | 84 of 92 |
| `CREATE POLICY` statements | 306 |
| HTTP operations (OpenAPI 3.1.0) | 152 across 112 paths |
| Business modules | 12 |
| Permission codes | 40 |
| Unit tests | **815 / 815 green, 60 suites** (run live) |
| Module-boundary tests | **45 / 45 green** (run live), 21 `KNOWN_DEVIATIONS` |
| e2e suites on disk | 64 |
| CI pipelines | **0** |
| ADRs | 8 |
| Governance decisions | 20 (14 explicitly RATIFIED, D-16 held OPEN by instruction) |

The 8 tables without RLS are all legitimately tenant-agnostic: `identity.users`,
`identity.credentials`, `identity.sessions`, `identity.password_reset_tokens`,
`identity.tenants`, `identity.permissions`, `inventory.uom`, `inventory.uom_conversions`.
**RLS coverage over tenant-scoped data is architecturally complete** — one of the strongest
results in this audit.

**Schemas that exist but are nearly empty**, which is where the SRS gap concentrates:

- `fiscal` — contains only `TaxClass`. **No `TaxDocument`, no fiscal outbox.**
- `sync` — contains only `IdempotencyKey`. **No oplog, no sync batch, no HLC.**
- `workforce` — contains only `Shift` and `OrderNumberBlock`.

**Domains with literally zero data substrate** (verified by exact and fuzzy model-name search):
Supplier, PurchaseOrder, Requisition, GoodsReceipt, SupplierInvoice, Customer, Loyalty,
Promotion, TaxDocument, Outbox, OperationLog, SyncBatch, Expense, Attendance, LeaveRequest,
BranchGroup, ApiKey, Webhook.

Two columns point at tables that do not exist: `stock_batches.supplier_id` and
`stock_batches.goods_receipt_id` are recorded UUIDs with no referent (forward-declared for
P10-PRC).

---

## 7. Domain matrix

| Domain | Total | COMPLETE | PARTIAL | NOT IMPL | OOS |
|---|---:|---:|---:|---:|---:|
| POS / Sales | 76 | 15 | 11 | 50 | 0 |
| Inventory | 50 | 10 | 40 | 0 | 0 |
| Security & Identity | 45 | 11 | 6 | 28 | 0 |
| Catalogue & Recipes | 38 | 17 | 18 | 3 | 0 |
| Offline & Sync | 36 | 0 | 0 | 36 | 0 |
| External Integrations | 35 | 0 | 0 | 35 | 0 |
| Procurement | 33 | 0 | 0 | 33 | 0 |
| Costing & Profitability | 31 | 0 | 7 | 24 | 0 |
| Branch & Central Kitchen | 30 | 0 | 11 | 19 | 0 |
| Workforce / HR | 29 | 0 | 6 | 23 | 0 |
| Finance & Treasury | 27 | 12 | 6 | 9 | 0 |
| CRM & Loyalty | 26 | 0 | 0 | 26 | 0 |
| Kitchen Display | 23 | 5 | 14 | 4 | 0 |
| Platform & Tenancy | 21 | 7 | 4 | 10 | 0 |
| Localisation | 20 | 7 | 11 | 2 | 0 |
| Reporting & Analytics | 18 | 1 | 0 | 17 | 0 |
| NFR Performance | 16 | 0 | 4 | 12 | 0 |
| Critical Test Scenarios | 15 | 0 | 4 | 11 | 0 |
| DevOps & Operations | 15 | 0 | 0 | 15 | 0 |
| Fiscal Country Packs | 13 | 0 | 0 | 13 | 0 |
| API Platform | 12 | 6 | 3 | 3 | 0 |
| NFR Usability | 11 | 0 | 0 | 11 | 0 |
| Audit & Governance | 10 | 3 | 2 | 5 | 0 |
| Data Architecture & DR | 10 | 2 | 4 | 4 | 0 |
| NFR Maintainability | 9 | 0 | 7 | 2 | 0 |
| NFR Scalability | 8 | 0 | 0 | 8 | 0 |
| Project Constraints | 8 | 2 | 2 | 3 | 1 |
| NFR Observability | 7 | 0 | 2 | 5 | 0 |
| NFR Reliability | 7 | 0 | 1 | 6 | 0 |
| Integrations | 6 | 0 | 0 | 6 | 0 |
| NFR Portability | 6 | 0 | 0 | 6 | 0 |
| Use Cases | 6 | 0 | 3 | 3 | 0 |
| Business Rules — Finance | 5 | 0 | 0 | 5 | 0 |
| Quality Assurance | 5 | 2 | 1 | 2 | 0 |
| NFR Availability | 5 | 0 | 0 | 5 | 0 |
| Business Rules — Shared Kernel | 4 | 2 | 2 | 0 | 0 |
| Business Rules — Menu | 4 | 0 | 1 | 3 | 0 |
| Business Rules — POS | 4 | 4 | 0 | 0 | 0 |
| Business Rules — Inventory | 3 | 2 | 1 | 0 | 0 |
| NFR API | 2 | 1 | 0 | 1 | 0 |
| NFR Data | 2 | 0 | 0 | 2 | 0 |
| Business Rules — Platform | 1 | 1 | 0 | 0 | 0 |
| NFR Capacity | 1 | 0 | 0 | 1 | 0 |
| **Total** | **733** | **110** | **171** | **451** | **1** |

**Read the Inventory row with care.** Its 0 `NOT IMPLEMENTED` is an artefact of section-level
classification granularity, not a claim that all 50 inventory requirements have code. Every
`§11.x` section contains *some* real implementation, so no section defaults to
`NOT IMPLEMENTED`; `PARTIAL` is the conservative choice that never overclaims. Treat the
Inventory `PARTIAL` count as an **upper bound on implementation**, and see §30 for the
remediation.

**Nine domains are at literally 0% COMPLETE**: Offline/Sync, External Integrations, Procurement,
Costing, Branch & Central Kitchen, Workforce/HR, CRM & Loyalty, DevOps & Operations, Fiscal
Country Packs. Together they account for **248 of the 733 requirements (33.8%)**.

---

## 8. Ownership matrix

| Owner | Total | COMPLETE | PARTIAL | NOT IMPL | OOS |
|---|---:|---:|---:|---:|---:|
| BACKEND | 508 | 106 | 148 | 254 | 0 |
| SHARED | 77 | 0 | 14 | 63 | 0 |
| INFRA/DEVOPS | 57 | 2 | 6 | 49 | 0 |
| EXTERNAL-PROVIDER | 53 | 0 | 0 | 53 | 0 |
| FRONTEND-EXTERNAL | 32 | 0 | 2 | 30 | 0 |
| GOVERNANCE/SPEC | 6 | 2 | 1 | 2 | 1 |

**The backend campaign owns 508 requirements outright and shares 77 more.**
The 32 `FRONTEND-EXTERNAL` rows carry **no backend implementation effort** and **no effort
estimate** — only a contract obligation, tracked in §9 and in slice `FE-1`.

A requirement was **never** classified `NOT IMPLEMENTED (backend)` merely because its client half
is externally owned. `FR-POS-080` (floor plan editor) is `FRONTEND-EXTERNAL`; the backend
obligation it implies — a table state machine — is tracked separately as slice `C2-5`.

---

## 9. Frontend integration dependency matrix

Backend obligations only. No frontend implementation is owned, scheduled or estimated here.

| Frontend surface | SRS requirements | Backend dependency | Backend status | Contract evidence | Missing backend contract | Shared integration test | FE owner | BE owner |
|---|---|---|---|---|---|---|---|---|
| POS login (password / PIN) | FR-SEC-020..022, FR-API-010, FR-API-013 | Auth + PIN + refresh rotation | **COMPLETE** | `POST /auth/login`, `/auth/pin`, `/auth/refresh`; OpenAPI 3.1 | none | token rotation + reuse revocation | External | Lane B |
| POS menu grid & search | FR-POS-010..012 | Catalogue read + Arabic normalisation | **PARTIAL** | catalogue read routes | **Arabic normalisation (أ إ آ ا → ا, ة→ه, ى→ي, tashkeel) is specified as a *system* behaviour and exists on neither side** | shared normalisation conformance vectors | External | Lane C |
| POS order capture | FR-POS-001..007, 013, 020..024, 035, 038 | Orders, lines, modifiers, fire | **PARTIAL** | 8 `/orders` routes | park/resume, seats, courses, combos, open price | order → fire → KDS chain | External | Lane C |
| POS payment | FR-POS-060..066 | Payment capture + idempotency | **PARTIAL** | `POST /orders/{day}/{id}/payments` | split tender, bill split, cash rounding, integrated terminal | idempotent retry under partition | External | Lane C |
| POS discounts / approvals | FR-POS-045..051, FR-SEC-030..032 | Approval runtime + terminal manager PIN | **NOT IMPLEMENTED** | approval runtime exists, unwired | **no discount API, no synchronous approval contract** (D-2, D-14) | approval round-trip | External | Lane C |
| POS voids / refunds | FR-POS-070..075 | Correction operations | **PARTIAL** (pre-fire only) | `DELETE .../lines/{lineId}` | post-fire void, cancel, refund | void → stock disposition | External | Lane C |
| POS floor plan | FR-POS-080..084, FR-RPT-033 | Table state machine | **NOT IMPLEMENTED** | `org.tables` registry only | table state, transfer/merge/split, live state feed | table lifecycle | External | Lane C |
| POS shift & cash | FR-POS-090..097 | Cash sessions | **COMPLETE** | 7 treasury routes + 2 day-close + 1 policy | X report (`FR-POS-093`) | open → movements → close | External | Lane C |
| Receipts & printing | FR-POS-100..106, CT-15 | Receipt payload | **PARTIAL** — non-fiscal JSON only | `GET /orders/{day}/{id}/receipt` | fiscal elements, templates, bilingual layout, ESC/POS payload, digital delivery | Arabic printer matrix | External | Lane C |
| KDS station display | FR-KDS-020..031, NFR-PERF-004 | Ticket projection + **realtime transport** | **PARTIAL** | 6 kitchen routes, `ticket-reader.service` | **no websocket/SSE anywhere — KDS is poll-only** | fire → display ≤ 1 s p95 | External | Lane D |
| KDS lifecycle | FR-KDS-024, 025, 029, 040 | Bump / bump-all / recall | **COMPLETE** for the implemented set | `kitchen.controller.ts` | cancellation command path | full lifecycle | External | Lane D |
| Dashboard reporting | FR-RPT-030..047 | Report catalogue | **NOT IMPLEMENTED** (1 report) | `GET .../daily-trading/{day}` | catalogue, drill-down, export, dashboards | — | External | Lane G |
| Offline operation | CR-01, all FR-OFF, CT-01 | **Entire sync protocol** | **NOT IMPLEMENTED** | none | **local IDs, HLC, oplog, batch envelope, ack, conflict classes — the client team is blocked on this contract today** | 72-hour offline | External | Lane D |
| Localisation / RTL | FR-LOC §22.1, CR-02, CR-07 | Bilingual payloads | **PARTIAL** | `ar`/`en` JSONB throughout | locale-aware error messages (`FR-API-002`) | RTL/bidi rendering | External | Lane C |

**The single most urgent frontend-facing backend obligation is `D1-1`, the offline/sync protocol
design gate.** The external client team cannot build local persistence, HLC or an oplog against a
contract that does not exist, and `CR-01` (72 hours offline) is a hard project constraint. It is
placed in Wave 1 for that reason and for no other.

---

## 10. NFR matrix

Every NFR group in Chapter 27 plus the domain-chapter NFR sections. For each measurable target:
the exact threshold, the reference condition, the measurement method required, and what actually
exists.

**SRS reference conditions (§27.1), quoted:** POS device — Android 11, 4 GB RAM, quad-core
1.8 GHz, 10-inch 1280×800. Network — 5 Mbps, 80 ms RTT. Tenant — 30 branches, 400 orders per
branch per day, 2,500 stock items, 800 menu items.

### 10.1 NFR-PERF (16)

| ID | Target | Reference condition | Measurement method required | Current evidence | Result |
|---|---|---|---|---|---|
| NFR-PERF-001 | ≤ 100 ms p95 item-add render | POS reference device | Client instrumentation | none — no client | **UNMEASURED** |
| NFR-PERF-002 | ≤ 800 / 1,500 ms p95 payment finalisation (offline/online) | POS device + network | Client + server timing | offline path absent | **UNMEASURED** |
| NFR-PERF-003 | ≤ 6 s POS cold start | POS device | Client instrumentation | none | **UNMEASURED** |
| NFR-PERF-004 | ≤ 1 s p95 fire → KDS display (LAN) | LAN | End-to-end timing | **no realtime transport exists** | **UNMEASURED** |
| NFR-PERF-005 | ≤ 500 ms p95 stock query, 3,000 items | Tenant reference | Server benchmark | route exists, never measured at scale | **UNMEASURED** |
| **NFR-PERF-006** | **≤ 200 ms p95** recipe expansion + depletion, 30-line order, **in-transaction** | Tenant reference | ≥ 20-iteration in-transaction benchmark | **MEASURED THIS SESSION: p50 440.44 ms, p95 568.73 ms, min 375.80 ms** | **FAIL (2.84×)** |
| NFR-PERF-010 | ≤ 2 s p95 standard report, 31 days, 1 branch | Tenant reference | Server benchmark | 1 report exists, unmeasured | **UNMEASURED** |
| NFR-PERF-011 | ≤ 5 s p95 consolidated, 100 branches, 31 days | Tenant reference | Server benchmark | no consolidated report | **UNMEASURED** |
| NFR-PERF-012 | ≤ 3 s p95 dashboard load | Reference | Client | no dashboard | **UNMEASURED** |
| NFR-PERF-020 | ≤ 5 min sync of 5,000 ops @ 2 Mbps | Reference network | Orchestrated sync test | no sync | **UNMEASURED** |
| NFR-PERF-021 | ≤ 50 ms p95 local order persistence | POS device | Client | no local store | **UNMEASURED** |
| NFR-PERF-030 | ≤ 200 ms p95 / 500 ms p99 API read | Reference | RED metrics per endpoint | **no metrics substrate** | **UNMEASURED** |
| NFR-PERF-031 | ≤ 400 ms p95 API write | Reference | RED metrics | no metrics | **UNMEASURED** |
| NFR-PERF-032 | ≤ 3 s p95 sync batch of 500 ops | Reference | Server benchmark | no sync endpoint | **UNMEASURED** |
| NFR-PERF-040 | ≤ 2.5 s LCP web dashboard | Browser | Web vitals | no dashboard | **UNMEASURED** |
| NFR-PERF-041 | ≤ 200 ms INP web dashboard | Browser | Web vitals | no dashboard | **UNMEASURED** |

**One of sixteen performance requirements has ever been measured. It fails.** The other fifteen
are unmeasurable today because the measurement substrate (§10.5 observability) does not exist.
This is why `G1-3` (observability baseline) is a Wave-1 item: **every** remaining performance
claim depends on it.

### 10.2 NFR-SCALE (8) — all `NOT IMPLEMENTED` / `UNVERIFIED`

Tenants/region ≥ 10,000 · branches/tenant ≥ 500 · concurrent terminals/region ≥ 50,000 ·
orders/sec/region ≥ 500 · menu items/brand ≥ 5,000 · stock items/tenant ≥ 20,000 ·
stateless horizontal scaling linear to ≥ 40 pods · read replicas addable without application
change. **No load testing has ever been run, and there is no deployment topology in the
repository to run it against.** `NFR-SCALE-008` is contradicted by present architecture:
a single connection pool with no replica routing (see `FR-PLT-016`).

### 10.3 NFR-AVAIL (5) and NFR-REL (7)

| ID | Target | Status |
|---|---|---|
| NFR-AVAIL-001 | ≥ 99.9% monthly uptime | NOT IMPLEMENTED — no HA topology, no uptime measurement |
| NFR-AVAIL-002 | ≥ 99.95% Enterprise | NOT IMPLEMENTED |
| NFR-AVAIL-003 | ≥ 99.99% POS sales availability *independent of cloud* | NOT IMPLEMENTED — requires offline (CR-01) |
| NFR-AVAIL-004 | Maintenance ≤ 4 h/month, ≥ 7 days notice | NOT IMPLEMENTED |
| NFR-AVAIL-005 | Zero-downtime deployment | NOT IMPLEMENTED — no deployment mechanism |
| NFR-REL-010 | Zero committed-sale loss under single-device failure | NOT IMPLEMENTED — requires local durability |
| NFR-REL-011 | Zero duplicate financial effect, by idempotency | **PARTIAL** — genuinely enforced on order create/fire/payment (`sync.idempotency_keys`, fingerprint + stored response, 409 on mismatch), proven by `sales-payment-concurrency` and `cash-movements-close-and-payment-concurrency`; **not** applied to every financially significant endpoint |
| NFR-REL-012 | ≥ 11 nines durability | NOT IMPLEMENTED — managed-storage guarantee, no storage configured |
| NFR-REL-013 | RPO ≤ 5 min / RTO ≤ 60 min | NOT IMPLEMENTED — no backup or restore mechanism at all |

`NFR-REL-011` is the strongest reliability result in the audit and is worth protecting through
every subsequent wave.

### 10.4 NFR-USA (11) — all `FRONTEND-EXTERNAL`

3-line order in ≤ 6 interactions · touch targets ≥ 48×48 dp · signup→first order ≤ 30 min ·
image-only operability · cashier productive in ≤ 30 min · KDS legible at 2 m on 21″ 1080p ·
WCAG 2.1 AA · contrast ≥ 4.5:1 / 3:1 · full keyboard navigation · destructive actions
confirmable/undoable · actionable error messages.

**No backend effort is assigned.** Two carry a real backend obligation:
`NFR-USA-010` needs an undo/compensating-entry contract (delivered by `C2-2`), and `NFR-USA-011`
needs actionable error semantics (`FR-API-001` ✓ **COMPLETE**, `FR-API-002` localisation
✗ **NOT IMPLEMENTED**).

### 10.5 NFR-MAINT (9)

| ID | Target | Status | Evidence |
|---|---|---|---|
| NFR-MAINT-001 | Domain-layer coverage ≥ 90% | **PARTIAL** | 815 unit tests green; **coverage never measured**, no threshold gate |
| NFR-MAINT-002 | Overall coverage ≥ 75% | **PARTIAL** | same |
| NFR-MAINT-003 | Cyclomatic complexity ≤ 10 | **NOT IMPLEMENTED** | no complexity rule in `eslint.config.mjs` |
| NFR-MAINT-004 | Zero module-boundary violations, **enforced in CI** | **PARTIAL** | `module-boundaries.spec.ts` **45/45 green live this session**, 21 `KNOWN_DEVIATIONS` — but **nothing enforces it**, because no CI exists |
| NFR-MAINT-005 | Zero critical/high dependency vulns at release | **NOT IMPLEMENTED** | no scanning of any kind |
| NFR-MAINT-006 | API docs generated from code, drift impossible | **PARTIAL** | `docs/api/openapi.json` is generated (3.1.0, 152 ops, 112 paths); `npm run openapi:check` exists but **nothing runs it automatically** |
| NFR-MAINT-007 | New engineer → first merged PR ≤ 5 days | **PARTIAL** | unmeasurable |
| NFR-MAINT-008 | Local env startup ≤ 10 min from clone | **PARTIAL** | `docker compose` + npm scripts make it plausible; never measured |
| NFR-MAINT-009 | ADR for every significant decision | **PARTIAL** | 8 ADRs (0001–0008) cover identity/tenancy/RLS/terminal/password/rate-limiting/audit/organisation; **later decisions migrated to the governance register instead of ADRs**, so the ADR series is stale rather than absent |

`NFR-MAINT-004` and `NFR-MAINT-006` are the clearest illustrations of the audit's central pattern:
**the artefact exists and passes; the enforcement does not.**

### 10.6 NFR-OBS (7)

| ID | Requirement | Status |
|---|---|---|
| NFR-OBS-001 | Structured JSON logs with tenant, branch, correlation, causation | **PARTIAL** — `correlationId`/`causationId` exist in the domain-event and audit substrate (`common/domain-events/`, `governance/audit/`) but application logs are **default Nest text logs**; no request-scoped structured logger |
| NFR-OBS-002 | Distributed tracing across API, workers, DB | **NOT IMPLEMENTED** — zero OpenTelemetry |
| NFR-OBS-003 | RED metrics per endpoint and handler | **NOT IMPLEMENTED** — zero metrics exporter |
| NFR-OBS-004 | Business metrics (orders/min, sync backlog, fiscal failures, offline terminals) | **NOT IMPLEMENTED** |
| NFR-OBS-005 | No PII/secrets in logs, redaction layer with allowlist | **PARTIAL** — `audit-hash.ts` `sanitizeMetadata` redacts audit metadata against a real pattern set; **there is no log redaction layer** |
| NFR-OBS-006 | Alerts for every SLO breach with runbooks | **NOT IMPLEMENTED** |
| NFR-OBS-007 | Per-tenant health view without DB access | **NOT IMPLEMENTED** |

### 10.7 NFR-PORT (6), NFR-API (2), NFR-CAP (1), NFR-DATA (2)

- `NFR-PORT-001..004` — client platform/browser/responsive support: **FRONTEND-EXTERNAL**.
- `NFR-PORT-005` — cloud portability: **NOT IMPLEMENTED**, no IaC to assess.
- `NFR-PORT-006` — ESC/POS printer matrix: **EXTERNAL-PROVIDER**, no printer path exists.
- `NFR-API-001` — OpenAPI 3.1 generated from code: **COMPLETE** (49-assertion e2e suite).
- `NFR-API-002` — 180-day deprecation notice: **NOT IMPLEMENTED**, no lifecycle metadata.
- `NFR-CAP-001` — local store ≥ 20,000 orders: **NOT IMPLEMENTED**, no local store.
- `NFR-DATA-001` — statutory retention of stock movements: **NOT IMPLEMENTED**.
- `NFR-DATA-002` — reporting data ≤ 15 min stale: **NOT IMPLEMENTED**, no aggregation pipeline.

---

## 11. NFR-PERF-006 finding

### 11.1 Exact SRS wording, read from the PDF

> **NFR-PERF-006 [M]** (§11.9, p. 76) — *"Recipe expansion and inventory depletion for a completed
> order of up to 30 lines SHALL complete within 200 ms at p95 and **SHALL execute within the
> order's transaction**."*

Restated in the §27.1 summary table as *"Recipe expansion + depletion, 30-line order — ≤ 200 ms
p95"*; the two agree. **The in-transaction clause is normative**: asynchronous offloading is not
an available remedy.

### 11.2 Are the historical measurements still applicable to current HEAD?

**Yes — proven, not assumed.** The depletion path was traced through `git log`:

```
$ git log --oneline -- src/modules/inventory/sale-depletion/ \
                       src/modules/production/costing/consumption-resolution.service.ts \
                       src/modules/inventory/movements/ src/modules/inventory/costing/
bfe7e69 feat: complete P1F-2 atomic order completion
2e21aeb feat: checkpoint ROS backend through P1E-5A
896b572 feat(production): implement production spec
```

The most recent commit touching any file on this path is `bfe7e69`. **Eleven commits have landed
since** (`9aa7a88` … `0887193`) and **not one touches the depletion path.** Both historical
figures were therefore taken against code identical to HEAD's.

### 11.3 Fresh measurement at current HEAD

Rather than choose between the two historical numbers, a third was taken under the conditions the
brief specifies: an isolated scratch database migrated from zero, no competing agents, no parallel
suite, no other e2e workload, 20 measured iterations.

```
Scratch DB: ros_p0rebase_1788307908   (created for this audit; 35/35 migrations clean from zero)
Persistent `ros` dev DB: NOT TOUCHED (verified 35 rows in _prisma_migrations, unchanged)

NFR-PERF-006: 30 lines, 20 iterations
  p50 = 440.44 ms
  p95 = 568.73 ms
  min = 375.80 ms
  max = 604.22 ms
  all = [604.2, 568.7, 531.6, 451.1, 471.8, 477.5, 509.5, 440.9, 404.8, 443.1,
         440.4, 413.4, 430.8, 442.6, 440.2, 419.8, 384.3, 383.4, 395.8, 375.8]
```

Fixture (unchanged from the accepted benchmark): 30 order lines, nested recipes at depth ≥ 2,
mixed costing methods (weighted-average, standard, FIFO), multi-batch FIFO items with ≥ 3 layers,
modifiers on alternating lines, each iteration in its own rolled-back transaction so every
iteration measures identical work from identical state.

### 11.4 All three measurements, not averaged and not cherry-picked

| Measurement | Commit context | p50 | p95 | vs 200 ms |
|---|---|---:|---:|---:|
| `2026-08-26_P1F2_order-completion.md` §C | `9aa7a88` | 1,195.31 ms | 2,120.14 ms | **10.6×** |
| `2026-09-01_INTERNAL-MVP-final-exit-gate.md` | `ec616a0` | 462.60 ms | 673.18 ms | **3.4×** |
| **This audit, isolated scratch DB** | **`0887193`** | **440.44 ms** | **568.73 ms** | **2.84×** |

The spread across runs is machine contention. The classification does not depend on which is
used: **all three fail, and the cleanest run fails by the smallest margin — 2.84×.**

**The decisive observation is the minimum, not the p95.** The fastest of twenty iterations under
ideal isolation was **375.80 ms**. No amount of variance reduction, warm-up exclusion, tuning or
quieter hardware can bring a path whose *best case* is 1.88× the p95 budget under 200 ms. The
requirement cannot be met without changing what the code does.

### 11.5 Root cause — counted, not guessed

The cost is **round-trip count**, not lock contention. Reading
`sale-depletion.service.ts` and `writeAllocation` directly, the work per
`(orderLine, stockItem)` triple is:

1. `INSERT … sale_depletion_effects … ON CONFLICT DO NOTHING RETURNING` — identity reservation
2. `lockLayers` — `SELECT … FOR UPDATE`, **re-acquired per triple**, not per distinct stock item
3. one `UPDATE stock_batches` per physical slice
4. weighted-average: one `SELECT` for current average cost; FIFO: one `UPDATE` per cost slice
5. **per allocation, four statements**: atomic `stock_levels` delta → `stockMovement.create` →
   `stockLevel.update` pointer → `INSERT sale_depletion_allocations`

For the benchmark fixture — 30 lines × 4 components, plus a modifier component on 15 of them =
**135 triples** — this is approximately **1,050 sequential statements inside one transaction**.
At 440 ms that is ≈ **0.42 ms per statement**, which is exactly what a local round trip costs.
The arithmetic closes; there is no unexplained time.

The four-statement discipline is **not a defect** — it is the controlling design's deliberate
protection of `BR-INV-003`'s truthful per-movement `balance_after`
(`2026-08-25_P1F2E-A_inventory-acceptance-correction.md`). It is correct and expensive.

### 11.6 Classification

| Axis | Value |
|---|---|
| Implementation | **PARTIAL** |
| Verification | **VERIFIED** — measured this session under the mandated conditions |
| Production readiness | **NOT READY** |
| Pilot blocking | **YES** |
| Production blocking | **NO** (subsumed by the pilot gate) |
| Full-SRS blocking | **YES** |

### 11.7 Is it the highest-priority pre-pilot blocker?

**No — and this was tested rather than assumed.** It is the *second*. A 440 ms completion is
slow; it is not wrong. The inventory write-path defect in §12 silently corrupts the ledger, is
irreversible, and lives in the same code region. See §29 for the full comparison against branch
authorization and CI determinism.

---

## 12. Concurrency / correctness gaps

### 12.1 CG-01 — Lost update in `MovementsService.post` — **the most serious finding in this audit**

**Where:** `src/modules/inventory/movements/movements.service.ts:119-232`
**Write path affected:** transfers, stock counts, waste, adjustments, receipts — **everything
except sale depletion**. Callers: `transfers.service.ts` (×3), `counts.service.ts`,
`waste.service.ts`, and `POST /inventory/movements` directly.

```ts
const level = await tx.stockLevel.findUnique({ where: { stockItemId_locationId: {...} } });  // :119
const currentQty = level ? Number(level.quantityOnHand) : 0;                                 // :127
...
const balanceAfter = currentQty + input.quantity;                                            // :177
...
await tx.stockLevel.upsert({ ..., update: { quantityOnHand: balanceAfter, ... } });           // :208-225
```

**Two independent defects in six lines:**

**(a) Lost update.** This is read-then-**absolute**-write. There is **no `FOR UPDATE` on
`stock_levels` anywhere in the repository** (verified by exhaustive search). Two concurrent
movements on one `(item, location)` both read `currentQty`, both compute from it, both write an
absolute value — one movement's effect vanishes. `stock_levels` then diverges permanently from
`stock_movements`, violating **BR-INV-003** (*"the sum of all movements for an (item, location)
pair SHALL equal the stock_levels projection"*). The divergence is silent: no error, no
constraint, no alert.

A `lockLayers` `FOR UPDATE` does incidentally serialize *some* races — but only when
`outbound && item.isBatchTracked`. **Inbound receipts, transfer-ins, positive count adjustments,
and every non-batch-tracked item take no lock at all.**

**(b) Float arithmetic on quantities.** `Number(level.quantityOnHand)` and
`currentQty + input.quantity` convert `NUMERIC(18,6)` to IEEE-754 double. `PostMovementInput.quantity`
is typed `number`. **BR-CORE-003** requires 6 decimal places of precision. Error accumulates into
`stock_levels.quantity_on_hand` **and** into the ledger's own `stock_movements.balance_after`, so
even a corrective re-fold would be computed from polluted values.

**The correct pattern already exists in this codebase.** `SaleDepletionService.writeAllocation`
does exactly the right thing:

```sql
INSERT INTO "inventory"."stock_levels" (...) VALUES (...)
ON CONFLICT ("stock_item_id","location_id") DO UPDATE
  SET "quantity_on_hand" = "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
RETURNING "quantity_on_hand"::text
```

Atomic additive delta, `balance_after` **derived from the returned value** rather than guessed.
It was applied to one of the two write paths and not the other.

**Test coverage:** `order-completion-concurrency.e2e-spec.ts` and `-2` cover the *completion*
path with real barriers. **No concurrency test exists for `MovementsService.post` at all.** The
defect is invisible to the current suite, which is why it survived the MVP exit gate.

**This was flagged as a residual risk in a prior accepted report and confirmed still present at
HEAD in this session.**

### 12.2 CG-02 — `BR-INV-003` has no reconciliation job

The rule requires *"a reconciliation job SHALL verify this daily and raise an alert on any
divergence."* `GET /inventory/reconciliation` exists as an **on-demand** endpoint. There is no
scheduler, no daily execution, no alert sink. The one mechanism that would *detect* CG-01 in
production is not running. **PARTIAL.**

### 12.3 Races that ARE covered (do not re-do this work)

- Two settling payments on one order/version → exactly one winner completes
  (`order-completion-concurrency`).
- Two orders racing one FIFO batch → deterministic serial-equivalent result on both the physical
  and cost axes, no double consumption (`order-completion-concurrency-2`).
- Concurrent fire on one order (`sales-fire-concurrency`).
- Concurrent payment capture (`sales-payment-concurrency`).
- Cash movement vs session close vs payment (`cash-movements-close-and-payment-concurrency`).
- Day-close Z-number allocation (`day-close-znumber-concurrency`).
- Day-close cutover race (`day-close-cutover-race`).
- KDS ticket concurrency (`kds-concurrency`, `kitchen-ticket-concurrency`).

### 12.4 Races NOT covered

| Race | Risk | Slice |
|---|---|---|
| Two `MovementsService.post` on one `(item, location)` | **Lost update — CG-01** | A1-1 |
| Transfer-out vs concurrent sale depletion | Divergent projection | A1-4 |
| Count post vs concurrent sale (**CT-08**) | Variance includes concurrent sales | A1-4 |
| Waste record vs concurrent sale | Lost update | A1-4 |
| Two concurrent receipts on one item | Lost update + wrong weighted average | A1-4 |
| Deadlock inversion between the completion path and `MovementsService.post` | Both take `lockLayers` in the same order — plausible but **unproven** | A1-4 |

### 12.5 Lock-ordering guarantees that hold today

`fifo-cost-ledger.lockLayers` takes `ORDER BY created_at, id FOR UPDATE` with **no `SKIP LOCKED`**,
and a global `(stock_item_id, location_id)` ordering. `MovementsService.post` was deliberately
routed through the same kernel so both paths take compatible locks in the same order. That is
sound and must be **preserved**, not replaced, by A1-1/A1-3.

### 12.6 Constraint on any performance remedy

Do not collapse allocations into a single final projection delta. Intermediate
`stock_movements.balance_after` values must remain individually truthful. §29.6 shows how to get
the round-trip reduction **without** violating this.

---

## 13. QA — CT-01 … CT-15 matrix

The SRS states these are **release-blocking**: *"Failure of any prevents release regardless of
other results."*

| CT | Scenario (SRS §28.3) | Pass criterion | Required for release | Substrate implemented? | Test exists? | Passes? | Blocked by | FE/Shared dep | External dep | Owner | Earliest wave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **CT-01** | 72-hour full offline, 500 orders, then sync | Zero loss, zero duplication, fiscal sequence intact | YES | **NO** | NO | NO | entire offline domain + fiscal | YES | 72 h elapsed time | SHARED | 4 |
| **CT-02** | Network partition mid-payment on integrated terminal | No double charge; last-transaction query resolves | YES | **NO** | NO | NO | no integrated terminal | YES | payment provider | SHARED | 4 |
| **CT-03** | Concurrent order edits on one table from two terminals | Converges per CRDT rules; no line lost | YES | **NO** | NO | NO | no CRDT/convergence | YES | — | SHARED | 4 |
| **CT-04** | Power loss during payment write | Order recoverable; no partial state | YES | **NO** | NO | NO | no local durable write | YES | — | SHARED | 4 |
| **CT-05** | Cross-tenant access attempt **on every table** | All attempts return zero rows | YES | **PARTIAL** | YES (6 suites) | **for implemented modules** | not "every table", not schema-generated, **no CI** | NO | — | BACKEND | 1 |
| **CT-06** | Client/server conformance corpus | Byte-identical on every case | YES | **NO** | tax only | NO | no client runtime | YES | — | SHARED | 4 |
| **CT-07** | Recipe expansion, 5-level sub-recipes + modifiers | Depletion matches manual calculation exactly | YES | **YES** | YES (depth 2) | **partially** | needs a genuine 5-level fixture | NO | — | BACKEND | 1 |
| **CT-08** | Stock count during active trading | Variance excludes concurrent sales | YES | **PARTIAL** | NO | NO | **CG-01 makes this actively unsafe** | NO | — | BACKEND | 1 |
| **CT-09** | Fiscal submission, authority down 6 h | All submitted on recovery; nothing lost | YES | **NO** | NO | NO | no TaxDocument, no outbox | NO | authority sandbox | BACKEND | 3 |
| **CT-10** | Device clock 3 hours ahead | HLC ordering preserved; skew alerted | YES | **NO** | NO | NO | no HLC | YES | — | SHARED | 4 |
| **CT-11** | Multi-currency consolidated report | Rates displayed; totals reconcile | YES | **PARTIAL** | single-currency only | NO | no consolidated report, no FX | NO | rate source | BACKEND | 3 |
| **CT-12** | Money allocation across split bills | Sum of parts exactly equals whole | YES | **PARTIAL** | `Money.allocate` unit-tested exact | **not end-to-end** | no bill splitting | NO | — | BACKEND | 2 |
| **CT-13** | Loyalty double-redemption from two offline terminals | Detected on sync; ledger consistent | YES | **NO** | NO | NO | no loyalty, no sync | YES | — | BACKEND | 4 |
| **CT-14** | Sync backlog of 20,000 operations | Completes; no timeout; no memory exhaustion | YES | **NO** | NO | NO | no sync | YES | — | SHARED | 4 |
| **CT-15** | Arabic receipt printing across the printer matrix | Correct joining, ordering, no truncation | YES | **NO** | payload only | NO | no printer path | YES | printer hardware | SHARED | 3 |

**Score: 0 of 15 pass. 4 are partially reachable (CT-05, CT-07, CT-11, CT-12). 11 have no
substrate at all.**

**No release-blocking CT is recorded as satisfied on the strength of a narrower happy-path E2E.**
CT-07 is the case that most invites that error: `order-completion.e2e-spec.ts` does exercise
nested sub-recipes with modifiers and passes — but at **depth 2**, where the SRS names **five
levels** and demands agreement with a manual calculation. Recorded **PARTIAL**.

**CT-01 needs 72 hours of wall-clock time.** In a 4-day programme it must be started before the
final gate, not at it.

### 13.1 Other QA requirements

| ID | Status | Note |
|---|---|---|
| FR-QA-001 | **COMPLETE** | 60 unit suites, no DB/HTTP/framework; 815/815 green live |
| FR-QA-002 | **NOT IMPLEMENTED** | **Unsatisfiable as written** — Appendix B does not exist (SIG-03) |
| FR-QA-010 | **NOT IMPLEMENTED** | No reproducible seed datasets; every suite hand-builds fixtures — a direct cause of §14.2 |
| FR-QA-011 | **COMPLETE** | All test data synthetic |
| FR-QA-012 | **PARTIAL** | Perf fixture generated, but single-order, not production scale |

### 13.2 Quality gates (§28.5)

The SRS defines 9 merge-blocking and 4 release-blocking gates. **Zero are enforced** — there is
no CI. Every gate is `NOT IMPLEMENTED` for the same single reason.

---

## 14. Security production gate

Classification per the brief: `INTERNAL-MVP ACCEPTABLE` · `PILOT BLOCKER` · `PRODUCTION BLOCKER` ·
`FULL-SRS ONLY` · `EXTERNAL DEPENDENCY`.

| Control | Requirements | Current state | Classification |
|---|---|---|---|
| **Branch-scoped authorization** | FR-SEC-002/003/004/005, FR-API-012 | **NOT IMPLEMENTED.** `MembershipRole` has no scope column; `branch-scope.ts` asserts tenant-RLS visibility only. Any tenant user with a permission can act on every branch. | **PILOT BLOCKER** — governance-blocked by ratified D-2 |
| RBAC core | FR-SEC-001, FR-SEC-011, FR-SEC-045 | **COMPLETE** — roles, permissions, `PermissionGuard` server-side on every business route | INTERNAL-MVP ACCEPTABLE |
| Standard role catalogue | FR-SEC-010/012 | **NOT IMPLEMENTED** — no seeded roles; SRS Appendix C absent (SIG-03) | PRODUCTION BLOCKER |
| **MFA** | FR-SEC-023/024 | **NOT IMPLEMENTED** — zero MFA/TOTP/WebAuthn code | **PRODUCTION BLOCKER** |
| **Segregation of duties** | FR-SEC-015/016/017 | **NOT IMPLEMENTED** — no incompatible-pair catalogue, no block, no report. Self-approval prevention exists *only* inside governance approvals (D-7 RLS traversal), which is narrower than SoD. | **PRODUCTION BLOCKER** |
| Approval workflow | FR-SEC-030..035 | **PARTIAL** — runtime exists (`ApprovalRequest`/`ApprovalDecision`, append-only per D-8) but is **wired to no business action** and has **no HTTP surface** (D-14 ratified A-1). FR-SEC-032 knowingly unmet per D-2. | PRODUCTION BLOCKER |
| Password auth | FR-SEC-025 | **PARTIAL** — Argon2id + policy enforced; **not tenant-configurable**, **no breached-password check** | PRODUCTION BLOCKER |
| PIN auth | FR-SEC-021/022 | **COMPLETE** — registered-terminal + permitted-branch, no dashboard grant, salted hash, per-branch uniqueness, configurable-threshold lockout | INTERNAL-MVP ACCEPTABLE |
| Refresh rotation & reuse detection | FR-API-010/013 | **COMPLETE** — reuse revokes the whole token family | INTERNAL-MVP ACCEPTABLE |
| Terminal registration/revocation | FR-SEC-028 | **COMPLETE** — 6 routes + device fingerprints | INTERNAL-MVP ACCEPTABLE |
| Session expiry / forced logout | FR-SEC-026/027 | **PARTIAL** — global TTLs only; no per-surface idle expiry, no admin force-logout-all | PRODUCTION BLOCKER |
| **Progressive lockout** | FR-SEC-046 | **PARTIAL** — `AuthThrottlerGuard` keys by **IP + account** (a genuinely good design: neither an account nor an IP alone can be hammered) and PIN lockout is real; but lockout is **not progressive** and password login has no account lockout | **PILOT BLOCKER** |
| **Per-tenant rate limits** | FR-PLT-015 | **NOT IMPLEMENTED** — auth endpoints only; none on API, reports or exports | PRODUCTION BLOCKER |
| **Encryption at rest** | FR-SEC-041 | **NOT IMPLEMENTED** | PRODUCTION BLOCKER / EXTERNAL DEPENDENCY |
| **Application field encryption** | FR-SEC-042 | **NOT IMPLEMENTED** — zero cipher code | PRODUCTION BLOCKER |
| **KMS / tenant keys** | FR-SEC-043 | **NOT IMPLEMENTED** | PRODUCTION BLOCKER / EXTERNAL DEPENDENCY |
| Secrets management | FR-SEC-050 | **NOT IMPLEMENTED** — `.env` + `secrets/` dir; no secret manager | PRODUCTION BLOCKER |
| Dependency scanning | FR-SEC-049, NFR-MAINT-005 | **NOT IMPLEMENTED** — no CI to host it | PRODUCTION BLOCKER |
| Secret scanning | §28.5 gate | **NOT IMPLEMENTED** | PRODUCTION BLOCKER |
| API keys / machine clients | FR-API-011/014 | **NOT IMPLEMENTED** — no `ApiKey` model | PRODUCTION BLOCKER |
| Card data prohibition | FR-SEC-044, FR-POS-066, CR-05 | **COMPLETE** — no PAN/CVV/track column exists anywhere; tenders limited to `cash` / `manual_external_card` | INTERNAL-MVP ACCEPTABLE |
| Input validation | FR-SEC-047 | **COMPLETE** — global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` | INTERNAL-MVP ACCEPTABLE |
| Parameterised queries | FR-SEC-048 | **COMPLETE** in fact (Prisma + tagged-template raw only) but **NOT enforced by static analysis** | INTERNAL-MVP ACCEPTABLE |
| Privacy / classification / DSAR | FR-SEC-060/062 | **NOT IMPLEMENTED** | PRODUCTION BLOCKER |
| Data retention purge | FR-SEC-061, FR-AUD-009, NFR-DATA-001, CR-08 | **NOT IMPLEMENTED** — no purge job; **CR-08's 7-year audit retention is unenforced** | PRODUCTION BLOCKER |
| Data residency | FR-SEC-063 | **NOT IMPLEMENTED** | PRODUCTION BLOCKER / EXTERNAL DEPENDENCY |
| **Support impersonation capture** | FR-AUD-010 | **NOT IMPLEMENTED** — zero impersonation code | PRODUCTION BLOCKER |
| Audit write + hash chain | FR-AUD-002/003/004 | **COMPLETE** — per-tenant chain serialized by `pg_advisory_xact_lock`; `ros_app` holds `SELECT, INSERT` with `UPDATE, DELETE, TRUNCATE` revoked | INTERNAL-MVP ACCEPTABLE |
| Audit coverage | FR-AUD-001/006 | **PARTIAL** — named actions audited; **not proven exhaustive** over every state-changing operation | PILOT BLOCKER |
| Audit query / export / access audit | FR-AUD-007/008 | **NOT IMPLEMENTED** — no read surface at all | PRODUCTION BLOCKER |
| Audit chain verification job | FR-AUD-005 | **NOT IMPLEMENTED** — verifier exists, **scheduler does not** | PILOT BLOCKER |
| **Tenant isolation / RLS** | FR-PLT-010/011/012 | **COMPLETE** — 84/92 tables ENABLE+FORCE, 306 policies, `ros_app` is `NOBYPASSRLS`, fail-closed tenant context. The 8 exempt tables are all tenant-agnostic. | INTERNAL-MVP ACCEPTABLE |
| Isolation test enforcement | FR-PLT-013/014, CT-05 | **PARTIAL / NOT IMPLEMENTED** — suites are hand-written, not schema-generated, and **nothing runs them** | PILOT BLOCKER |
| TLS 1.3 | FR-SEC-040 | **NOT IMPLEMENTED** in repo (deployment-owned, unevidenced) | PRODUCTION BLOCKER |
| IP allow-listing / SIEM | FR-SEC-052/053 | **NOT IMPLEMENTED** | FULL-SRS ONLY |
| External penetration test | FR-SEC-051 | **NOT IMPLEMENTED** | EXTERNAL DEPENDENCY |

### 14.1 The single most important security fact

**Tenant isolation is genuinely strong. Branch isolation does not exist.**

This is a precise and consequential distinction. A tenant's data cannot leak to another tenant —
that is enforced in the database, independent of application code, and proven by six passing
isolation suites. But **within** a tenant, a cashier at Branch 1 holding `pos.order.create` can
create orders at Branch 7; a manager holding `inventory.adjust` can adjust stock at every branch
in the chain. The Internal MVP hid this behind a *single-active-branch fail-closed assertion*
present in exactly two places — `daily-trading-report.service.ts:106` and `day-close.service.ts` —
which throws if a tenant has more than one active branch. **That assertion is the only thing
standing between the current build and cross-branch authorization failure**, and it is a scope
carve-out, not a control.

The moment a pilot tenant opens a second branch, the carve-out either blocks the two reports that
check it or silently permits cross-branch action everywhere that does not.

### 14.2 Test harness determinism (`FR-QA-001/010`, `NFR-MAINT-008`, CT-05)

Inspected directly at `test/jest-e2e.json` and `test/setup-e2e.ts`:

- **All 64 e2e suites share one `DATABASE_URL`.** No testcontainers, no per-suite database, no
  global setup/teardown that provisions a scratch DB.
- **`setup-e2e.ts` sets only two environment variables** (throttle TTL and limit). It performs no
  database isolation whatsoever.
- **Parallel execution corrupts shared assumptions.** The accepted exit-gate report records a
  100-failure run under parallel workers, traced to 15 stale DB sessions and leftover jest-worker
  processes.
- **Data leaks across suites.** `organisation.e2e-spec.ts` asserts a *whole-database* invariant
  ("no org location entity without a registry row") which fails when other suites accumulate
  raw-admin fixtures, yet passes 62/62 in isolation.
- **A fresh scratch DB from zero is reliable** — independently re-confirmed this session:
  35/35 migrations applied clean to a brand-new database with no manual intervention.
- **The persistent `ros` development DB is not required** and was not touched by this audit.

**Verdict: application correctness and CI determinism are genuinely separable here, and the
evidence supports that separation.** The failures are ordering-dependent and disappear under
isolation. But "passes when run alone" is not a property a 4-day parallel programme can build on —
seven lanes running suites concurrently against one shared database will produce exactly the
100-failure class already observed. `G1-2` is therefore a Wave-1 item, and it is a **precondition
for trusting every other lane's test evidence**, not a nice-to-have.

---

## 15. DR / DevOps / Observability gate

### 15.1 The finding that governs this whole section

**There is no CI/CD pipeline anywhere in this repository.** Verified by exhaustive search across
the entire tree: **no `.github` directory, no workflow file, no application `Dockerfile`, no
Terraform, no IaC of any kind.** The only container asset is `docker-compose.yml`, which starts a
local Postgres for development.

This single absence causes **15 `FR-OPS` requirements**, all 13 `§28.5` quality gates,
`FR-PLT-013`, `FR-PLT-014`, `NFR-MAINT-004`, `NFR-MAINT-005`, `NFR-MAINT-006`, `FR-SEC-049` and
`FR-QA-002` to be `NOT IMPLEMENTED` — **not because the artefacts are missing, but because nothing
executes them.** `module-boundaries.spec.ts` passes 45/45. `openapi:check` exists. The isolation
suites pass. None of it gates anything.

### 15.2 DevOps (FR-OPS, 15 requirements — all NOT IMPLEMENTED)

| Area | Requirements | State |
|---|---|---|
| CI/CD pipeline | FR-OPS-001, 002 | none |
| Infrastructure as code | FR-OPS-003 | none |
| Signed images + SBOM | FR-OPS-004 | none |
| Feature flags | FR-OPS-005 | none — zero feature-flag code |
| Staged rollout / client version compatibility / forced updates / release notes | FR-OPS-010..013 | none |
| On-call, runbooks, severity model, post-incident review, status page | FR-OPS-020..023 | none |
| Per-tenant cost attribution | FR-OPS-030, 031 | none |

The SRS §29.4 SLI/SLO table (9 SLIs with alert thresholds) has **no implementation and no
substrate to implement it against**.

### 15.3 Data architecture & DR (FR-DR, 10)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-DR-001 | Range-partition high-volume time-ordered tables | **COMPLETE** | `stock_movements` `PARTITION BY RANGE(occurred_at)`; `orders` and `order_lines` `PARTITION BY RANGE(business_day)` |
| FR-DR-002 | Auto-create partitions ≥ 3 months ahead, with alerting | **NOT IMPLEMENTED** | no scheduled job, no `pg_cron`/`pg_partman`; **fixed horizon — a prior report names 2027-09** |
| FR-DR-003 | Export archived partitions to columnar object storage | **NOT IMPLEMENTED** | none |
| FR-DR-010 | Versioned forward-only migrations in source control | **COMPLETE** | 35 migrations, verified clean from zero this session |
| FR-DR-011..014 | Backward compatibility, expand–migrate–contract, production-sized staging test, safe NOT NULL | **PARTIAL** | the pattern is followed by convention in several migrations, but there is **no lock-budget timing gate and no staging environment** to rehearse against |
| FR-DR-020 | Encrypted backups, quarterly rehearsed restore | **NOT IMPLEMENTED** | none |
| FR-DR-021 | Single-tenant restore without full-database restore | **NOT IMPLEMENTED** | none |

**`FR-DR-002` is a latent production incident, not a paperwork gap.** When the last pre-created
partition is passed, every `INSERT` into `stock_movements`, `orders` and `order_lines` fails —
which is to say **sales stop**. It is `SEV-1` by the SRS's own definition and there is no
mechanism to prevent it.

### 15.4 Observability

Covered in §10.6. The critical structural point: **no measurable NFR in this system can be
verified until `G1-3` lands.** Fifteen of sixteen `NFR-PERF` requirements, all nine §29.4 SLOs and
every `NFR-AVAIL` target are unmeasurable today. This is why observability is Wave 1 and not
Wave 4 — it is not a production-polish item, it is the instrument every other performance claim
depends on.

---

## 16. Offline / Sync gap analysis

**`CR-01` is a project constraint, quoted from §1.9:** *"The POS application MUST operate for a
minimum of 72 hours without server [connectivity]."* This is not a feature — it is a stated
constraint on the product.

**Current state: 36 of 36 `FR-OFF` requirements NOT IMPLEMENTED. Zero substrate.**
Verified by exhaustive search: no `hlc`, no `oplog`, no `operation_log`, no `websocket`, no
`sync` protocol code. The `sync` database schema contains exactly one table, `idempotency_keys`.

### 16.1 Dependency graph

```
[1] Local persistence (SQLite)                       FRONTEND-EXTERNAL
     │
[2] Local config / auth / catalogue cache            SHARED   ← backend must publish a snapshot contract
     │
[3] Local transactional writes                       FRONTEND-EXTERNAL
     │
[4] Identifier strategy + HLC            FR-OFF §21.4  SHARED   ← ALGORITHM MUST BE IDENTICAL BOTH SIDES
     │
[5] Operation log (oplog)                FR-OFF §21.3  SHARED   ← backend defines the envelope
     │
[6] Batch upload                         FR-OFF §21.5  BACKEND  ← endpoint + NFR-PERF-032
     │
[7] Acknowledgement                      FR-OFF §21.5  BACKEND
     │
[8] Retry / idempotency                  FR-API-020..023        ← the ONE piece that partly exists
     │
[9] Server reconciliation                FR-OFF §21.8  BACKEND
     │
[10] Conflict detection & resolution     FR-OFF §21.7  SHARED   ← CT-03
     │
[11] Fiscal sequence handling offline    IR-LOC + CT-01 BACKEND ← hard-depends on P7-FISCAL
     │
[12] Client/server conformance corpus    FR-OFF §21.9  SHARED   ← CT-06 "byte-identical"
     │
[13] KDS local mode                      FR-KDS + §21.6 SHARED
     │
[14] 72-hour offline acceptance          CR-01, CT-01   SHARED  ← 72 h of ELAPSED TIME
```

### 16.2 Ownership split — stated precisely

- **FRONTEND-EXTERNAL (no backend effort):** SQLite/Flutter local store, local write path, local
  UI state. **Not assigned to the backend campaign.**
- **BACKEND (this campaign owns):** oplog envelope schema, batch upload endpoint, acknowledgement
  semantics, server-side revalidation, conflict-resolution rules, fiscal-sequence reconciliation,
  snapshot/bootstrap contract.
- **SHARED (must be identical on both sides, and this is where CT-06 lives):** HLC algorithm,
  local ID generation, price resolution (`FR-POS-041`), tax computation, `Money.allocate`,
  Arabic search normalisation (`FR-POS-012`), conflict-resolution semantics.

### 16.3 The backend obligations blocking the external client team **today**

These are the missing contracts, not missing code:

1. **Local ID scheme** — format, collision avoidance, server reconciliation rule.
2. **HLC specification** — clock structure, comparison, skew bounds (`CT-10`: device 3 hours ahead).
3. **Oplog envelope** — operation shape, ordering guarantees, causal dependencies.
4. **Batch upload contract** — request/response, size limits, partial-failure semantics
   (`NFR-PERF-032`: 500 operations in ≤ 3 s p95).
5. **Acknowledgement semantics** — what "accepted" means, and what the client may then discard.
6. **Conflict classes** — enumerated, with the resolution rule for each.
7. **Fiscal sequence contract** — how a sequence stays intact across a 72-hour partition
   (`CT-01`), which **cannot be specified until `P7-FISCAL` decides the `TaxDocument` model**.
8. **Bootstrap snapshot contract** — what the client caches and how it is invalidated.
9. **Conformance vector corpus** — the shared test cases `CT-06` grades against.

Obligation 7 creates a genuine cross-wave dependency: **the offline protocol cannot be finalised
before the fiscal document model exists.** This is why `D1-1` (Wave 1) is scoped as a *design
gate* producing items 1–6 and 8–9, while item 7 is deferred to `D4-3` after `C3-1`.

### 16.4 What the idempotency substrate already gives us

`sync.idempotency_keys` with a request fingerprint, a stored response, 30-day retention and 409 on
fingerprint mismatch is **exactly** what graph node [8] requires. It was built for online
retry-safety but is directly reusable by the sync protocol. It is the single piece of offline
infrastructure that already exists, and `D1-1` should build the batch-ack semantics on top of it
rather than beside it.

---

## 17. Remaining domain slices

Broken into implementation slices, never grouped as whole modules. Full detail with dependencies,
collision risk and acceptance tests is in the execution-board CSV; this is the inventory.

**A. POS** (6 slices, `C2-1`…`C2-6`) — discounts & approvals · voids/cancellations/refunds ·
split payment & bill splitting & cash rounding · service charge & tips & pooling · table lifecycle ·
order-capture completion (park/resume, seats, courses, combos, open price/description).

**B. KDS** (3, `D2-1`…`D2-3`) — realtime delivery transport · display semantics (colour coding,
sort orders, priority flags, all-day counts, expediter) · timing analytics.

**C. Inventory** (2, `A1-1`, `E2-1`) — **movement write-path correctness** · expiry jobs,
valuation reporting and reorder generation.

**D. Costing** (1, `E2-2`) — theoretical vs actual usage and variance. Waste analysis,
labour cost, profitability and fraud detection fold into `E2-2` and `G3-5`.

**E. Procurement** (4, `E3-1`…`E3-4`) — supplier master & supplier-item pricing · requisition,
quotation, PO, approval · goods receipt & batch creation · supplier invoice, three-way match,
discrepancy, credit note, scoring. *(Reorder-generated requisition is in `E2-1`.)*

**F. Workforce / HR** (3, `F2-1`…`F2-3`) — employee aggregate, branch assignment, employment terms ·
scheduling, staffing rules, swaps · attendance, breaks, adjustments, leave, overtime.
*(Sales- and KDS-performance metrics and payroll export fold into `G3-5`/`D2-3`.)*

**G. CRM / Loyalty** (3, `F3-1`…`F3-3`) — customer records & consent · loyalty ledger &
redemption · promotions engine.

**H. Finance / Treasury** (2, `C3-3`, `C3-4`) — expenses & petty cash · multi-component tax,
X report, Z report completion. *(Fiscal is `C3-1`/`C3-2`.)*

**I. Branch / Central Kitchen** (3, `G3-1`…`G3-3`) — branch groups & cross-branch model ·
CK production, requisition and distribution · branch comparison & franchise support.

**J. Reporting / Analytics** (2, `G3-4`, `G3-5`) — analytics substrate (read replica, rollups,
SCD2 dimensions) · full report catalogue, drill-down, export, alerts.

**K. Localisation** (1, `C4-3`) — country pack completion for EG, SA, AE.
*The pack **architecture** is already `COMPLETE` — signed pack documents with Ed25519
verification, parser, registry, trust store, tax-engine registry. What is missing is fiscal
**content and certification**, not design.*

**L. Integrations** (2, `C4-1`, `C4-2`) — integration framework, webhooks, public API ·
payment terminals, aggregators, accounting, notifications, hardware.

---

## 18. Dependency graph

```
                      ┌──────────────────────────────────────────┐
                      │  A1-1  INVENTORY WRITE-PATH CORRECTNESS  │  ◄── THE ROOT
                      │  (exact decimal + atomic projection)     │
                      └────┬──────────────┬──────────────┬───────┘
                           │              │              │
                    A1-2/A1-3        A1-4 races     E2-1 / E2-2
                  (NFR-PERF-006)                          │
                           │                              │
                           └──────────────┬───────────────┘
                                          ▼
                              E3-3 goods receipt ──► E3-4 invoice/3-way match
                                          ▲
                              E3-1 supplier ──► E3-2 requisition/PO
                                          │
                                     G3-2 central kitchen

  ┌────────────────────────────────────────────────────────────────────┐
  │  B1-1  GOVERNANCE GATE: reopen D-2                                 │  ◄── HARD GATE
  └────┬───────────────────────────────────────────────────────────────┘
       ▼
  B1-2 scoped role assignment + branch claim ──► B1-3 route enforcement
       │                                              │
       ├──► B2-5 API keys (SAME identity migration ── serialize!)
       ├──► F2-1 employee record  (SAME identity migration ── serialize!)
       ├──► C2-* every POS approval/authorization slice
       └──► G4-2 MFA + SoD

  ┌───────────────────────────────────────────────┐
  │  G1-1 CI  ──►  G1-2 deterministic harness     │  ◄── gates ALL test evidence
  │           ──►  G1-3 observability             │  ◄── gates ALL measurable NFRs
  └───────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────┐
  │  D1-1 OFFLINE PROTOCOL DESIGN GATE            │  ◄── unblocks the EXTERNAL client team
  └────┬──────────────────────────────────────────┘
       ▼
  D4-1 sync server ──► D4-2 conflicts ──► D4-3 HLC + fiscal sequence + conformance
                                                      ▲
  B2-3 scheduler/outbox ──► C3-1 TaxDocument ─────────┘
       │                        │
       ├──► B2-2 audit verify   └──► C3-2 fiscal receipt/printing
       ├──► G4-3 retention/DSAR
       ├──► G4-4 partition lifecycle + backup
       └──► G3-4 analytics substrate ──► G3-5 report catalogue
```

**Four roots, and they are genuinely independent of each other:**
`A1-1` (inventory correctness) · `B1-1` (governance) · `G1-1` (CI) · `D1-1` (offline contract).
This is what makes a 4-lane Wave 1 possible.

**The one non-obvious hard dependency:** `E3-3` (goods receipt) writes through
`MovementsService.post`. Building procurement before `A1-1` means every goods receipt lands on
the defective write path, and the corruption is silent.

---

## 19. Workstream map

| WS | Name | Reqs | Lane | Wave | Can start now |
|---|---|---:|---|---|---|
| P1-PERF | Performance + inventory concurrency | 19 | A | 1 | **YES** |
| P2-SEC | Branch RBAC + production security | 45 | B | 1 | **NO — governance** |
| P3-PROD | CI + deterministic tests + observability | 31 | G | 1 | **YES** |
| P4-PLT | Platform + API + audit production substrate | 46 | B | 2 | YES |
| P5-OFF1 | Offline/sync protocol foundation | 22 | D | 1 | **YES (design gate)** |
| P6-POS | Full POS corrections / missing semantics | 122 | C | 2 | partial |
| P7-FISCAL | Finance + fiscal + receipt + outbox | 45 | C | 3 | NO |
| P8-COST | Inventory completion + costing + variance | 85 | E | 2 | NO (needs A1-1) |
| P9-KDS | Full KDS backend | 23 | D | 2 | YES |
| P10-PRC | Procurement | 33 | E | 3 | NO (needs A1-1) |
| P11-HR | Workforce / HR | 29 | F | 2 | NO (needs B1-2) |
| P12-CRM | CRM + loyalty + promotions | 26 | F | 3 | NO |
| P13-CK | Branch groups + central kitchen | 30 | G | 3 | NO |
| P14-RPT | Full reporting / analytics / export | 20 | G | 3 | NO |
| P15-OFF2 | Offline/sync full integration + conflicts | 15 | D | 4 | NO |
| P16-INT | Integrations + country packs | 61 | C | 4 | NO — external |
| P17-DR | Production security + DR + operations | 30 | G | 4 | partial |
| P18-FE | Frontend integration gate (contracts only) | 17 | FRONTEND | 4 | NO |
| P19-FULLQA | Full-SRS acceptance sweep | 26 | G | FINAL | NO |
| P20-CLOSE | Production + full-SRS exit gate | 8 | G | FINAL | NO |
| | **Total** | **733** | | | |

### 19.1 Two corrections to the brief's starting hypothesis

The brief asked for corrections where repository evidence supports one. Two are recommended;
the original workstream IDs are preserved so cross-references remain valid.

**Correction 1 — `P1-PERF` must absorb the inventory write-path defect.**
The brief scopes `P1-PERF` as "performance + inventory concurrency". Evidence shows the
performance problem and the correctness defect are **the same surgery on the same primitive**
(`stock_levels` write discipline). Splitting them means touching the same code twice,
re-benchmarking twice, and shipping a fast-but-corrupt path in between. `P1-PERF` is therefore
scoped as **inventory movement write-path correctness *and* performance**, with correctness first.

**Correction 2 — the scheduler/outbox is a first-class Wave-2 item, not an implicit one.**
Six workstreams independently require a scheduler or transactional outbox (`FR-AUD-005`,
`FR-DR-002`, `FR-SEC-061`, `FR-FIN-026`, `FR-RPT-040/041`, `BR-INV-003` reconciliation). The
repository already records this absence in five separate source comments. If each lane builds its
own, Wave 3 will contain six incompatible schedulers. `B2-3` claims it as shared infrastructure
under a single owner. Note that its cited authority, `FR-PLT-041`, is a **dangling reference**
(SIG-02) — so `B2-3` must open with a governance question, not an implementation assumption.

---

## 20. Lane map

| Lane | Scope | Wave 1 | Wave 2 | Wave 3 | Wave 4 |
|---|---|---|---|---|---|
| **A** | Performance + inventory concurrency | `A1-1` `A1-2` `A1-3` `A1-4` | — | — | — |
| **B** | Security + RBAC + audit + platform/API | `B1-1` `B1-2` `B1-3` | `B2-1`…`B2-5` | — | — |
| **C** | POS backend + finance + fiscal | — | `C2-1`…`C2-6` | `C3-1`…`C3-4` | `C4-1`…`C4-3` |
| **D** | KDS backend + offline/sync server | `D1-1` | `D2-1`…`D2-3` | — | `D4-1`…`D4-3` |
| **E** | Inventory/costing + procurement | — | `E2-1` `E2-2` | `E3-1`…`E3-4` | — |
| **F** | Workforce/HR + CRM/loyalty | — | `F2-1`…`F2-3` | `F3-1`…`F3-3` | — |
| **G** | Branch/CK + reporting + DevOps/QA/DR | `G1-1` `G1-2` `G1-3` | — | `G3-1`…`G3-5` | `G4-1`…`G4-5` |
| **FRONTEND** | External team — integration only | — | — | — | `FE-1` |

Lane A is deliberately short and front-loaded: it holds the root dependency and must finish
early for Lanes C and E to proceed safely.

---

## 21. Schema collision matrix

| Module | Likely models/tables | Likely migration | Depends on lane | Collision risk | Merge order | Centralise design first? |
|---|---|---|---|---|---|---|
| Inventory write path (`A1-1`/`A1-3`) | `stock_levels`, `stock_movements`, `stock_batches` | possibly none (logic only) | — | **HIGH** — E, C read it | **1st** | **YES — design gate** |
| Identity scope (`B1-2`) | `membership_roles` (+`scope_type`,`scope_id`,`valid_from`,`valid_to`) | `identity_role_scope` | B | **HIGH** | **2nd** | **YES — D-2 governance** |
| API keys (`B2-5`) | `api_keys` | `identity_api_keys` | B1-2 | **HIGH** — same identity schema | 3rd | YES |
| Employee record (`F2-1`) | `employees`, `employee_branches` | `workforce_employee_record` | B1-2 | **HIGH** — same identity/workforce surface | 4th | YES |
| Scheduler/outbox (`B2-3`) | `outbox_messages`, `scheduled_jobs` | `platform_outbox` | — | **HIGH** — 6 workstreams | **2nd** | **YES** |
| POS discounts (`C2-1`) | `order_discounts`, `discount_reasons`; `orders.discount_total` | `sales_discounts` | B1-2 | **HIGH** — sales schema | 5th | YES |
| POS refunds (`C2-2`) | `order_refunds`, `refund_lines`, `void_dispositions` | `sales_corrections` | C2-1, A1-1 | **HIGH** — same sales surface | 6th | YES |
| POS split payment (`C2-3`) | `order_payments` (extend), `bill_splits` | `sales_split_payment` | C2-1 | **HIGH** — same sales surface | 7th | YES |
| POS tips/service charge (`C2-4`) | `orders.tip_total`/`service_charge_total`, `tip_pools` | `sales_tips` | C2-1 | MEDIUM | 8th | no |
| POS capture (`C2-6`) | `order_lines.seat_no`, `courses`, `combo_slots` | `sales_capture` | — | **HIGH** — sales schema | 9th | YES |
| Tables (`C2-5`) | `branch_tables` (extend), `table_sessions` | `org_table_lifecycle` | B1-2 | MEDIUM | 10th | no |
| Fiscal (`C3-1`) | `fiscal.tax_documents`, `fiscal.submission_attempts`, `fiscal.sequences` | `fiscal_documents` | B2-3, C2-* | **HIGH** — new schema, but isolated | 11th | **YES** |
| Expenses (`C3-3`) | `treasury.expenses`, `expense_categories` | `treasury_expenses` | C2-1 | LOW | 12th | no |
| Procurement (`E3-1`…`E3-4`) | `procurement.suppliers`, `supplier_items`, `requisitions`, `purchase_orders`, `po_lines`, `goods_receipts`, `gr_lines`, `supplier_invoices`, `credit_notes` | `procurement_foundation` (+3) | A1-1, C2-1 | **HIGH** — new schema; **also writes `stock_batches`/`stock_movements`** | 13th | **YES** |
| CRM (`F3-1`…`F3-3`) | `crm.customers`, `loyalty_accounts`, `loyalty_ledger`, `promotions`, `promotion_rules` | `crm_foundation` (+2) | B1-2 | MEDIUM — new schema, but promotions touch price resolution | 14th | YES |
| HR (`F2-2`/`F2-3`) | `workforce.schedules`, `shift_assignments`, `attendance`, `breaks`, `leave_requests` | `workforce_scheduling` (+1) | F2-1 | MEDIUM | 15th | no |
| Central kitchen (`G3-2`) | `org.branch_groups`, `production.ck_production_orders`, `ck_distributions` | `org_branch_groups`, `production_ck` | A1-1, E3-2 | **HIGH** — writes inventory | 16th | YES |
| Analytics (`G3-4`) | `reporting.fact_*`, `dim_*` (SCD2), rollups | `reporting_star_schema` | B2-3 | MEDIUM — new schema, read-mostly | 17th | YES |
| Sync (`D4-1`) | `sync.operation_log`, `sync_batches`, `device_clocks` | `sync_protocol` | D1-1, B2-3 | MEDIUM — schema nearly empty today | 18th | **YES — D1-1** |
| Integrations (`C4-1`) | `integrations.connections`, `webhook_subscriptions`, `delivery_attempts` | `integrations_foundation` | B2-3, B2-5 | LOW | 19th | no |

### 21.1 MUST NOT be implemented simultaneously without coordination

1. **`B1-2` + `B2-5` + `F2-1`** — three lanes (B, B, F) all migrate the `identity`/`workforce`
   schema. **Serialize: `B1-2` → `B2-5` → `F2-1`.**
2. **`C2-1` … `C2-6`** — six slices all migrate `sales`. Merge in the stated order behind a single
   sales-schema owner.
3. **`A1-1`/`A1-3` + `E3-3` + `G3-2`** — all write `stock_levels`/`stock_movements`.
   **`A1-1` must land first, without exception.**
4. **`B2-3` outbox + `B2-2` audit verify + `G4-4` partitions + `G3-4` rollups** — all need the
   scheduler. **`B2-3` first; the other three consume it.**
5. **`F3-3` promotions + `C2-1` discounts** — both alter price-resolution precedence
   (`FR-POS-051` governs their interaction). Same owner or a joint design gate.

---

## 22. Cross-module collision matrix

| Shared surface | Claimed by | Risk | Recommended ownership |
|---|---|---|---|
| `prisma/schema.prisma` | every lane | **HIGH** | One schema steward merges all model additions; lanes submit model blocks, never edit the file concurrently |
| Migration ordering (timestamp prefixes) | every lane | **HIGH** | Central migration-slot registry; timestamps allocated up front, per the merge order in §21 |
| `common/money` (`Money`, `Rational`, `allocate`) | A, C, E, F | **HIGH** | **FROZEN.** `BR-CORE-001/002` are COMPLETE and unit-proven. Changes only via design gate — `CT-12` grades this |
| `common/domain-events` `UnitOfWork` | A, B, C, D | **HIGH** | Lane B owns; `B2-3` outbox extends it |
| `governance/audit` | every lane | **HIGH** | Lane B owns; other lanes call `AuditService`, never modify the chain |
| Permission catalogue (`*.permissions.ts`) | every lane | **HIGH** | Lane B owns the namespace; new codes reviewed centrally. **40 codes today; SRS Appendix C is absent (SIG-03)** so the catalogue must be treated as authored, not derived |
| OpenAPI document (`docs/api/openapi.json`) | every lane | **MEDIUM** | Generated, never hand-edited; `openapi:check` becomes a CI gate in `G1-1` |
| `app.module.ts` module registry | every lane | **MEDIUM** | Append-only convention; one line per new module |
| Domain event catalogue (`*/contract/events.ts`) | A, C, D, F | **MEDIUM** | Event names namespaced per module; the catalogue is append-only |
| `test/setup-e2e.ts`, `jest-e2e.json` | every lane | **HIGH** | Lane G owns via `G1-2`; **freeze until `G1-2` lands**, otherwise every lane fights the same shared database |
| `package.json` | every lane | **MEDIUM** | Dependency additions batched, reviewed for `FR-SEC-049` |
| `docker-compose.yml` / CI files | G | LOW | Lane G exclusively |
| `common/idempotency` | C, D | **MEDIUM** | Lane C owns; `D4-1` extends for batch semantics rather than forking |
| `fifo-cost-ledger.ts` (private kernel) | A, E | **HIGH** | Lane A exclusively during Wave 1; Lane E consumes afterwards |
| `price-resolution.ts` | C (discounts), F (promotions) | **HIGH** | Joint design gate before either `C2-1` or `F3-3` writes code |
| `module-boundaries.spec.ts` `KNOWN_DEVIATIONS` | every lane | **MEDIUM** | Additions require justification in the slice's report; the list must not silently grow |

---

## 23. Merge waves

The brief's starting hypothesis was tested against the dependency graph. **Wave 1 is confirmed as
proposed** — `P1-PERF`, `P2-SEC`, `P3-PROD`, `P5-OFF1` are genuinely independent. Waves 2–4 need
three corrections, given below.

### Wave 1 — foundations (`P1-PERF`, `P2-SEC`, `P3-PROD`, `P5-OFF1`)

| Property | Value |
|---|---|
| Parallel-safe | **YES** — four disjoint file surfaces: `modules/inventory`, `modules/identity`, CI + `test/`, design-only |
| Shared-file collisions | **None.** `D1-1` writes no code |
| Shared-schema collisions | **None.** `A1-1` may need no migration; `B1-2` touches only `identity` |
| Prerequisites | `B1-1` governance gate must clear before `B1-2` starts. `A1-3` needs its own design gate |
| Merge order | `G1-1` → `G1-2` → `A1-1` → `A1-2` → `A1-3` → `B1-2` → `B1-3` → `G1-3` → `D1-1` |
| Post-merge verification | Full e2e ×3 on fresh scratch DBs · NFR-PERF-006 re-benchmark · new movement-concurrency suite · cross-**branch** isolation suite · `module-boundaries` 45/45 · `prisma validate` · `openapi:check` |
| Lanes that must rebase after | **All** — `G1-2` changes the test harness every lane depends on |

**Rationale for putting CI first inside Wave 1:** without `G1-1`/`G1-2`, seven lanes will run
suites concurrently against one shared database and reproduce the documented 100-failure class.
No other lane's test evidence is trustworthy until this lands.

### Wave 2 — core backend (`P4-PLT`, `P6-POS`, `P8-COST`, `P9-KDS`, `P11-HR`)

| Property | Value |
|---|---|
| Parallel-safe | **PARTIALLY** — `P6-POS` and `P8-COST` are safe; `P11-HR` collides with `P4-PLT` on `identity` |
| Shared-file collisions | `sales.dto.ts`, `orders.controller.ts`, `order-state.ts` across all six `C2-*` slices |
| Shared-schema collisions | **`B2-5` (api_keys) vs `F2-1` (employees) — both migrate `identity`. SERIALIZE.** |
| Prerequisites | `A1-1` merged (`P8-COST` writes inventory) · `B1-2` merged (`P6-POS` approvals, `P11-HR` scope) · `B2-3` before `B2-2` |
| Merge order | `B2-3` → `B2-1` → `B2-2` → `B2-4` → `B1-2`-dependent `B2-5` → `F2-1` → `C2-1` → `C2-2` → `C2-3` → `C2-4` → `C2-5` → `C2-6` → `E2-1` → `E2-2` → `D2-1` → `D2-2` → `D2-3` → `F2-2` → `F2-3` |
| Post-merge verification | Full e2e · `CT-12` end-to-end once `C2-3` lands · NFR-PERF-006 re-benchmark (`E2-1` touches inventory) |
| Lanes that must rebase | C, E, F after every `identity`/`sales` migration |

**Correction A:** the brief places `P11-HR` in Wave 2. Keep it there, but **explicitly serialize
`F2-1` behind `B1-2` and `B2-5`** — all three migrate `identity`, and this is the single most
likely source of a lost migration in the whole plan.

### Wave 3 — business domains (`P7-FISCAL`, `P10-PRC`, `P12-CRM`, `P13-CK`, `P14-RPT`)

| Property | Value |
|---|---|
| Parallel-safe | **YES for schema** (four new schemas: `fiscal`, `procurement`, `crm`, `reporting`) |
| Shared-file collisions | `price-resolution.ts` — `F3-3` promotions vs `C2-1` discounts (**joint gate**) |
| Shared-schema collisions | `E3-3` and `G3-2` both write `stock_batches`/`stock_movements` — **serialize behind `A1-1`** |
| Prerequisites | `B2-3` outbox (fiscal + reporting) · `A1-1` (procurement + CK) · `C2-1`…`C2-3` (fiscal needs discounts/refunds/splits to produce correct documents) |
| Merge order | `C3-1` → `C3-2` → `C3-4` → `C3-3` → `E3-1` → `E3-2` → `E3-3` → `E3-4` → `G3-1` → `G3-2` → `G3-4` → `G3-5` → `F3-1` → `F3-2` → `F3-3` → `G3-3` |
| Post-merge verification | Full e2e · `CT-09` (fiscal downtime) · `CT-11` (multi-currency) · NFR-PERF-010/011 first measurement |
| Lanes that must rebase | E and G after `A1-1`-adjacent changes; C after `G3-4` |

**Correction B:** the brief places `P14-RPT` in Wave 3 alongside `P13-CK`. `G3-3` (branch
comparison) **consumes** `G3-4` (analytics substrate), so `P14-RPT`'s substrate slice `G3-4` must
merge **before** `P13-CK`'s `G3-3`. Reflected in the merge order above.

### Wave 4 — production hardening (`P15-OFF2`, `P16-INT`, `P17-DR`, `P18-FE`)

| Property | Value |
|---|---|
| Parallel-safe | **YES** — `sync`, `integrations`, infrastructure, contracts-only are disjoint |
| Shared-file collisions | `D4-3` and `C3-1` both touch fiscal sequencing |
| Shared-schema collisions | `G4-2` (MFA) migrates `identity` again — last identity migration, serialize |
| Prerequisites | `D1-1` and `C3-1` both merged before `D4-3` · `G1-1` before all `G4-*` · provider credentials **procured in Wave 1**, not Wave 4 |
| Merge order | `D4-1` → `D4-2` → `C4-1` → `G4-1` → `G4-2` → `G4-3` → `G4-4` → `G4-5` → `D4-3` → `C4-3` → `C4-2` → `FE-1` |
| Post-merge verification | `CT-01`…`CT-15` sweep · restore drill · full security scan |
| Lanes that must rebase | All, before the final gate |

**Correction C:** `C4-2` (external providers) is placed last in the merge order but its
**procurement of sandbox credentials must begin in Wave 1**. Certification lead times are
measured in weeks and cannot compress into a 4-day build. This is the plan's largest
schedule risk and it is not solvable by engineering effort (§27).

### FINAL — `P19-FULLQA`, `P20-CLOSE`

`Z-1` runs the full CT sweep; `Z-2` evidences each gate criterion individually.
**`CT-01` requires 72 hours of elapsed time and must be launched during Wave 4, not at the gate.**

---

## 24. PRE-PILOT gate

*What must be complete before a controlled real operational pilot* — real staff, real orders, but
a bounded blast radius and heightened supervision.

**25 blockers.** Each is listed with why it blocks a *pilot* specifically.

| # | Requirement | Why it blocks a pilot | Slice |
|---|---|---|---|
| 1 | `BR-INV-003` | Lost update silently corrupts `stock_levels`; a pilot generates exactly the concurrent receiving-plus-selling that triggers it | `A1-1` |
| 2 | `BR-CORE-003` | Float quantity arithmetic accumulates error into the ledger on every movement — no concurrency needed | `A1-1` |
| 3 | `FR-INV-030` | Movement ledger truthfulness depends on 1 and 2 | `A1-1` |
| 4 | `NFR-PERF-006` | 440 ms in-transaction completion holds FIFO layer locks; multi-terminal contention is invisible in single-terminal testing | `A1-2`/`A1-3` |
| 5 | `CT-08` | Stock count during trading is a routine pilot activity and is currently unsafe | `A1-4` |
| 6 | `FR-SEC-002` | A pilot tenant with two branches has no branch isolation | `B1-2` |
| 7 | `FR-SEC-003` | Same | `B1-2` |
| 8 | `FR-SEC-004` | Same | `B1-2` |
| 9 | `FR-SEC-046` | No progressive lockout; password login has no account lockout | `B1-3` |
| 10 | `FR-PLT-013` | Isolation suites are not schema-generated, so new tables are unprotected by test | `G1-1` |
| 11 | `FR-PLT-014` | Nothing fails the build when a table lacks RLS | `G1-1` |
| 12 | `CT-05` | Cross-tenant test does not cover every table | `G1-1` |
| 13 | `FR-OPS-001` | No CI — nothing is verified before it ships to the pilot | `G1-1` |
| 14 | `FR-OPS-002` | Same | `G1-1` |
| 15 | `NFR-MAINT-004` | Boundary test passes but is unenforced | `G1-1` |
| 16 | `FR-QA-010` | No reproducible seed data — a pilot issue cannot be reproduced locally | `G1-2` |
| 17 | `NFR-OBS-001` | Unstructured logs make pilot incidents undiagnosable | `G1-3` |
| 18 | `NFR-OBS-003` | No metrics — degradation is invisible until someone complains | `G1-3` |
| 19 | `NFR-OBS-006` | No alerts — failures are discovered by the pilot site, not by us | `G1-3` |
| 20 | `FR-AUD-001` | Audit coverage not proven exhaustive; a pilot dispute needs a complete trail | `B2-1` |
| 21 | `FR-AUD-005` | Chain verification never runs, so tamper-evidence is unproven | `B2-2` |
| 22 | `FR-DR-002` | Partition exhaustion halts all sales — SEV-1 with no mitigation | `G4-4` |
| 23 | `FR-DR-020` | No backup — a pilot data-loss event is unrecoverable | `G4-4` |
| 24 | `FR-POS-070` | No post-fire void; real service requires it hourly | `C2-2` |
| 25 | `FR-POS-093` | No X report; a supervisor cannot check the drawer mid-shift | `C3-4` |

**Explicitly NOT pre-pilot blockers**, with justification: offline operation (a supervised pilot
can accept online-only, though `CR-01` makes this a temporary concession); fiscal receipts (pilot
must run in a non-fiscal or manually-reconciled mode, which constrains site selection);
procurement, HR, CRM (a pilot can operate without them); MFA, SoD, encryption at rest
(supervised access with a small named user set); full reporting.

---

## 25. PRODUCTION gate

*Real restaurants, real money, real customer data.* **95 blockers.** All 25 pre-pilot blockers
carry forward. The 70 additional ones cluster into eight groups:

**1. Fiscal and legal (13 + 4).** All 13 `IR-LOC-*` (EG e-Receipt, ZATCA Phase 2 including PIH
hash chain and cryptographic stamps, UAE VAT), plus `FR-FIN-026`, `FR-POS-100`, `CT-09`, `CR-04`.
**Selling in EG/SA/AE without fiscal integration is unlawful, not merely incomplete.**
This is also `EXTERNAL BLOCKER` — certification cannot be produced from source code.

**2. Security hardening (24).** MFA (`FR-SEC-023/024`) · SoD (`FR-SEC-015/016/017`) ·
encryption at rest and field-level (`FR-SEC-041/042/043`) · secrets management (`FR-SEC-050`) ·
dependency and secret scanning (`FR-SEC-049`, `NFR-MAINT-005`) · TLS (`FR-SEC-040`) ·
per-tenant rate limits (`FR-PLT-015`) · API keys (`FR-API-011/014`) · standard roles
(`FR-SEC-010/012`) · IP allow-list and SIEM (`FR-SEC-052/053`) · session controls
(`FR-SEC-026/027`) · password policy completion (`FR-SEC-025`).

**3. Privacy and retention (8).** `FR-SEC-060`…`064`, `FR-AUD-009`, `FR-AUD-010`, `CR-08`.
Real customer data engages statutory obligations. **`CR-08`'s 7-year audit retention is a
regulatory MUST with zero enforcement today.**

**4. Audit completeness (3).** `FR-AUD-007`, `FR-AUD-008`, `FR-AUD-010`. An auditor who cannot
query the audit log has no audit log.

**5. DR and operations (13).** `FR-DR-003`, `FR-DR-021`, `FR-OPS-003`…`005`, `FR-OPS-020`…`023`,
`NFR-AVAIL-001/005`, `NFR-REL-010/012/013`. **RPO ≤ 5 min / RTO ≤ 60 min with no backup
mechanism is not a gap, it is an unbounded liability.**

**6. Observability completion (6).** `NFR-OBS-002`, `004`, `005`, `007`, `NFR-MAINT-005/006`.

**7. POS financial correctness (10).** Discounts with approval (`FR-POS-045`…`049`) · refunds
(`FR-POS-071`…`075`) · cash rounding (`FR-POS-063`). **Real money demands that a discount be
approvable and a refund be bounded by the original sale.**

**8. Platform lifecycle (4).** `FR-PLT-015`, `016`, `021`, `022`, `023`. A paying tenant must be
able to export their data and terminate.

---

## 26. FULL SRS v1.0 gate

**622 blockers** — everything not `COMPLETE`. Beyond production readiness, the full-SRS target
additionally requires:

| Area | Reqs | What remains beyond production |
|---|---:|---|
| Offline / sync | 36 + `CR-01` + `NFR-CAP-001` | The **entire** domain. `CR-01`'s 72-hour constraint and `CT-01`/`CT-06`/`CT-10`/`CT-14` |
| Procurement | 33 + `UC-PRC-01` | The entire procure-to-pay cycle |
| CRM / loyalty | 26 + `CT-13` | The entire domain |
| Workforce / HR | 29 - 6 | Scheduling, attendance, leave, payroll export |
| Costing analytics | 24 + `UC-CST-01` | Theoretical-vs-actual, waste analysis, labour cost, profitability, fraud detection |
| Central kitchen | 19 | CK production, requisition, distribution, internal pricing, franchise |
| Reporting | 17 | Report catalogue, dashboards, drill-down, export, alerts, NLQ (`FR-RPT-047` `[C]`) |
| External integrations | 35 | Terminals, aggregators, accounting, notifications, webhooks, hardware |
| POS completeness | 50 | Combos, courses, seats, floor plan, on-account, open price, nested modifiers |
| KDS completeness | 4 + analytics | Expediter, prep-time coordination, icon mode, capacity warnings |
| Scale / availability | 20 | Every `NFR-SCALE` and `NFR-AVAIL` target, none ever measured |
| Usability / accessibility | 17 | `FRONTEND-EXTERNAL`; WCAG 2.1 AA is genuinely required |
| Critical tests | 15 | All 15 must pass; **0 do today** |

**A defensible "full SRS v1.0 complete" claim additionally requires resolving the four
source-integrity gaps in §3.** `FR-QA-002` is unsatisfiable while Appendix B is absent, and
completeness cannot be asserted against a specification that references content it does not
contain. **This is a governance action, not an engineering one, and it is on the critical path
to the claim.**

---

## 27. External provider / certification blockers

Work that **cannot be completed from source code alone**, no matter how much engineering effort
is applied.

| SRS requirement | Code work remaining | Sandbox/test-double verification possible? | External artefact/access required | Blocks pilot | Blocks production | Blocks full-SRS claim |
|---|---|---|---|:---:|:---:|:---:|
| `IR-LOC-EG-001`…`004` | TaxDocument, outbox, ETA adapter | Partially — against a mock ETA | **ETA e-Receipt sandbox credentials + certification** | NO | **YES** | **YES** |
| `IR-LOC-SA-001`…`005` | ZATCA Phase 2, TLV QR, PIH chain, cryptographic stamp | Partially — TLV/PIH are self-verifiable | **ZATCA Fatoora onboarding + CSID** | NO | **YES** | **YES** |
| `IR-LOC-AE-001`…`004` | UAE VAT, municipality fees, tourism dirham | Mostly yes | UAE e-invoicing readiness (`[C]`) | NO | **YES** | **YES** |
| `IR-INT-001`…`005` | Payment terminal adapter | Yes — simulator | **Provider SDK + certified terminal hardware** | NO | **YES** | **YES** |
| `IR-INT-010`…`018` | Aggregator adapters | Yes — mock | Talabat/Deliveroo/Careem partner credentials | NO | NO | **YES** |
| `IR-INT-020`…`024` | Accounting export | Yes | QuickBooks/Xero/SAP developer accounts | NO | NO | **YES** |
| `IR-INT-030`…`033` | SMS/WhatsApp/email | Yes — mock | **Twilio/Meta/SES credentials + WhatsApp template approval** | NO | **YES** (`FR-POS-103`) | **YES** |
| `IR-INT-060`…`066` | ESC/POS printing, scales, cash drawers | Partially | **Physical printer matrix; `CT-15` needs real Arabic printing** | NO | **YES** | **YES** |
| `FR-SEC-043` | Envelope encryption | Yes — local KMS emulator | **Production cloud KMS** | NO | **YES** | **YES** |
| `FR-SEC-063` | Data residency | No | **Multi-region cloud footprint** | NO | **YES** | **YES** |
| `FR-SEC-051` | — | No | **External penetration test vendor** | NO | **YES** (`[S]`) | **YES** |
| `FR-PLT-016`, `NFR-SCALE-008` | Replica routing + pool | Yes — local replica | **Managed Postgres with read replicas** | NO | **YES** | **YES** |
| `FR-DR-020/021`, `NFR-REL-013` | Restore tooling | Partially | **Backup infrastructure + rehearsal window** | **YES** | **YES** | **YES** |
| `NFR-PORT-001`…`003` | — | No | **Device/browser compatibility lab** | NO | NO | **YES** |
| `CR-01`, `CT-01` | Full offline stack | No — **elapsed time cannot be simulated** | **72 continuous hours of certification time** | NO | **YES** | **YES** |
| `NFR-SCALE-001`…`007` | Load harness | Partially | **Production-scale load environment** | NO | **YES** | **YES** |
| `NFR-USA-007/008` | — | Automated partially | **Manual WCAG 2.1 AA audit** | NO | NO | **YES** |

### 27.1 The schedule risk this creates

**Fifteen of these have procurement or certification lead times measured in weeks.** A 4-day
engineering programme cannot compress them, and no amount of parallelism helps.

**Recommendation, and it is the single highest-leverage non-engineering action available:**
begin procurement on **day 1**, in parallel with Wave 1 — ZATCA onboarding, ETA sandbox, cloud
KMS provisioning, managed-Postgres-with-replicas, backup infrastructure, printer hardware,
Twilio/Meta credentials, and the WCAG audit engagement. Every one of these is a dependency that
Wave 4 will otherwise discover it cannot satisfy.

**`CT-01` deserves separate emphasis: 72 hours of elapsed time is 75% of the entire 4-day
programme.** It must be launched no later than the start of Wave 4 to complete at all, and it
depends on the full offline stack existing by then. This is the plan's hardest scheduling
constraint and it should be treated as a fixed, non-negotiable date rather than an item to be
sequenced.

---

## 28. 4-day execution board

**60 slices**, sorted by merge wave → lane → slice ID, in
`2026-09-02_FULL-SRS-4day-execution-board.csv`, with all 21 requested columns.

| Wave | Slices | Can start now | Lanes active |
|---|---:|---:|---|
| 1 | 11 | 8 | A, B, D, G |
| 2 | 19 | 13 | B, C, D, E, F |
| 3 | 16 | 13 | C, E, F, G |
| 4 | 12 | 7 | C, D, G, FRONTEND |
| FINAL | 2 | 0 | G |
| **Total** | **60** | **42** | |

Wave-1 slices in full:

| Slice | Workstream | Name | Lane | Start now | Size | Collision risk |
|---|---|---|---|---|---|---|
| `A1-1` | P1-PERF | **Inventory movement write-path: exact-decimal + atomic projection** | A | **YES** | M | HIGH |
| `A1-2` | P1-PERF | NFR-PERF-006: lock grouping by distinct (stockItemId, locationId) | A | YES | S | HIGH |
| `A1-3` | P1-PERF | NFR-PERF-006: set-oriented allocation writes with window-function `balance_after` | A | **NO — design gate** | L | HIGH |
| `A1-4` | P1-PERF | Inventory concurrency test matrix completion | A | YES | M | MEDIUM |
| `B1-1` | P2-SEC | **GOVERNANCE GATE: reopen D-2 for branch-scoped RBAC** | B | **NO — user action** | XS | LOW |
| `B1-2` | P2-SEC | Role assignment scope + permitted-branch token claim | B | NO (needs `B1-1`) | L | HIGH |
| `B1-3` | P2-SEC | Branch authorization enforcement at every business route | B | NO (needs `B1-2`) | L | HIGH |
| `G1-1` | P3-PROD | **CI pipeline from zero** | G | **YES** | M | LOW |
| `G1-2` | P3-PROD | Deterministic e2e harness: per-suite ephemeral database | G | **YES** | M | MEDIUM |
| `G1-3` | P3-PROD | Observability baseline: JSON logs, correlation propagation, RED metrics | G | **YES** | M | MEDIUM |
| `D1-1` | P5-OFF1 | **DESIGN GATE: offline/sync protocol (server half)** | D | **YES** | L | LOW |

Per §29 of the brief, **no hour estimates are given** — the repository provides no velocity
evidence to support them. Relative size (`XS`…`XL`) and parallelizability (`HIGH`/`MEDIUM`/`LOW`)
are given instead.

---

## 29. EXACT next implementation blocker

### 29.1 Selection

> ## `P1-PERF` — Inventory movement write-path correctness and performance
> ### Slice `A1-1`, immediately followed by `A1-2` and (behind a design gate) `A1-3`

The brief anticipated `P1-PERF` / NFR-PERF-006 remediation. That is confirmed as the winner —
but **the scope is wider than the brief assumed**, and the widening is the substantive finding.
The blocker is not "make depletion faster". It is "make the inventory write path correct, and the
same surgery makes it fast."

### 29.2 Exact requirement IDs

**Primary:** `BR-INV-003` · `BR-CORE-003` · `NFR-PERF-006` · `FR-INV-030`
**Secondary:** `FR-INV-012` · `FR-INV-013` · `FR-INV-022` · `FR-INV-023` · `CT-07` · `CT-08` ·
`BR-INV-001` · `BR-INV-002`

### 29.3 Current state

- `NFR-PERF-006`: **PARTIAL / VERIFIED-FAILING.** Measured this session, isolated: p50 440.44 ms,
  p95 568.73 ms, min 375.80 ms vs ≤ 200 ms p95.
- `BR-INV-003`: **PARTIAL.** Truthful on the completion path; **defective on the
  transfer/count/waste/adjustment path** (§12.1). No daily reconciliation job.
- `BR-CORE-003`: **PARTIAL.** Exact 6-dp arithmetic on the completion path; **IEEE-754 float on
  `MovementsService.post`**.

### 29.4 Why this is first — tested against the brief's six criteria, in order

**1 — Hard dependency.** `MovementsService.post` is the write path for transfers, counts, waste,
adjustments **and every future goods receipt (`E3-3`) and central-kitchen production (`G3-2`)**.
Lane E and Lane G both build directly on it. Building procurement first means every goods receipt
lands on a defective primitive, silently. This is the strongest hard dependency in the graph.

**2 — Irreversible correctness risk.** This is decisive. A lost update on `stock_levels` is
**silent** — no error, no constraint violation, no alert — and it permanently breaks `BR-INV-003`.
Float drift additionally pollutes `stock_movements.balance_after`, so even a corrective ledger
re-fold would be computed from corrupted values. There is no clean recovery path once real
inventory data has accumulated. **No other candidate blocker has this property.**

**3 — Pilot-blocking.** Yes. A pilot generates exactly the concurrent receiving-while-selling and
counting-while-trading that trigger it (`CT-08`). And `NFR-PERF-006`'s 440 ms in-transaction lock
hold is invisible in single-terminal testing but not in a real kitchen.

**4 — Production-blocking.** Yes, via `BR-INV-003` and `CR-04` (financial records immutable and
truthful).

**5 — Downstream unlocks.** `A1-1` unlocks `E2-1`, `E2-2`, `E3-3`, `E3-4`, `G3-2` — five slices
across two lanes and roughly 150 requirements.

**6 — Retrofit cost.** Extreme. Every module written against the defective primitive would need
rewriting **and** its data would need re-derivation from the ledger — which, because of the float
defect, is not fully possible.

### 29.5 Why the alternatives lost — stated so the decision can be audited

| Candidate | Why it did not win |
|---|---|
| **`FR-SEC-002` branch authorization** | The most serious *security* gap in the audit, and a genuine pilot blocker — but **`can_start_now = NO`**. Ratified decision **D-2 (CORE ONLY, 2026-08-17)** still defers branch-scoped RBAC. It cannot begin without a governance reopening (`B1-1`), so it cannot be the *immediately executable* next unit. **It is the highest-priority Wave-1 parallel item and `B1-1` should be raised the same day.** |
| **`G1-1`/`G1-2` CI + test determinism** | No governance blocker, genuinely startable now, and correctly placed in Wave 1 as a parallel item. But it carries **no irreversible correctness risk** (criterion 2) and hard-blocks no other lane's *implementation* — only its *evidence*. Runs in parallel in Lane G. |
| **`D1-1` offline protocol** | Largest scope (36 requirements) and unblocks the external client team, so it is Wave 1. But it is a **design gate producing no code**, and `CR-01`'s dependency chain runs through fiscal (`C3-1`), which is Wave 3. Cannot be first. |
| **`NFR-PERF-006` alone** | This is the brief's expected answer, and it *is* included — but as `A1-2`/`A1-3`, **after** `A1-1`. Optimizing a write path that is already losing updates would bake the defect into a faster implementation and require the surgery twice. |

### 29.6 Implementation boundary

**In scope**
- `src/modules/inventory/movements/movements.service.ts` — replace read-then-absolute-write with
  the atomic additive `ON CONFLICT DO UPDATE … RETURNING` pattern; derive `balanceAfter` from the
  returned value.
- Replace `number` quantity arithmetic with the existing exact `Rational`/`parseExactDecimal`
  helpers from `common/money`. Change `PostMovementInput.quantity` from `number` to an exact
  decimal string.
- `src/modules/inventory/sale-depletion/sale-depletion.service.ts` — group by distinct
  `(stockItemId, locationId)`; lock once per group (`A1-2`).
- `src/modules/inventory/costing/fifo-cost-ledger.ts` — maintain deterministic evolving in-memory
  layer state across an order's consumption of one item (`A1-2`).
- `A1-3` (behind the design gate): set-oriented writes — see §29.10.
- New concurrency e2e suites (`A1-4`).

**Out of scope — explicit non-goals**
- No change to FIFO costing semantics, FEFO physical selection, or carry-forward provenance.
- No change to any route, permission, DTO or OpenAPI operation.
- No change to Prisma models or migrations (`A1-1` and `A1-2` should require none; `A1-3` may need
  one only if the design gate concludes it does).
- No governance decision reopened.
- **No new module, no scheduler, no outbox** — `B2-3` owns those.
- No branch authorization work — `B1-2`/`B1-3` own it.
- No procurement, no CK, no reporting.

### 29.7 Accepted invariants — must survive unchanged

1. `stock_movements` append-only (`BR-INV-001`); `ros_app` holds `SELECT, INSERT` only.
2. Every `stock_movements.balance_after` is **individually truthful** — the running fold of the
   ledger in deterministic order. **Not a final projection delta.**
3. `stock_levels` equals `fold(stock_movements)` exactly, at 6 decimal places (`BR-INV-003`).
4. FIFO receipt-order cost basis and FEFO nearest-expiry physical selection remain independent
   axes.
5. Carry-forward provenance retains the true exhausted batch as cost basis.
6. Exact monetary arithmetic — no float in money or quantity.
7. Deterministic global lock order on `(stock_item_id, location_id)`; **no `SKIP LOCKED`**.
8. Idempotency: `sale_depletion_effects` identity reservation before any inventory mutation.
9. `BR-POS-001` — completed orders remain immutable.
10. Depletion executes **within the order's transaction** (`NFR-PERF-006`, normative).

### 29.8 Tests required

| Test | Asserts |
|---|---|
| Movement concurrency (**new**) | Two simultaneous `MovementsService.post` on one `(item, location)` — real barrier — leave `stock_levels == fold(stock_movements)` |
| Exact-decimal precision (**new**) | 10,000 movements at 6 dp; `stock_levels` matches the exact decimal fold with zero drift |
| Transfer vs sale (**new**) | Concurrent transfer-out and sale depletion converge to the serial-equivalent result |
| Count vs sale (**new**, `CT-08`) | Count variance excludes concurrent sales |
| Waste vs sale (**new**) | No lost update |
| Two receipts (**new**) | No lost update; weighted average correct |
| Deadlock probe (**new**) | Completion path and `MovementsService.post` cannot invert lock order |
| `balance_after` truthfulness (**new**) | Every movement's `balance_after` equals the running fold in deterministic order — **the guard against `A1-3` cheating** |
| NFR-PERF-006 benchmark (**existing**) | Isolated scratch DB, ≥ 20 iterations, report p50 and p95 |
| Full regression | 815 unit + 64 e2e suites, no regressions |

### 29.9 Acceptance criteria

**Correctness (`A1-1`) — all must hold:**
- Two concurrent movements on one `(item, location)` never lose an update.
- `stock_levels == fold(stock_movements)` exactly at 6 dp after any concurrent workload.
- No IEEE-754 arithmetic remains on any quantity path.
- Every `balance_after` is the true running fold.
- Zero regressions across the full suite.

**Performance (`A1-2` + `A1-3`):**
- **`p95 ≤ 200 ms`** on the 30-line nested-recipe / mixed-costing / multi-batch-FIFO / modifier
  fixture, measured on an isolated scratch DB with ≥ 20 iterations, warm-up excluded.
- **Pass ONLY if the measured p95 ≤ 200 ms.** Report p50 and p95 regardless. Do not tune the test
  to pass.

**Concurrency:** all seven new races green with real barriers, three clean runs each.

### 29.10 Design gate: REQUIRED

**Yes, for `A1-3` — mandatory. `A1-1` and `A1-2` may proceed without one.**

`A1-3` directly contradicts the P1F2E-A controlling design's mandated **three-sequential-statements-per-allocation** discipline, which was ratified specifically to protect
`BR-INV-003`. That discipline cannot be set aside by an implementation task.

The gate must answer one question: **can set-oriented writes preserve per-movement
`balance_after` truthfulness?** The audit's analysis says yes, and the proposed mechanism is:

- One `INSERT … SELECT` for all movements of a given `(stock_item, location)`, with
  `balance_after` computed by a **window function** — the starting balance minus the running
  `SUM(quantity) OVER (ORDER BY <deterministic key> ROWS UNBOUNDED PRECEDING)` — over the same
  deterministic order the sequential loop would have used.
- One atomic `stock_levels` upsert per distinct `(stock_item, location)`, not per allocation.
- One multi-row `INSERT` each for effects and allocations.
- One `UPDATE … FROM (VALUES …)` for physical batch decrements and one for FIFO cost consumption.

This preserves every intermediate `balance_after` value **exactly** — the window function computes
the identical running fold — while reducing round trips from **≈ 1,050 to ≈ 25**.

**Why the gate is not optional:** `A1-2` alone (lock grouping, the brief's candidate) removes only
~173 of ~1,050 statements — about **16%**, landing near **370 ms**. It **cannot** reach 200 ms.
The audit states this plainly rather than allowing `A1-2` to be attempted and found insufficient:
**a second optimization layer is required, and it needs authority `A1-2` does not.**

---

## 30. Residual risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **Section-level classification granularity.** 226 rows classified `DOMAIN` and 256 `MODULE`. Where a section contains partial implementation, every requirement in it inherits `PARTIAL` — visible as Inventory's 0 `NOT IMPLEMENTED`. | `PARTIAL` counts are an **upper bound on implementation**; the true per-requirement figure is worse | The `evidence_basis` column marks every such row. Each lane's own design gate must refine its `MODULE`/`DOMAIN` rows to `DIRECT` before claiming completion |
| 2 | **`FR-PLT-041` is cited in source as authority for the outbox but is a dangling SRS reference** | An architectural obligation may rest on a specification that does not exist | `B2-3` opens with a governance question |
| 3 | **`CT-01` needs 72 hours of elapsed time** — 75% of the programme | Cannot complete if started at the final gate | Launch during Wave 4; treat as a fixed date |
| 4 | **External certification lead times exceed the 4-day window** | Wave 4 discovers unsatisfiable dependencies | Begin procurement day 1 (§27.1) |
| 5 | **Partition horizon (~2027-09) with no auto-creation** | Latent SEV-1: all sales stop | `G4-4`; consider an interim manual extension in Wave 1 |
| 6 | **`tsc --noEmit` reports 1 pre-existing error** (`access-token.service.spec.ts:28` — `TS2322`, a spec file) | Typecheck is not clean; masks new errors | Fix in `G1-1` so CI can gate on a clean typecheck. **Not called clean in this report** |
| 7 | **21 `KNOWN_DEVIATIONS` in `module-boundaries.spec.ts`** | Boundary erosion under 7 parallel lanes | Freeze the list; additions require justification in the slice's report |
| 8 | **`organisation.e2e-spec.ts` whole-database invariant fails under cross-suite accumulation** | Non-deterministic CI once `G1-1` lands | `G1-2` fixes the root cause |
| 9 | **`float` arithmetic persists in `costing.ts` helpers** (flagged in a prior report, confirmed at HEAD) | Money/quantity precision beyond `A1-1`'s scope | Audit in `A1-1`; extend scope if it touches money |
| 10 | **Seven parallel lanes against one `schema.prisma`** | Merge conflicts and lost migrations | Schema steward + migration-slot registry (§22) |
| 11 | **`stock_batches.supplier_id` / `goods_receipt_id` are dangling UUIDs** | `E3-1`/`E3-3` may adopt an unvalidated shape | Design gate before `E3-1` |
| 12 | **Arabic search normalisation (`FR-POS-012`) exists on neither side** | A spec'd *system* behaviour with no owner | Assign to Lane C with shared conformance vectors (`CT-06`) |
| 13 | **The approval runtime is built but wired to nothing** | Investment risks divergence from its first real consumer (`C2-1`) | Validate the runtime against `C2-1`'s actual needs before extending it |
| 14 | **This audit re-benchmarked NFR-PERF-006 but not `NFR-PERF-005`, `030`, `031`** | Other perf classifications rest on inspection, not measurement | Marked `UNMEASURED`, never `VERIFIED`. Measure once `G1-3` lands |

---

## 31. Unresolved governance / spec issues

| # | Issue | Status | Blocks |
|---|---|---|---|
| 1 | **D-2 (PIN / branch-scoped RBAC): CORE ONLY, RATIFIED 2026-08-17.** The 2026-08-19 amendment lifted the defer for exactly four PIN-related items; **branch-scoped RBAC (`FR-SEC-002`) remains deferred**, and `FR-SEC-032` is recorded as knowingly unmet | **RATIFIED, blocking** | `B1-1`, `B1-2`, `B1-3`, all of Lane B Wave 1 |
| 2 | **D-16 (canonical `request_type` enumeration): OPEN — "MUST REMAIN OPEN. DO NOT RATIFY."** | **OPEN by instruction** | `C2-1` discount approvals, `E3-2` PO approvals |
| 3 | **D-12 (escalation semantics): never ratified** | **UNRATIFIED** | `FR-SEC-034` |
| 4 | **D-14 (governance API surface): RATIFIED A-1 — no HTTP surface in Phase 1** | **RATIFIED, blocking** | The approval runtime is unreachable by any client |
| 5 | **D-9 (RLS / tenant isolation): DELETE left unresolved** | **PARTIALLY RATIFIED** | Tenant termination/purge (`FR-PLT-023`) |
| 6 | **SIG-01** — the SRS's own headline count (612/148) contradicts its content (561/74) | **UNRESOLVED SPEC DEFECT** | Any completeness percentage quoted against the headline |
| 7 | **SIG-02** — four dangling references (`FR-INT-020`, `FR-PLT-041`, `FR-RPT-055`, `FR-SEC-018`) plus the overshooting `FR-AUD-001..026` | **UNRESOLVED SPEC DEFECT** | `B2-3` (outbox authority); any 100% traceability claim |
| 8 | **SIG-03** — Chapter 30, Chapter 31, Appendix B, Appendix C referenced and absent | **UNRESOLVED SPEC DEFECT** | **`FR-QA-002` is unsatisfiable as written**; `FR-SEC-010/012` have no permission catalogue |
| 9 | **SIG-04** — §19.3 report catalogue defines no traceable identifiers | **UNRESOLVED SPEC DEFECT** | Report-catalogue traceability (`G3-5`) |
| 10 | **Permission catalogue provenance.** The 40 codes were authored from SRS prose because Appendix C is absent — recorded in `permissions.constants.ts` itself | **UNRESOLVED** | Any claim that the permission model matches the SRS |
| 11 | **The 4-day deadline has no SRS roadmap to sequence against** (Chapter 30 absent) | **UNRESOLVED** | The plan in this report is derived from dependency analysis alone |

**None of these were resolved, reinterpreted or silently worked around by this audit.**

---

## 32. Files written

| File | Description |
|---|---|
| `docs/reports/claude/2026-09-02_FULL-SRS-current-head-traceability-rebase.md` | This report |
| `docs/reports/claude/2026-09-02_FULL-SRS-current-head-traceability.csv` | Canonical ledger — **733 rows**, one per defined requirement, 30 columns |
| `docs/reports/claude/2026-09-02_FULL-SRS-4day-execution-board.csv` | Execution board — **60 slices**, 21 columns |
| `docs/reports/claude/INDEX.md` | One row appended (repository convention) |

**No other repository file was created, modified or deleted.**
No product code · no schema · no migration · no route · no permission · no governance decision ·
no test.
The 4 pre-existing untracked files are preserved byte-for-byte.
**No commit. No push. No deployment.**

---

## 33. Verification executed

Every result below was executed live in this session. Nothing is cited from a previous run.

| Check | Result |
|---|---|
| `git status --short --untracked-files=all` (**initial baseline**, before this audit wrote anything) | 4 pre-existing untracked files; no tracked modification at that moment |
| `git status --short --untracked-files=all` (**final post-audit state**) | The same 4 pre-existing untracked files, byte-for-byte unchanged; 3 newly created P0 artifacts; **exactly one tracked modification — `docs/reports/claude/INDEX.md`, one append-only report-index row** (`1 file changed, 1 insertion(+)`) |
| `git rev-parse HEAD` | `088719307bbb173150cac7971705f15fc36b32e6` ✓ |
| `git rev-parse HEAD^` | `ec616a0e44b679a83203e01d118cd813997d2170` ✓ |
| `git show --stat HEAD` | 2 files, both docs, 961 insertions ✓ documentation-only |
| `git log -20 --oneline` | 10-commit accepted chain confirmed |
| `git log -- <depletion path>` | Last touched at `bfe7e69`; **11 later commits touch none of it** |
| `git diff --check` | **clean** |
| `npx prisma validate` | **valid** |
| `npx tsc --noEmit` | **1 pre-existing error** (`access-token.service.spec.ts:28`, `TS2322`), **zero new** — explicitly not called clean |
| `npx jest` (full unit suite) | **815 / 815 passed, 60 suites** |
| `npx jest module-boundaries` | **45 / 45 passed**, 21 `KNOWN_DEVIATIONS` unchanged |
| `prisma migrate deploy` on a fresh scratch DB | **35 / 35 applied clean from zero** |
| **`order-completion-performance.e2e-spec.ts`** (isolated scratch DB, no competing workload, 20 iterations) | **p50 = 440.44 ms · p95 = 568.73 ms · min = 375.80 ms · max = 604.22 ms** vs ≤ 200 ms target — **FAIL** |
| Persistent `ros` dev DB | **NOT MUTATED** — `_prisma_migrations` verified at 35 rows before and after |
| SRS extraction | 161 pages, per-page; 737 identifiers; 733 definitions; 4 dangling |
| RLS coverage audit | 84 / 92 tables ENABLE+FORCE; 306 policies; 8 exempt, all tenant-agnostic |
| Route surface audit | 152 operations / 112 paths, OpenAPI 3.1.0, enumerated per controller |
| Permission catalogue audit | 40 codes across 9 modules |
| CI/IaC search | **zero** `.github`, workflow, `Dockerfile` or IaC files repository-wide |
| Absent-model search | 18 domain models confirmed absent (exact + fuzzy) |

**Deliberately not run**, with reasons: the full e2e suite (would not settle any disputed
classification, and the brief forbids ceremony runs); benchmarks for `NFR-PERF-005/010/011/030/031`
(no measurement substrate exists — they are correctly `UNMEASURED`, not falsely `VERIFIED`); any
write against the persistent development database.

**Scratch database `ros_p0rebase_1788307908` was created for the benchmark and is disposable.**

---

*End of report. Non-authoritative evidence. The SRS and ratified governance decisions remain
authoritative.*
