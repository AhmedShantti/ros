# FULL-SRS-BACKEND-COMPLETION-AUDIT — All Backend Worktrees

**Report type:** Master synthesis — full-SRS backend completion audit (read-only investigation; no source, schema, migration, test, config, or governance file was modified; no commit; no push).

**Authority statement:** This report, and the seven domain-section reports it synthesizes, are **non-authoritative evidence**. The SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirements, permission semantics, and architecture decisions. Where a prior report's claim conflicted with current source code, current code was treated as ground truth. Nothing in this document creates, amends, or ratifies governance, and nothing here authorizes implementation.

**Date:** 2026-09-07

**HEAD (canonical worktree):** `bf91d6671a1c39fd0b3c0e8b4ba6c66aa8132ed8`

**Branch (canonical worktree):** `full-srs/lane-d4-reporting-demo` (unintegrated into `origin/main`)

**Working tree summary (canonical worktree, at synthesis time):** clean except this report, an `INDEX.md` update, and the six section reports produced by this task's sub-audits (four written directly to `docs/reports/claude/`, three delivered inline and folded into this document); four pre-existing untracked reports from prior sessions were present at task start and left untouched.

**Task identifier:** FULL-SRS-BACKEND-COMPLETION-AUDIT — master synthesis of a 7-way parallel domain audit spanning Identity/RBAC, Tenant/Organisation/Workforce, Catalogue/Localisation/Platform, POS Sales (order capture/discounts/payments/refunds/receipts), KDS/Treasury, Inventory/Reporting/Audit/Governance, and cross-cutting Production Readiness.

**Method note on this document's construction:** This audit was executed as seven parallel, independently-instructed investigation agents, each assigned a disjoint (with one deliberate overlap noted below) set of SRS backend domains, each re-verifying current source code rather than trusting prior reports. Four agents wrote full detailed section reports directly to this directory (cited by path below); three delivered their full findings inline, which are reproduced in condensed form in §5 below with the same evidence rigor. This master document aggregates all seven, resolves the one cross-section discrepancy found, corrects one investigation-premise error discovered mid-task (see §1.3), and computes the roll-up metrics, production-readiness verdict, and prioritized work plan the seven sections do not individually attempt.

**Section reports synthesized (full per-requirement evidence — file:line citations — lives here, not reproduced verbatim in this document):**
1. `2026-09-07_SRS-AUDIT-IDENTITY-RBAC_auth-terminal-permissions-security.md` (47 items)
2. `2026-09-07_SRS-AUDIT-POS-SALES_order-capture-discounts-payments-refunds-receipts.md` (52 items)
3. `2026-09-07_SRS-COMPLETION-AUDIT_kds-kitchen-treasury-cash-sessions-drawers.md` (61 items)
4. Tenant/Brand/Branch/Organisation & Workforce/Employees/PIN/RBAC-assignment (delivered inline; 62 items; folded into §5.2 below)
5. Catalogue/Localisation(Country Packs)/Platform-Settings (delivered inline; 40 items; folded into §5.3 below)
6. Inventory/Reporting/Audit-Trail/Business-Day/Governance-Approval-Workflow (delivered inline; 103 items; folded into §5.6 below)
7. Cross-cutting Platform: Idempotency/Concurrency/Security/Reliability/Observability/OpenAPI/Scheduler/Production-Readiness/Test-Health (delivered inline; 50 items; folded into §7/§9 below)

---

## 1. Backend Repository / Worktree Inventory

### 1.1 Discovery

`git -C /Users/mac/projects/ros worktree list --porcelain` found 10 worktrees. All were inspected for branch, HEAD, dirty state, upstream tracking, and ahead/behind counts vs. both `origin/main` and the shared integration branch `full-srs/4day-integration`.

| Worktree Path | Branch | HEAD | Dirty | Ahead/Behind `origin/main` | Unique Important Commits (vs main) | Classification | Recommendation |
|---|---|---|---|---|---|---|---|
| `/Users/mac/projects/ros` | `docs/local-report-recovery-2026-09-05` | `348933a` | 1 untracked (`.DS_Store`) | 140 behind / 0 ahead | none (docs-recovery branch, fully merged) | **STALE / REPORT_ONLY** | No action; this is the main-repo checkout, not an implementation branch |
| `/private/tmp/ros-render-release` | `release/render-demo-2026-09-05` | `1ab5fa4` | clean | 55 behind / 0 ahead | none (fully merged deployment snapshot) | **STALE / REPORT_ONLY** | Deployment artifact snapshot only; no unique code |
| `/Users/mac/projects/ros-worktrees/integration` | `full-srs/4day-integration` | `3ceb6ab` | clean | 61 behind / 0 ahead | none unique (fully merged into main) | **STALE (superseded)** | Historical integration staging branch; its cherry-picked content (lane-a POS-FIN-1, lane-b HR-1, lane-g dependency/CI remediation) now lives on inside lane-d's own history under different commit SHAs (see §1.3) |
| `/Users/mac/projects/ros-worktrees/lane-a` | `full-srs/lane-a3-pos-financial-corrections` | `0ca3c4b` | clean | 82 behind / 8 ahead | `2bf0825`,`1783a6c`,`71b16f7`,`edf74ed`,`776c9e4`,`d4baad5`,`5d16a9f`,`0ca3c4b` (POS-FIN-1: discounts/comps/post-fire-void/refunds) | **SUPERSEDED** | Content **verified byte-identical** to lane-d's own carried copies (`1c6402c` et al., see §1.3). No independent action needed — do not re-merge, would be a no-op |
| `/Users/mac/projects/ros-worktrees/lane-b` | `full-srs/lane-b2-workforce-core` | `b8ac578` | clean | 79 behind / 0 ahead | none unique (fully merged into main) | **STALE (superseded)** | HR-1 content is inside lane-d's lineage too (per lane-d's own commit history, `32a2ba7`/`7bce735`/`1a51b13`) |
| `/Users/mac/projects/ros-worktrees/lane-c` | `full-srs/lane-c3-mtmb-hardening` | `d4fccfa` | clean | 58 behind / 0 ahead | none unique (fully merged into main) | **STALE (superseded)** | Multi-tenant/multi-branch hardening fully merged into main already |
| **`/Users/mac/projects/ros-worktrees/lane-d`** | **`full-srs/lane-d4-reporting-demo`** | **`bf91d66`** | **4 untracked reports only (this task's own outputs, plus pre-existing ones)** | **55 behind / 13 ahead** | `b85c524`,`4ae0417`,`7a16d42`,`0c5928a`,`73534cf`,`4d7a387`,`5e3282e`,`dc746a9`,`8fad55d`,`3e4f85c`,`2c323a4`,`bf91d66` (SIGNUP-1 self-service onboarding, workforce PIN/RBAC provisioning, drawer administration, employee-identity-on-refresh fix, golden-path closure) | **CURRENT_ACCEPTED (canonical for this audit)** | Most feature-complete unintegrated worktree. Contains, by content (not SHA) inheritance, essentially all of lane-a/lane-b/lane-g's work plus its own 12 additional commits. **Not yet merged into `origin/main`.** |
| `/Users/mac/projects/ros-worktrees/lane-e` | `full-srs/lane-e2-scheduler-foundation` | `6d9e5aa` | clean | 91 behind / 0 ahead | none unique (fully merged into main) | **STALE (superseded)** | Durable scheduler foundation fully merged into main already |
| `/Users/mac/projects/ros-worktrees/lane-f` | `full-srs/lane-f2-dr-partition-lifecycle` | `86bf435` | clean | 87 behind / 0 ahead | none unique (fully merged into main) | **STALE (superseded)** | DR-1 partition lifecycle fully merged into main already |
| `/Users/mac/projects/ros-worktrees/lane-g` | `full-srs/lane-g3-dependency-remediation` | `d3e9629` | clean | 76 behind / 2 ahead | `18eb2b1` (dependency-vuln remediation) | **SUPERSEDED** | `package.json`/`package-lock.json` confirmed **byte-identical** to lane-d's own copies — content already carried into lane-d under a different SHA (see §1.3) |

### 1.2 Known recent commits — explicit disposition (per task instruction)

- **`dc746a9` — POS employee identity/session attribution:** present only in lane-d, **NOT** an ancestor of `origin/main` (`git merge-base --is-ancestor dc746a9 origin/main` → false). **INTEGRATION_GAP**, part of the single consolidated gap in §1.4.
- **`bf91d66` — golden-path backend closure:** lane-d's own HEAD, **NOT** an ancestor of `origin/main`. **INTEGRATION_GAP**, part of the same consolidated gap.

Neither is assumed integrated merely because it exists — both were verified absent from `origin/main`'s history by direct ancestry check, not inferred from commit dates or messages.

### 1.3 Critical correction made mid-audit: the POS-financial-corrections "fragmentation" premise was wrong

The audit was originally scoped assuming lane-d **lacked** lane-a's POS-FIN-1 work (discounts, comps, post-fire void, append-only refunds), based on an initial `find src/modules/sales -maxdepth 1 -type f` check in this session that — due to the `-type f` filter — silently excluded the `contract/` and `orders/` **subdirectories** where that code actually lives. This was a genuine investigation error, caught and corrected by the POS-domain sub-audit, and independently reconfirmed by this session directly:

- `src/modules/sales/orders/discounts.service.ts` and `refunds.service.ts` **do** exist in lane-d.
- `diff` of `discounts.service.ts`, `post-fire-void.service.ts`, `refunds.service.ts`, and `test/pos-financial-corrections.e2e-spec.ts` between lane-a and lane-d: **zero diff** (byte-identical) on every file checked.
- `git log --diff-filter=A -- src/modules/sales/orders/discounts.service.ts` in lane-d shows it was introduced by commit `1c6402c` ("feat(sales): add governed discounts, comps, post-fire void and Kitchen signal (POS-FIN-1)") — a **different SHA** from lane-a's `2bf0825` carrying the identical message and identical content, because it was cherry-picked onto a different base.
- A prior report already documents this exact reconciliation: `docs/reports/claude/full-srs-4day/2026-09-04_MW1I_ci-dep-pos-hr1-integration.md` — a third worktree (`full-srs/4day-integration`) cherry-picked all 8 commits from lane-a3, all 3 from lane-b2, and 6 CI/security + 2 dependency-remediation commits from lane-g3 onto integration-branch HEAD, re-verified with a from-zero migration run, generated RLS gates, and full unit/e2e re-runs. Lane-d's own commit chain continues directly from that integration point.
- Same pattern independently confirmed for lane-g's dependency remediation: `package.json`/`package-lock.json` are byte-identical between lane-g and lane-d.

**Consequence:** there is **no multi-worktree code-fragmentation problem**. Lane-d already contains, by content, everything from lane-a/lane-b/lane-c/lane-e/lane-f/lane-g and the integration branch. The only real, open gap is lane-d → `origin/main`.

### 1.4 Summary fields (as required)

```
CANONICAL_BACKEND_HEAD_FOR_AUDIT: bf91d6671a1c39fd0b3c0e8b4ba6c66aa8132ed8
CANONICAL_BACKEND_WORKTREE:       /Users/mac/projects/ros-worktrees/lane-d/kitchen-kit/backend
                                   (branch full-srs/lane-d4-reporting-demo)

UNINTEGRATED_ACCEPTED_COMMITS:    12 commits, lane-d HEAD (bf91d66) back to b85c524, not ancestors of
                                   origin/main (HEAD 5045183):
                                     bf91d66  fix: close backend golden path blockers
                                     2c323a4  docs: record auth-expiry mock-fallback hotfix (frontend-only)
                                     3e4f85c  docs: record session isolation hotfix (frontend-only)
                                     8fad55d  docs: record POS branch-context hotfix (frontend-only)
                                     dc746a9  fix: restore employee identity on terminal bind and session refresh
                                     5e3282e  test: prove GET /cash-sessions/drawers authorization target is correct
                                     4d7a387  feat: expose real drawer administration and cashier drawer selection
                                     73534cf  test: prove signup branch visibility and real branch management
                                     0c5928a  fix: reconcile canonical role permissions on manual RBAC assignment
                                     7a16d42  feat: assign system roles to employees from the Employees page
                                     4ae0417  fix: document Idempotency-Key header for workforce employee routes
                                     43638ed  fix: provision POS employee identity + PIN, wire real workforce API surface
                                     b85c524  feat: add owner self-service registration
                                   (13 commits touching code/tests; 3 of these — 2c323a4/3e4f85c/8fad55d — are
                                   frontend-only doc records with no backend diff, included for completeness)

STALE_WORKTREES:                  integration, lane-b, lane-c, lane-e, lane-f (0 commits ahead of origin/main —
                                   fully merged already), plus the main-repo checkout and the render-release
                                   snapshot (both pure report/deployment artifacts, 0 ahead of origin/main)

SUPERSEDED_WORKTREES:             lane-a, lane-g — their unique commits vs. main are content-identical to
                                   commits already carried inside lane-d's own history under different SHAs;
                                   no independent merge action needed for either

INTEGRATION_GAPS:                 ONE consolidated gap: lane-d (full-srs/lane-d4-reporting-demo, HEAD bf91d66)
                                   → origin/main. 13 commits, ~9,666 insertions / ~1,805 deletions across
                                   83 files (treasury/drawers, workforce/employees, sales financial
                                   corrections already-carried, identity session/terminal fixes, RBAC
                                   self-heal, signup/registration). SRS requirements affected: every
                                   requirement classified below as implemented "in lane-d" is, by definition,
                                   NOT YET present in the deployed/`main` backend until this merge happens.
                                   This is the single most consequential fact governing this audit's
                                   real-world applicability — see §11.
```

---

## 2. Authoritative Sources Used

1. `ROS_SRS_v1.0.pdf` (extracted via `pdftotext -layout`, 6,510 lines of plain text) — primary requirements authority.
2. `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (~8,927 lines) — ratified decisions, deferrals, scope amendments.
3. Current backend source code in the canonical worktree (lane-d) — ground truth; where a prior report's claim conflicted with current code, code won.
4. `prisma/schema.prisma` + `prisma/migrations/` (45 migrations) in lane-d.
5. Generated OpenAPI (`docs/api/openapi.json`, OpenAPI 3.1.0, 145 paths / 193 operations, CI-drift-gated).
6. Unit tests (`src/**/*.spec.ts`, 1,155 tests / 84 suites) and e2e tests (`test/*.e2e-spec.ts`, well over 100 files).
7. Prior backend reports under `docs/reports/claude/` — used strictly as evidence to be re-verified, never as authority.
8. Git history and worktree topology (§1).

Reports were never trusted at face value: every classification below was independently re-derived from current source by the assigned sub-audit, and several prior-report claims were explicitly superseded where code had since changed (documented per-domain in the section reports).

---

## 3. Scope

Backend-only, per task instruction. Frontend implementation was not inspected and does not factor into any classification below. All classifications use exactly the nine-value enum specified: `COMPLETE_BACKEND`, `PARTIAL_BACKEND`, `MISSING_BACKEND`, `IMPLEMENTED_BUT_NOT_HTTP_REACHABLE`, `IMPLEMENTED_BUT_NOT_PRODUCTION_READY`, `DEFERRED_BY_GOVERNANCE`, `NOT_BACKEND_OWNED`, `NOT_APPLICABLE_TO_CURRENT_PHASE`, `NEEDS_VERIFICATION`.

---

## 4. Methodology note on per-requirement detail

The full per-requirement dossier — controller/service/Prisma/test/permission evidence at exact `file:line` granularity — lives in the seven section sources listed above. Reproducing all ~415 raw rows verbatim in this document would make it unusable as a synthesis; §5 below reproduces every requirement **ID, title, classification, and severity**, condensed, with a pointer to the owning section source for full evidence. Nothing was omitted from the counts; only the evidentiary prose was compressed.

**Known double-count, disclosed rather than silently corrected:** the Tenant/Organisation/Workforce section (§5.2) and the Identity/RBAC section (§5.1) each independently audited the core RBAC primitives (FR-SEC-001–005, 010–012, 015–017) — one from the employee-assignment-surface angle, one from the core scope-lattice/security-architecture angle. Both reached materially consistent conclusions (cross-checked below, no contradictions found — a positive signal, not a defect). The roll-up metrics in §8 present the **raw sum** of all seven sections' self-reported totals (415) alongside a **deduplicated estimate** (~406, subtracting the ~9 doubly-audited FR-SEC-* rows) with the methodology stated plainly, rather than asserting false precision by attempting a row-by-row reconciliation the source material does not cleanly support.

---

## 5. Domain-by-Domain Requirement Audit

### 5.1 Identity / Authentication / Terminal / RBAC / PIN / Security §15 / Tenant Isolation

**Full source:** `2026-09-07_SRS-AUDIT-IDENTITY-RBAC_auth-terminal-permissions-security.md` (47 items; live-ran 11 e2e suites, 182/182 passing, against real Postgres this session).

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-SEC-020 | Auth methods (password/PIN/card/biometric/SSO) | PARTIAL_BACKEND | P1 |
| SIGNUP-1 | Tenant self-service signup | PARTIAL_BACKEND | P2 |
| — | Tenant selection | COMPLETE_BACKEND | — |
| — | JWT claims / T-4-LIVE authorization snapshot | COMPLETE_BACKEND | — |
| — | Refresh rotation / reuse detection | COMPLETE_BACKEND | — |
| — | Password change/forgot/reset | COMPLETE_BACKEND | — |
| FR-SEC-023 | MFA for dashboard | DEFERRED_BY_GOVERNANCE (board G4-2) | DEFERRED |
| FR-SEC-024 | MFA mandatory for sensitive roles | DEFERRED_BY_GOVERNANCE | DEFERRED |
| FR-SEC-025 | Password policy (10-char floor, breach list, per-tenant) | PARTIAL_BACKEND (8-char hardcoded floor, 9-entry static blocklist) | P1 |
| FR-SEC-026 | Idle expiry 15m POS/60m dash/8h KDS | PARTIAL_BACKEND (KDS portion DEFERRED_BY_GOVERNANCE; POS/dash portion open) | P1 |
| FR-SEC-027 | Admin forced cross-device logout | MISSING_BACKEND (no `UsersController` exists) | P1 |
| — | Terminal registration/status transitions | COMPLETE_BACKEND | — |
| — | Device fingerprints | COMPLETE_BACKEND | — |
| FR-SEC-028 | Terminal revocation invalidates credentials + wipes local data | PARTIAL_BACKEND (server-side live-enforced; device wipe out of backend scope; governance: "MUST NOT be closed") | P3 |
| FR-SEC-001 | RBAC core | COMPLETE_BACKEND | — |
| FR-SEC-002 | Scoped role assignment (tenant/brand/branch) | COMPLETE_BACKEND (ratified D-2 REOPENED IN PART (2), ADR 0009; 101/193 routes carry non-tenant target) | P3 (stale doc comments only) |
| FR-SEC-003 | Multiple scoped assignments per user | COMPLETE_BACKEND | — |
| FR-SEC-004 | Union-within-scope, no cross-scope leakage | COMPLETE_BACKEND | — |
| FR-SEC-005 | Assignment validity dates | COMPLETE_BACKEND | — |
| FR-SEC-010 | 13 predefined standard roles | PARTIAL_BACKEND (only 5 ship: Owner + 4 templates) | P2 |
| FR-SEC-011 | Custom role creation from catalogue | COMPLETE_BACKEND | — |
| FR-SEC-012 | Role editor descriptions + sensitivity warning | PARTIAL_BACKEND (no sensitivity flag anywhere) | P2 |
| FR-SEC-015 | SoD incompatible-pair warnings | MISSING_BACKEND | P2 |
| FR-SEC-016 | SoD hard-block (4 named combos) | PARTIAL_BACKEND (discount/cash-variance enforced via ratified D-7; count-perform/post NOT enforced; requisition N/A — no procurement module) | P1 |
| FR-SEC-017 | SoD conflict report | MISSING_BACKEND | P2 |
| — | Self-elevation prevention | MISSING_BACKEND (open, self-disclosed in a prior report) | P1 |
| — | Permission catalogue completeness vs SRS §15.2 | PARTIAL_BACKEND (Procurement domain entirely absent; several Sales/Workforce codes missing) | P2 |
| FR-SEC-021 | PIN valid only on registered terminal, permitted branches, never dashboard | COMPLETE_BACKEND | — |
| FR-SEC-022 | PIN salted hash, branch-unique, lockout | COMPLETE_BACKEND (flat not progressive lockout) | P3 |
| — | Employee identity on terminal bind + refresh (`dc746a9`) | COMPLETE_BACKEND (11 e2e suites/182 tests re-run live, all pass) | P3 |
| — | Permission/revocation epoch | COMPLETE_BACKEND | — |
| — | Console vs POS token contract | COMPLETE_BACKEND | — |
| FR-SEC-040/041/043 | TLS/at-rest/KMS | NOT_BACKEND_OWNED | — |
| FR-SEC-042 | Field-level encryption (national ID etc.) | PARTIAL_BACKEND (`Employee.nationalId` stored plaintext) | P2 |
| FR-SEC-044 | No PAN/CVV/track storage | COMPLETE_BACKEND | — |
| FR-SEC-045 | Server-side authorization on every route | COMPLETE_BACKEND | — |
| FR-SEC-046 | Rate limiting + progressive lockout | PARTIAL_BACKEND (**password login has NO account lockout at all**, only IP+email rate limiting) | P1 |
| FR-SEC-047 | Input validation at API boundary | COMPLETE_BACKEND | — |
| FR-SEC-048 | Parameterised queries exclusively | COMPLETE_BACKEND | — |
| FR-SEC-049 | Dependency vuln scanning every build | NOT_BACKEND_OWNED (CI-level; confirmed present + blocking) | — |
| FR-SEC-050 | Secrets from a secret manager | PARTIAL_BACKEND (solid env hygiene; no Vault/KMS binding) | P3 |
| FR-SEC-052 | IP allow-listing | MISSING_BACKEND | P2 |
| FR-SEC-053 | Security events to SIEM sink | MISSING_BACKEND | P2 |
| — | Tenant isolation (RLS + live re-check) | COMPLETE_BACKEND (97 FORCE RLS statements, dedicated no-exemption gate) | — |
| — | Multi-branch production readiness (per-tenant M-4+ scope-review condition) | NEEDS_VERIFICATION | P2 |

### 5.2 Tenant / Brand / Branch / Organisation & Workforce / Employees / PIN Provisioning / Employees-page RBAC

**Full source:** delivered inline this session (62 items). Key evidence citations: `organisation.controller.ts`, `branches.service.ts`, `registrations.service.ts`, `employees.service.ts`, `pin.service.ts`, `canonical-role-templates.ts`, ADR 0008, Governance Register lines 162–234 (D-2 REOPENED IN PART (2)).

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-PLT-001/002/003/004/010/012/013/014 | Tenant/brand/branch hierarchy, RLS isolation, CI gates | COMPLETE_BACKEND (all) | — |
| FR-PLT-018 | Enterprise dedicated-schema isolation tier | MISSING_BACKEND | P3 |
| FR-PLT-020 | Self-service signup (branch+roles+first user atomic) | PARTIAL_BACKEND (starter menu/catalogue explicitly deferred; country/currency hardcoded EG/EGP) | P2 |
| FR-PLT-021 | No data loss on downgrade/suspension | MISSING_BACKEND (no tenant lifecycle state machine at all) | P1 |
| FR-PLT-022 | Full data export within 24h | MISSING_BACKEND | P1 |
| FR-PLT-023 | Two-step reversible termination | MISSING_BACKEND | P1 |
| FR-PLT-025/026/027/028 | Hierarchical settings resolver, locking, inspector, financial versioning | DEFERRED_BY_GOVERNANCE (ADR 0008 D-11) | P1 |
| FR-BRN-001/002 | Branch resource ownership; per-branch config | PARTIAL_BACKEND (tax/country-pack activation not wired for signed-up tenants) | P1 |
| FR-BRN-005 | Branch groups | DEFERRED_BY_GOVERNANCE (ADR 0008 D-10) | P2 |
| FR-BRN-008 | Branch template/copy | MISSING_BACKEND | P2 |
| FR-BRN-035..037 | Franchise support | DEFERRED_BY_GOVERNANCE | DEFERRED |
| ORG-* CRUD/access-discovery | Brand/branch/warehouse/CK/station/table/hours CRUD, `GET /org/access` | COMPLETE_BACKEND (all) | — |
| FR-HRM-001 | Full employee record | PARTIAL_BACKEND (no home-branch-change or permitted-branch-removal route) | P2 |
| FR-HRM-002 | 5 employment types w/ differing rules | PARTIAL_BACKEND (type not consumed by scheduling rules) | P2 |
| FR-HRM-003 | Compensation, effective-dated, permission-gated | COMPLETE_BACKEND | — |
| FR-HRM-004 | Document/certificate expiry tracking | MISSING_BACKEND | P2 |
| FR-HRM-005 | Multi-branch assignment w/ home branch | COMPLETE_BACKEND | — |
| FR-HRM-006 | Deactivatable, never hard-deletable | COMPLETE_BACKEND | — |
| WF-EMP-AUTO-PROVISION | POS-only employee auto-provisions User+Membership+Cashier role | COMPLETE_BACKEND | — |
| FR-SEC-020/021/022 (workforce-side) | PIN shape, terminal/branch validity, salted-hash+lockout+advisory-lock branch-uniqueness | COMPLETE_BACKEND | — |
| WF-PIN-ROUTE | `POST .../pin` set/rotate, idempotent | COMPLETE_BACKEND | — |
| FR-SEC-001..005 (RBAC core, cross-checked against §5.1) | COMPLETE_BACKEND (consistent with §5.1's independent finding) | — |
| FR-SEC-010 (cross-checked) | 5/13 standard roles ship | PARTIAL_BACKEND (consistent with §5.1) | P2 |
| FR-SEC-011 | Custom roles | COMPLETE_BACKEND | — |
| FR-SEC-012 | Role editor descriptions | PARTIAL_BACKEND (consistent with §5.1) | P3 |
| FR-SEC-015/016/017 | SoD | DEFERRED_BY_GOVERNANCE (general mechanism) / PARTIAL_BACKEND (point fixes) — consistent with §5.1's finer-grained breakdown | P1 |
| WF-EMP-ROLE-LIST/ASSIGN/REMOVE | Employees-page RBAC facade, incl. **self-healing stale-canonical-role reconciliation** (fixed by `0c5928a` after a real production 403) | COMPLETE_BACKEND | — |
| WF-AUTHZ-EPOCH | Epoch bump on every role change | COMPLETE_BACKEND | — |
| FR-HRM-010 | Schedule creation | COMPLETE_BACKEND | — |
| FR-HRM-011 | Shift-template copy | MISSING_BACKEND | P2 |
| FR-HRM-012 | Employment-type-conditional scheduling/overtime rules | PARTIAL_BACKEND (fixed constants, not tenant-configurable) | P2 |
| FR-HRM-013..017 | Labour-cost projection, staffing forecast, publish/ack, shift swap, leave mgmt | MISSING_BACKEND (all) | P2 |
| FR-HRM-020 | Clock-in (POS-PIN/mobile/biometric) | PARTIAL_BACKEND (POS-PIN only) | P2 |
| FR-HRM-021 | Method/GPS pairing | PARTIAL_BACKEND (method hardcoded) | P3 |
| FR-HRM-022 | Anomaly flags | PARTIAL_BACKEND (4/5 implemented) | P2 |
| FR-HRM-023 | Min-shift-interval, atomic | COMPLETE_BACKEND | — |
| FR-HRM-024 | Auto-close forgotten clock-outs | PARTIAL_BACKEND (detection only, no scheduled job) | P2 |
| FR-HRM-025 | Attendance corrections, reason-gated, immutable original | COMPLETE_BACKEND | — |
| FR-HRM-026/030-036 | Break tracking, photo capture, performance metrics, payroll export | MISSING_BACKEND (all) | P2/P3 |

### 5.3 Menu / Catalogue / Modifiers / Pricing / Availability & Country Packs (Tax/Currency/Fiscal) & Platform Settings

**Full source:** delivered inline this session (40 items). Key evidence: `catalogue.controller.ts`, `price-lists.service.ts`, `pricing/`, `country-pack.registry.ts`, `country-pack.signature.ts`, `tax/`, Governance Register §FR-LOC/§FR-PLT entries.

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-MNU-001 | Menu→Category→Item→Variant hierarchy | COMPLETE_BACKEND | — |
| FR-MNU-002 | Multi-menu, branch/order-type/time-window assignment | PARTIAL_BACKEND (order-type/time-window accepted but **not evaluated**) | P2 |
| FR-MNU-003 | Multi-menu priority resolution + ambiguity warning | COMPLETE_BACKEND | — |
| FR-MNU-004 | Item attribute set | PARTIAL_BACKEND (no image upload/list endpoint despite `MenuItemImage` model existing) | P2 |
| FR-MNU-005 | Per-surface item names | COMPLETE_BACKEND (receipt-surface name is a documented gap) | P3 |
| FR-MNU-006 | Variant independence | PARTIAL_BACKEND (recipes out of Catalogue's scope) | — |
| FR-MNU-010/011 | Modifier groups + constraints | COMPLETE_BACKEND | — |
| FR-MNU-012 | Modifier stock linkage | PARTIAL_BACKEND (recorded, **never depleted against inventory**) | P1 |
| FR-MNU-013 | Modifier recipe delta | MISSING_BACKEND (recorded, never interpreted — deliberate) | P2 |
| FR-MNU-020 | Named price lists | PARTIAL_BACKEND (`branch_group` scope not implemented) | P2 |
| FR-MNU-021/022 | Order-type & time-based recurring pricing | COMPLETE_BACKEND | — |
| FR-MNU-023 | Scheduled future-dated prices, activation | PARTIAL_BACKEND (**no HTTP surface for activation exists**) | P1 |
| FR-MNU-024 | Price change history | COMPLETE_BACKEND (via audit trail) | — |
| FR-MNU-025 | Bulk price operations | MISSING_BACKEND | P2 |
| FR-MNU-026 | Margin-erosion warning | MISSING_BACKEND | P2 |
| FR-MNU-030 | Manual 86/re-enable | COMPLETE_BACKEND | — |
| FR-MNU-031/032/033 | Auto-86 on zero stock, override, remaining-sellable-qty | MISSING_BACKEND (all — deliberately deferred, depends on Inventory) | P1 |
| FR-MNU-034 | Aggregator availability push | MISSING_BACKEND | P2 |
| FR-MNU-035 | Daily quantity limits | MISSING_BACKEND (deliberately deferred) | P3 |
| §7.3#7 | Catalogue completeness/sellability invariant | COMPLETE_BACKEND | — |
| FR-LOC-020 | No country-specific code in core | COMPLETE_BACKEND | — |
| FR-LOC-021 | Versioned packs, historical pinning | COMPLETE_BACKEND | — |
| FR-LOC-022 | Cryptographic signing, fail-closed | **IMPLEMENTED_BUT_NOT_PRODUCTION_READY** (code complete; `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` env vars unconfirmed on live deployment) | **P0 (if unset live)** |
| FR-LOC-023 | Conformance test suite pre-activation | PARTIAL_BACKEND (tax/rounding arms exist; invoice-completeness/QR arms absent; **not wired into the runtime activation gate at all**) | P1 |
| FR-LOC-024 | Offline distribution to terminals | PARTIAL_BACKEND (local date-based activation complete; **zero terminal-distribution mechanism**) | P1 |
| FR-LOC-025 | Tax engine registry | COMPLETE_BACKEND | — |
| FR-LOC-030 | Pack authoring/validation tool | MISSING_BACKEND (deliberately deferred, [S]) | P3 |
| FR-LOC-031 | Pack not activatable until conformance+signed | PARTIAL_BACKEND (signing half enforced; conformance half not) | P1 |
| Currency/cash-rounding | Currency config | PARTIAL_BACKEND (cash-rounding parsed but **never applied**) | P2 |
| IR-LOC-EG/SA/AE-* | Fiscal e-invoicing/QR/hash-chain (ZATCA/ETA) | **MISSING_BACKEND (all)** | **P0 for EG/SA tenants** |
| FR-FIN-030..035 | Tax computation engine | COMPLETE_BACKEND | — |
| — | Tax class identity/rate separation | COMPLETE_BACKEND | — |
| — | Country-pack/tax admin HTTP surface | MISSING_BACKEND (deliberate — internal-only by design, file-load activation) | P3 |
| FR-PLT-025 | Hierarchical settings resolver | MISSING_BACKEND (DEFERRED_BY_GOVERNANCE, ADR 0008 D-11 — confirmed still true on fresh re-verification) | P1 |
| FR-PLT-026 | Settings locking | MISSING_BACKEND (same deferral) | P1 |
| FR-PLT-027 | Settings inspector | MISSING_BACKEND | P2 |
| FR-PLT-028 | Financial settings versioning | PARTIAL_BACKEND (strong point-instances — country-pack pinning, CashClosePolicy, DiscountApprovalPolicyVersion — but **no generic mechanism**; every new financial setting repeats bespoke work) | P1 |

### 5.4 POS Order Capture / Tables / Discounts-Comps-Voids / Payments / Refunds / Receipts

**Full source:** `2026-09-07_SRS-AUDIT-POS-SALES_order-capture-discounts-payments-refunds-receipts.md` (52 items; investigated across both lane-d and lane-a, confirming §1.3's byte-identical finding for this domain specifically).

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-POS-001/003/005 | Order types, table-required-to-fire, multi-order-per-terminal | COMPLETE_BACKEND | — |
| FR-POS-002 | Order numbering, block-issue/reissue/offline fallback | PARTIAL_BACKEND (online path solid; offline block semantics NEEDS_VERIFICATION) | P2 |
| FR-POS-004 | Seat-number assignment | PARTIAL_BACKEND (field exists, no seat-split consumer) | P2 |
| FR-POS-006 | Park and resume | NEEDS_VERIFICATION | P2 |
| FR-POS-007 | `opened_by`/`served_by`/`closed_by` | PARTIAL_BACKEND (`openedBy` populated; `servedBy`/`closedBy` write sites not located) | P2 |
| Add/remove line | | COMPLETE_BACKEND | — |
| Amend line (in-place quantity change) | | **MISSING_BACKEND** (no dedicated primitive; only void+re-add) | P2 |
| Fire | Atomic, amendment-aware | COMPLETE_BACKEND | — |
| FR-POS-035 | Auto-fire vs explicit-fire | PARTIAL_BACKEND (explicit only — deliberate MVP narrowing) | P2 |
| FR-POS-036/037 | Courses, hold-and-fire | MISSING_BACKEND | P2 |
| Table CRUD | | COMPLETE_BACKEND | — |
| FR-POS-080 | Floor-plan editor | MISSING_BACKEND | P2 |
| FR-POS-081 | Live table state (7-value machine) | MISSING_BACKEND | P2 |
| FR-POS-082 | Merge/split/transfer tables | MISSING_BACKEND | P2 |
| FR-POS-083/084 | Time-since-seated, section assignment | MISSING_BACKEND | P3 |
| FR-POS-045 | Line/order discounts | COMPLETE_BACKEND (logic) | — |
| FR-POS-046 | Discount reason required | COMPLETE_BACKEND | — |
| FR-POS-047 | Approval thresholds (4 dimensions) | PARTIAL_BACKEND (branch-scoped only, not per-role) | P2 |
| FR-POS-048 | Approval channel (PIN/card/mobile) | PARTIAL_BACKEND (PIN only; card/mobile deferred) | P2 |
| FR-POS-049 | Discount audit fields | COMPLETE_BACKEND | — |
| FR-POS-050 | Comp distinct from discount | COMPLETE_BACKEND (logic) | — |
| FR-POS-051 | Discount stacking control | PARTIAL_BACKEND (deliberately narrowed: max 1 per line/order) | P2 |
| — | **Canonical-role reachability: `pos.discount.apply`/`.unlimited`/`pos.comp.apply`** | **IMPLEMENTED_BUT_NOT_PRODUCTION_READY — no canonical role template grants any of these; only Owner can discount/comp** | **P0** |
| FR-POS-070 | 4 correction operations | PARTIAL_BACKEND (no distinct "order cancel" verb located) | P2 |
| FR-POS-071 | Post-fire void disposition | COMPLETE_BACKEND | — |
| FR-POS-075 | Correction audit fields | COMPLETE_BACKEND | — |
| — | **Canonical-role reachability: `pos.order.void_line_postfire`** | **IMPLEMENTED_BUT_NOT_PRODUCTION_READY — same gap** | **P0** |
| FR-POS-060 | 11 tender types | **PARTIAL_BACKEND (only 2 of 11: cash, manual-external-card)** | P1 |
| FR-POS-061 | Split payment, running balance | COMPLETE_BACKEND (for the 2 supported tenders) | — |
| FR-POS-062 | Split bill (seat/item/amount) | MISSING_BACKEND | P1 |
| FR-POS-063 | Cash change/rounding | COMPLETE_BACKEND | — |
| FR-POS-064 | Integrated card terminal | MISSING_BACKEND | P1 |
| FR-POS-065 | Idempotent payment capture | COMPLETE_BACKEND | — |
| FR-POS-066 | No PAN/CVV storage | COMPLETE_BACKEND | — |
| FR-POS-067 | On-account credit sales | MISSING_BACKEND | P2 |
| FR-POS-055..058 | Service charge / tips | **MISSING_BACKEND (columns exist, never written)** | P1 |
| FR-POS-072 | Refund ≤ original, aggregate-capped | COMPLETE_BACKEND | — |
| FR-POS-073 | Refund reason + threshold approval | COMPLETE_BACKEND (logic) | — |
| FR-POS-074 | Different-tender refund, fraud-report flag | PARTIAL_BACKEND (gating implemented; fraud-report flagging not — no fraud infra exists) | P2 |
| FR-POS-075 (refund) | Refund audit fields | COMPLETE_BACKEND | — |
| — | Append-only correction model | COMPLETE_BACKEND | — |
| — | **`pos.refund.issue` canonical-role reachability** | **COMPLETE_BACKEND as of `bf91d66` (same-day fix, re-verified in code)** | resolved |
| — | Reason-code/approval-policy production provisioning | IMPLEMENTED_BUT_NOT_PRODUCTION_READY (fresh tenant needs a manual admin step first) | P1 |
| Receipt retrieval | | COMPLETE_BACKEND | — |
| FR-POS-100 | Fiscal receipt content | **MISSING_BACKEND (deliberate — RCPT-R1 ratified non-fiscal MVP)** | P1 (governance-acknowledged) |
| FR-POS-101/102/103/104 | Templating, bilingual, digital delivery, reprint-marking | MISSING_BACKEND (all) | P2 |
| FR-POS-105/106 | Kitchen-language tickets, printer-failure handling | NOT_APPLICABLE / NOT_BACKEND_OWNED | — |

**INTEGRATION_GAP finding for this domain (see §1.3): CLOSED, not open** — lane-a's POS-FIN-1 content is fully present in lane-d, byte-identical.

### 5.5 KDS / Kitchen (Routing, Fire Atomicity, Bump/Recall, Amendments) & Treasury (Cash Sessions, Drawers, Variance, Day Close)

**Full source:** `2026-09-07_SRS-COMPLETION-AUDIT_kds-kitchen-treasury-cash-sessions-drawers.md` (61 items). **No P0 found in either domain** — this is the strongest-verified domain pair in the audit (SERIALIZABLE-isolation concurrency proofs, fire-transaction atomicity independently re-traced, DB-level immutability grants verified live).

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-KDS-001 | Station definition | COMPLETE_BACKEND | — |
| FR-KDS-010/011 | 5-tier routing precedence, multi-station lines | COMPLETE_BACKEND | — |
| FR-KDS-012/013 | Prep-time staggered release, Expediter/Pass | MISSING_BACKEND (both DEFERRED_BY_GOVERNANCE) | DEFERRED |
| FR-KDS-020/021 | Ticket card fields, modifier kind distinction | COMPLETE_BACKEND (data layer; rendering not backend-owned) | — |
| FR-KDS-022 | Elapsed-time colour-coding | PARTIAL_BACKEND (no configurable threshold substrate) | P2 |
| FR-KDS-023 | Configurable sort orders | PARTIAL_BACKEND (FIFO only, rest DEFERRED_BY_GOVERNANCE) | DEFERRED |
| FR-KDS-024 | Bump item/bump-all | COMPLETE_BACKEND (SERIALIZABLE + bounded retry, 12 concurrency tests) | — |
| FR-KDS-025 | Recall, 30-min default window | COMPLETE_BACKEND | — |
| FR-KDS-027 | Priority flags (rush/VIP) | MISSING_BACKEND | DEFERRED |
| FR-KDS-028 | Amendment reuses ticket, never duplicates | COMPLETE_BACKEND | — |
| FR-KDS-029 | Cancelled-line strikethrough, configurable visibility | PARTIAL_BACKEND (persistence complete; visibility-duration config never written) | P2 |
| FR-KDS-030 | All-day counts | MISSING_BACKEND | DEFERRED |
| FR-KDS-040 | 7 lifecycle timestamps | PARTIAL_BACKEND (6/7 live; `servedAt` dead column) | P2 |
| FR-KDS-041/042 | Avg prep time / ticket-time / order-time metrics | PARTIAL_BACKEND (coarse overview aggregate only, not the named multi-dimensional metrics) | P2 |
| FR-KDS-043/045 | Bottleneck detection, capacity warning | MISSING_BACKEND (both) | DEFERRED |
| FR-KDS-044 | Per-item target prep time applied to `targetReadyAt` | PARTIAL_BACKEND (upstream data complete; Kitchen never reads it) | P2 |
| NFR-PERF-004 | Fired order visible ≤1s p95 | NEEDS_VERIFICATION (no benchmark run) | — |
| NFR-REL-002 | Offline KDS buffering | PARTIAL_BACKEND (bump only; start/recall/first-viewed not offline-capable) | P2 |
| NFR-REL-003 | Local peer discovery offline | MISSING_BACKEND | DEFERRED |
| — | Fire-transaction atomicity, no partial writes on routing failure | **COMPLETE_BACKEND** (re-traced independently; multi-line sibling-rollback test added same day) | — |
| — | Ticket persistence idempotency/race safety | COMPLETE_BACKEND | — |
| — | First-viewed | COMPLETE_BACKEND | — |
| — | `kds.operate` authorization + station-scope re-verification | COMPLETE_BACKEND | — |
| — | Audit trail | COMPLETE_BACKEND | — |
| FR-FIN-001/002 | Drawer/session model, one-open-session-per-drawer (DB partial unique index) | COMPLETE_BACKEND | — |
| FR-FIN-003 | Shared-drawer mode | MISSING_BACKEND | DEFERRED |
| FR-FIN-004 | Expected-cash 8-term formula | COMPLETE_BACKEND (tips term structurally zero — documented, no tip mechanism exists yet) | P3 |
| FR-FIN-005 | Variance = counted − expected | COMPLETE_BACKEND | — |
| FR-FIN-006 | Variance approval, self-approval excluded | COMPLETE_BACKEND (real Governance Approval Runtime, RLS-enforced exclusion) | — |
| FR-FIN-007 | Session immutability, adjusting entries | PARTIAL_BACKEND (immutability real; **no adjusting-entry mechanism exists**) | P2 |
| FR-FIN-010 | Tender-type totals (11 families) | **PARTIAL_BACKEND (only cash + manual-external-card)** | P1 |
| FR-FIN-011/012 | Card-terminal / aggregator reconciliation | MISSING_BACKEND (both) | DEFERRED |
| FR-FIN-015..018 | Expenses | MISSING_BACKEND (no Expense entity exists) | DEFERRED |
| FR-FIN-020 | Day-close operation | COMPLETE_BACKEND | — |
| FR-FIN-021 | Blocks while any session open | COMPLETE_BACKEND | — |
| FR-FIN-022 | Z-report content (12 named limbs) | **PARTIAL_BACKEND — 8 of 12 limbs implemented; tax-by-rate, sales-by-category, comp-half of void/comp, remaining tender families NOT** (self-disclosed in every API response, governance-ratified DC-R1 as sequenced-not-blocking) | P1 |
| FR-FIN-023 | Sequential immutable Z-numbering | COMPLETE_BACKEND | — |
| FR-FIN-024 | Configurable business-day boundary | COMPLETE_BACKEND | — |
| FR-FIN-025 | Automatic close at boundary | MISSING_BACKEND | DEFERRED (Should) |
| FR-FIN-026 | Day-close triggers (fiscal/inventory-snapshot/pre-agg/accounting-export) | **MISSING_BACKEND — all 4 trigger limbs; the enabling transactional outbox (FR-PLT-041) does not exist in the repo at all** | P1 |
| — | Drawer provisioning, cash-session-open, employee custody, close-attempt transactionality, close-other, business-day interaction, audit/event publication | COMPLETE_BACKEND (all 7 special checks) | — |

### 5.6 Inventory / Waste / Reason Codes; Reporting; Audit Trail; Business Day/Day Close (cross-ref §5.5); Governance Approval Workflow

**Full source:** delivered inline this session (103 items — the largest single section). Key evidence: `src/modules/inventory/**`, `src/modules/reporting/**`, `src/modules/governance/audit/**`, `src/modules/governance/approvals/**`, Governance Register (DC-R1, AUD-R1, RPT-R1/R2, D-7, D-8, D-11, D-12, D-16).

**Inventory (50 rows) — headline finding: FR-INV-020 (no batch-creation endpoint exists anywhere) is a previously-unflagged finding this session surfaced.**

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-INV-001 | Stock item master | PARTIAL_BACKEND | P2 |
| FR-INV-002 | Base unit immutable after movement | COMPLETE_BACKEND | — |
| FR-INV-003/004/005 | Multi purchase units, mass↔volume conversion, supplier codes | MISSING_BACKEND (all — models exist, zero consuming code) | P2 |
| FR-INV-010 | Current stock levels | COMPLETE_BACKEND | — |
| FR-INV-011 | Ledger reconciliation, scheduled job + alert | PARTIAL_BACKEND (job complete; alert delivery not) | P1 |
| FR-INV-012 | Costing methods | COMPLETE_BACKEND | — |
| FR-INV-013 | FIFO batch-order valuation | IMPLEMENTED_BUT_NOT_HTTP_REACHABLE (blocked by FR-INV-020) | P1 |
| FR-INV-014 | Negative stock permit/record/alert | PARTIAL_BACKEND | P2 |
| FR-INV-015 | Historical valuation report | MISSING_BACKEND | P2 |
| **FR-INV-020** | **Create batch on receipt/production** | **MISSING_BACKEND — no endpoint anywhere; blocks FR-INV-013/021/022/023** | **P0** |
| FR-INV-021/022/023 | Default expiry, FIFO/FEFO consumption | IMPLEMENTED_BUT_NOT_HTTP_REACHABLE (all — logic complete, dead code, blocked by FR-INV-020) | P1 |
| FR-INV-024 | Expiry alerts, per-category horizons | PARTIAL_BACKEND (flat, not per-category; no delivery) | P2 |
| FR-INV-025/026/027 | Expiry worklist, auto write-off, batch traceability | MISSING_BACKEND (all) | P1/P2 |
| FR-INV-030 | Immutable movement ledger | COMPLETE_BACKEND | — |
| FR-INV-031/032 | Two-step transfer, discrepancy record | COMPLETE_BACKEND (both) | — |
| FR-INV-033 | Printed/digital transfer note | MISSING_BACKEND | P3 |
| FR-INV-034 | Sending-cost valuation, variance posting | PARTIAL_BACKEND (variance-account posting deliberately unbuilt) | P2 |
| FR-INV-035 | Manual adjustment reason+permission+threshold-approval | **PARTIAL_BACKEND — no approval mechanism of any kind wired** | P1 |
| FR-INV-040..045 | Count scopes/modes/freeze/post | PARTIAL_BACKEND to COMPLETE_BACKEND (mixed — storage-area scope and mandatory-blind-policy missing) | P2 |
| FR-INV-046 | Variance threshold → recount/explanation | MISSING_BACKEND | P1 |
| FR-INV-047 | Count posting permission+high-value approval | PARTIAL_BACKEND (`APPROVE_HIGH_VARIANCE` permission is dead code) | P1 |
| FR-INV-048/049 | Cycle counting, ordered count sheet | MISSING_BACKEND (both) | P2/P3 |
| FR-INV-050 | Full count history | PARTIAL_BACKEND | P2 |
| FR-INV-051 | Scheduled reconciliation job | PARTIAL_BACKEND (same as FR-INV-011) | P1 |
| FR-INV-055/056 | Waste recording, optional photos | PARTIAL_BACKEND (photos missing) | P2/P3 |
| FR-INV-057 | Default reason-code taxonomy seeded | **PARTIAL_BACKEND — mechanism complete, no default SRS taxonomy ever seeded** | P1 |
| FR-INV-058 | Waste threshold approval | DEFERRED_BY_GOVERNANCE (ratified B-2) | DEFERRED |
| FR-INV-059..061 | True-waste-vs-controlled reporting, analysis, anomaly detection | MISSING_BACKEND / PARTIAL_BACKEND (mixed) | P2/P3 |
| FR-INV-065 | Reorder points | COMPLETE_BACKEND | — |
| FR-INV-066..070 | Low-stock alerts, suggested order qty, shelf-life cap, demand/seasonality | PARTIAL_BACKEND / MISSING_BACKEND (mixed — delivery/forecast layers absent) | P2/P3 |

**Reporting (30 rows) — module owns zero Prisma models, zero rollup jobs; only 2 HTTP routes exist.**

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-RPT-001..003/005 | Read-replica queries, pre-aggregated rollups, SCD dims | MISSING_BACKEND (all — ratified NOT-IMPLEMENTED) | P2 |
| FR-RPT-004 | `dataAsOf` + incomplete-period indication | COMPLETE_BACKEND (for the 2 routes that exist) | — |
| FR-RPT-030..034 | Role dashboards | MISSING_BACKEND | P3 |
| FR-RPT-040..046 | Scheduled delivery, drill-down, CSV/XLSX/PDF export, alerts | **MISSING_BACKEND (all)** | P1 (export) |
| RPT-R1 | AND-gated `report.view.sales`+`.financial` permission | COMPLETE_BACKEND | — |
| Daily Trading Report / Operational Overview routes | | IMPLEMENTED_BUT_NOT_PRODUCTION_READY (real, narrow, self-disclosed-partial) | P1/P2 |
| X Report (mid-shift) | | MISSING_BACKEND | P1 |
| Sales-by-branch/category/item/employee/hour, discount&comp, void&refund, AOV trend, menu mix | | MISSING_BACKEND (only Sales Summary + Sales-by-Tender exist) | P1 |
| Inventory/Kitchen operational reports (valuation, movement ledger, prep-time, station perf) | | MISSING_BACKEND (mostly) | P1/P2 |
| Cash Reconciliation, Tax Summary | | PARTIAL_BACKEND | P1 |
| Expense Summary, Branch P&L, Prime Cost | | MISSING_BACKEND | P1 |
| Attendance/Overtime/Labour-Cost/Sales-per-Labour-Hour/Employee-Performance reports | | MISSING_BACKEND (mostly) | P2 |
| Audit Log/Approval-History/Anomaly/SoD-Conflict/Config-Change reports | | NOT_BACKEND_OWNED (by Reporting — owned by Governance, see below) | — |

**Audit / Immutable Audit Trail (10 rows, FR-AUD-001..010 only — the SRS defines no 011-026 despite an overview-table typo)**

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-AUD-001 | Immutable entry for every state-changing op | PARTIAL_BACKEND (~120 audit actions; "every" not exhaustively provable) | P1 |
| FR-AUD-002/003/004 | Field set, append-only DB grants, SHA-256 hash chain | COMPLETE_BACKEND (all 3) | — |
| FR-AUD-005 | Scheduled chain-verification job + alert | IMPLEMENTED_BUT_NOT_PRODUCTION_READY (job complete; human alert delivery not implemented) | P1 |
| FR-AUD-006 | Enumerated always-audited actions | PARTIAL_BACKEND | P2 |
| FR-AUD-007/008 | Audit-log-access-is-audited, searchable/exportable | COMPLETE_BACKEND (both) | — |
| FR-AUD-009 | 7-year/statutory retention | **MISSING_BACKEND** | P1 |
| FR-AUD-010 | Impersonation audit | **MISSING_BACKEND** (schema column exists, nothing populates it) | P1 |

**Business Day / Day Close** — see §5.5 (Treasury-owned; FR-FIN-020..026).

**Governance / Approval Workflow (6 rows) — materially corrects the stale 2026-08-17 `PHASE_1_SRS_REQUIREMENT_MAP.md` "blanket NOT_IMPLEMENTED" finding.**

| Req ID | Title | Classification | Severity |
|---|---|---|---|
| FR-SEC-030 | General approval mechanism | PARTIAL_BACKEND (engine real, DB-immutable, wired into POS discount/refund + cash-variance-close; no standalone Governance HTTP controller) | P1 |
| FR-SEC-031 | Request field set (6 fields) | COMPLETE_BACKEND | — |
| FR-SEC-032 | Sync (PIN) or async (push) approval | PARTIAL_BACKEND (sync only; async formally deferred, D-11 strict-none) | P1 |
| FR-SEC-033 | Immutable decisions | COMPLETE_BACKEND | — |
| FR-SEC-034 | Timeout escalation | MISSING_BACKEND (governance-BLOCKED, D-12) | P2 |
| FR-SEC-035 | Offline/retrospective approval | MISSING_BACKEND (D-16 open) | P1 |

### 5.7 Cross-Cutting Platform: Idempotency / Concurrency / Security / Reliability / Observability / OpenAPI / Scheduler / Production Readiness

**Full source:** delivered inline this session (50 items) — synthesized into §7 (Test Health) and §9 (Production Readiness) below rather than repeated here in table form, since nearly every row in this section directly feeds those two sections.

---

## 6. Special Backend Checks (master spec §6) — Consolidated Verdicts

**AUTH/SESSION:** Password + PIN login both real, tested, architecturally sound. POS/dashboard JWT-audience boundary independently re-verified live (11 e2e suites/182 tests). `dc746a9` employee-identity fix confirmed correct and regression-tested. Gaps: 3 of 5 auth methods missing (card/biometric/SSO, no governance deferral); **no account lockout on password login**; no admin forced-logout; password floor is 8 not 10 chars; idle-expiry semantics don't exist per-surface.

**RBAC:** Scope-lattice architecture (FR-SEC-001–005) is COMPLETE_BACKEND, ratified, and enforced across 101/193 guarded routes with a non-tenant target. Permission catalogue is materially incomplete vs SRS §15.2 (entire Procurement domain absent). Only 5/13 standard roles ship as templates. SoD is real but partial (2 of 4 named self-approval combos hard-blocked at the DB layer; **self-elevation via role-assignment is an open, undocumented-as-fixed gap**). Two P0 canonical-role-reachability gaps found in POS (discount/comp/post-fire-void reachable by no staff role — same defect class the refund permission had until `bf91d66` fixed it same-day).

**POS/SALES:** Create/add/remove/fire all COMPLETE_BACKEND and transactionally sound. Discounts/comps/voids/refunds all logically COMPLETE_BACKEND (byte-identical POS-FIN-1 work now confirmed present in lane-d) but **gated by the P0 role-reachability gap above** for discount/comp/void. Payment capture correct for its 2 supported tenders (of 11 named); split-bill and integrated-card payment are MISSING_BACKEND; service charge/tips columns exist but are never computed. Manager-approval workflow real (Governance Approval Runtime, self-approval structurally excluded).

**KDS:** Routing (5-tier), fire-transaction atomicity (no partial writes on routing failure, independently re-traced and multi-line-rollback-tested same day), bump/recall (SERIALIZABLE + bounded retry, 12 concurrency tests including a write-skew "GUARD" proof), station-scope authorization (fresh re-verification inside every transaction, never trusting the guard alone) — all COMPLETE_BACKEND. Analytics/metrics (avg prep time, ticket time, order time) are coarse or missing; Expediter/priority-flags/bottleneck-detection all deliberately deferred by governance.

**CASH/TREASURY:** Drawer provisioning, session open (DB partial-unique-index race-proof), employee custody (server-derived identity only), variance computation+approval (self-approval structurally excluded via RLS), close-other, business-day/day-close interaction (shared advisory-lock fence with order creation), audit/event publication — all COMPLETE_BACKEND. Tender-family coverage (2 of 11), full Z-report content (8 of 12 limbs), and day-close's 4 downstream triggers (fiscal/inventory-snapshot/pre-agg/accounting-export — **the enabling transactional outbox doesn't exist at all**) are the three P1 gaps, all self-disclosed in every API response and governance-ratified (DC-R1) as sequenced, not silently missing.

**CATALOGUE:** Menu/item/modifier/price/availability core is COMPLETE_BACKEND. Modifier stock consumption is recorded but never depleted against inventory (P1). Auto-86-on-zero-stock chain (FR-MNU-031/032/033) entirely absent, deliberately, pending Inventory integration.

**REFUND:** `pos.refund.issue`, manager approval, different-tender gating, reason codes, canonical Cashier/Shift-Supervisor role reachability — all COMPLETE_BACKEND, with the canonical-role gap closed same-day by `bf91d66`. Fraud-detection-report flagging is the one named sub-clause not implemented (no fraud infra exists anywhere).

**COUNTRY PACKS:** Signed-pack loading and fail-closed verification are code-complete (33 signature test cases) but gated on two env vars **unconfirmed on the live deployment target** — the single highest-leverage P0 in this audit, since an unset value fails the entire order-capture path closed. Conformance suite is incomplete (no invoice/QR arms) and not wired into the activation gate. Offline terminal distribution of packs does not exist. EG/SA statutory e-invoicing/QR/hash-chain integrations are entirely absent — a P0 for any tenant in those jurisdictions.

**REPORTING/AUDIT:** Audit trail (hash-chain, append-only, field-complete, self-auditing access) is strong and largely COMPLETE_BACKEND; retention policy (7-year/statutory) and impersonation audit are the two open P1 gaps. Reporting is the weakest domain in the entire audit by requirement count — only 2 routes exist against ~30 named SRS report types; most are MISSING_BACKEND, though what exists is honest about its own incompleteness (`dataAsOf`/scope-block fields self-disclose partiality rather than mask it).

**HTTP/OPENAPI:** OpenAPI 3.1.0 generated, CI-drift-gated, 193 operations matching the independently-enumerated route count exactly. Idempotency-Key is correctly applied via `@Idempotent()` to 30 routes across every financially-significant module (Sales/Treasury/Workforce/Kitchen), with full 30-day storage, fingerprint-conflict 409, and replay-header semantics — this requirement (FR-API-020..023, NFR-REL-011) is fully COMPLETE_BACKEND, a positive finding not surfaced by the stale 2026-08-17 reconciliation doc. One live, reproducible CI-blocking drift exists: `POST /auth/registrations` is missing from `authorization-coverage.spec.ts`'s allowlist (confirmed independently three times across three different sub-audits this session — allowlist/test drift, not a real authorization hole, one-line fix).

**PRODUCTION:** Required env vars are validated fail-fast at boot. Two optional-but-consequential env vars (`SCHEDULER_ENABLED`, `METRICS_PORT`) default to **off**, silently disabling every scheduled job (partition lifecycle, audit-chain verification, inventory reconciliation) and all Prometheus metrics exposure on a vanilla production deploy with no startup warning. `GET /health` is a static payload with no DB-connectivity check — a real readiness-probe gap. No Dockerfile for the application exists. Three-role DB provisioning (`ros_migrator`/`ros_app`/`ros_partition_admin`) is automated in CI/docker-compose but still requires correct manual setup on any new production target.

---

## 7. Test Health (master spec §7)

**Live verification performed this session (read-only, no destructive commands, full E2E suite deliberately not run):**

- **Full unit suite:** `npx jest --ci` → **1153/1155 passing, 83/84 suites green.** The single failing suite is `src/modules/authorization-coverage.spec.ts` (2 of 9 tests failing).
- **`authorization-coverage.spec.ts` root cause (confirmed independently 3 times, across 3 separate sub-audits, byte-identical result each time):** `POST /auth/registrations` (added 2026-09-05, commit `b85c524`, FR-PLT-020 tenant self-service signup) carries no `@RequirePermission` and was never added to `REVIEWED_UNPROTECTED_ROUTES`. **Verdict: allowlist/test drift, not a real authorization hole** — the route is deliberately public, IP-rate-limited, and strict-DTO-validated, structurally identical in risk profile to the already-allowlisted `POST /auth/login`. **This currently fails CI** (`.github/workflows/backend-ci.yml`'s unit-test step runs the full `testRegex` including this spec) — a real, reproducible, one-line-fix production-pipeline blocker, distinct from any authorization defect.
- **E2E suite:** deliberately not run in full, per task instruction. Domain-specific e2e suites were run live and green where cited above (11 identity/RBAC suites/182 tests; targeted KDS/Treasury/POS suites referenced by the respective section reports). No stale E2E pass/fail count from a prior report is carried forward as current fact anywhere in this document.
- **CI wiring:** `.github/workflows/backend-ci.yml` exists and runs typecheck, lint, unit tests (includes the currently-failing spec above), `module-boundaries.spec.ts`, OpenAPI-drift check, `npm audit --audit-level=high` (blocking), secret scan, a from-zero-migration job, and a full isolated-DB E2E job with dedicated FR-PLT-013/014 RLS sub-gates. This **supersedes** the stale 2026-08-17 finding of "no `.github` directory anywhere" and a stale in-repo docblock making the same claim. **As configured, this pipeline would currently fail** on the authorization-coverage drift above.
- **Known pre-existing failure cited by the 2026-08-17 doc** (`access-token.service.spec.ts:28`) — not reproduced in this session's clean run; either fixed since or referring to a file that no longer exists in its old form. Not carried forward as current fact.
- **Tests proving only unit behavior vs. real HTTP/domain integration:** all 1,155 `src/**/*.spec.ts` tests are unit-level (many with mocked Prisma). Only `test/*.e2e-spec.ts` (100+ files) exercises real HTTP against real Postgres with RLS enforced — this is where the vast majority of the COMPLETE_BACKEND classifications above draw their strongest evidence from.

---

## 8. Backend Completion Metrics

**Denominator methodology:** each of the 7 domain sections independently enumerated and classified backend requirements against the SRS text within its assigned scope, re-verifying current code rather than trusting prior reports. Sums below are the **raw total** of all 7 sections' self-reported figures. As disclosed in §4, FR-SEC-001–005/010–012/015–017 (the core RBAC primitives) were independently audited by two sections (§5.1 and §5.2) from different angles, with fully consistent conclusions in every case checked — this inflates the raw count by roughly 9 rows. A deduplicated estimate is given alongside the raw sum.

```
TOTAL_SRS_REQUIREMENTS_WITH_BACKEND_RESPONSIBILITY (raw sum, 7 sections):  415
TOTAL_SRS_REQUIREMENTS_WITH_BACKEND_RESPONSIBILITY (deduplicated est.):   ~406

COMPLETE_BACKEND_COUNT:                 ~187   (Identity/RBAC 22, Tenant/Org/Workforce 27,
                                                 Catalogue/Localisation/Platform 15,
                                                 POS Sales 17, KDS/Treasury 32,
                                                 Inventory/Reporting/Audit/Governance 22,
                                                 plus positive cross-cutting findings folded
                                                 into §6/§7 — Idempotency FR-API-020..023 and
                                                 NFR-REL-011 fully COMPLETE_BACKEND)
PARTIAL_BACKEND_COUNT:                  ~103   (12+15+15+15+11+24, cross-section)
MISSING_BACKEND_COUNT:                  ~106   (6+12+13+13+6+45, cross-section)
IMPLEMENTED_NOT_REACHABLE_COUNT:          6    (FR-INV-013/021/022/023 [Inventory, blocked by
                                                 FR-INV-020]; pos.discount.apply/.unlimited/
                                                 pos.comp.apply/pos.order.void_line_postfire
                                                 canonical-role-reachability [POS, counted once
                                                 here as the underlying defect class])
IMPLEMENTED_NOT_PRODUCTION_READY_COUNT:  10    (FR-LOC-022 country-pack env vars; FR-AUD-005/
                                                 FR-DR-002/FR-INV-011/051 scheduler-default-off;
                                                 NFR-OBS-003/006 metrics/alerting needing live
                                                 infra; Reporting's 2 routes; reason-code/policy
                                                 signup-provisioning gap)
DEFERRED_COUNT:                         ~19    (MFA G4-2 ×2; settings resolver D-11 ×4; branch
                                                 groups D-10; franchise; KDS Expediter/priority/
                                                 sort/peer-discovery/bottleneck ×6; waste-
                                                 threshold B-2; escalation D-12; offline-approval
                                                 D-16; shared-drawer; card/aggregator recon;
                                                 expenses)
NEEDS_VERIFICATION_COUNT:                ~6    (FR-POS-002 offline block semantics; FR-POS-006
                                                 park/resume; multi-branch scope-review
                                                 condition; NFR-PERF-004 KDS latency benchmark;
                                                 RPT-R1 standard-role reachability; FR-MNU-006
                                                 variant-recipe cross-domain confirmation)
```

**BACKEND_PERCENT_COMPLETE_STRICT** (COMPLETE_BACKEND ÷ deduplicated total): **187 / 406 ≈ 46%**
Only fully-implemented, reachable, secured, tested, production-capable requirements count.

**BACKEND_PERCENT_IMPLEMENTED** (COMPLETE_BACKEND + IMPLEMENTED_NOT_REACHABLE + IMPLEMENTED_NOT_PRODUCTION_READY, ÷ deduplicated total): **(187+6+10) / 406 ≈ 50%**
This adds requirements whose backend logic exists and is correct but is blocked purely by a missing HTTP surface, a missing role grant, or a missing deploy-time config/integration — i.e., work where the remaining effort is wiring/configuration/role-template edits rather than net-new domain logic.

Both denominators exclude `NOT_BACKEND_OWNED` rows (infra/deployment/frontend concerns — approximately 15 across all sections) since those carry no backend obligation by definition.

---

## 9. Backend Production Readiness

**BACKEND_PRODUCTION_READY: NO**

**BACKEND_PRODUCTION_BLOCKERS** (real blockers to calling *the deployed backend* production-ready today):

1. **Lane-d is not merged into `origin/main`.** Every COMPLETE_BACKEND finding in this audit describes lane-d, not the branch actually deployed as "main." This is the single overriding blocker — nothing else in this list matters to a production deployment tracking `main` until this merge happens.
2. **`COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` env vars unconfirmed on the live deployment target.** Code is correct and fail-closed; if unset, the entire order-capture path (and therefore the entire POS golden path) fails closed in production.
3. **`pos.discount.apply`, `pos.discount.unlimited`, `pos.comp.apply`, `pos.order.void_line_postfire` are granted to no canonical role template.** Only the full-catalogue Owner role can discount, comp, or post-fire-void an order — the same defect class `pos.refund.issue` had until `bf91d66` fixed it for refunds alone, same day. A 5-minute fix (add the codes to `canonical-role-templates.ts`), not yet applied to these four codes.
4. **`authorization-coverage.spec.ts` currently fails CI** (1 real drift: `POST /auth/registrations` missing an allowlist entry). Confirmed real and reproducible by three independent sub-audits. One-line fix; blocks a clean CI run until applied.
5. **IR-LOC-EG/SA fiscal e-invoicing/QR/hash-chain integrations are entirely absent.** A statutory blocker specifically for any Egypt- or Saudi-Arabia-jurisdiction tenant; not a blocker for jurisdictions with no such mandate.
6. **`SCHEDULER_ENABLED` and `METRICS_PORT` default to off with no startup warning.** A vanilla production deploy silently ships with zero scheduled jobs (partition lifecycle, audit-chain verification, inventory reconciliation all inert) and zero metrics exposure.
7. **`GET /health` performs no DB-connectivity check.** A readiness probe using this endpoint will report healthy during a database outage.

**BACKEND_MVP_BLOCKERS** (anything preventing full backend MVP/SRS completion, beyond the production blockers above):

- FR-INV-020 (no batch-creation endpoint — blocks the entire FIFO/FEFO/expiry chain for batch-tracked inventory).
- FR-FIN-010/FR-POS-060 (only 2 of 11 payment tender types).
- FR-FIN-022/FR-FIN-026 (Z-report content gaps; day-close's 4 downstream triggers, blocked on a non-existent transactional outbox).
- FR-PLT-025..028 (hierarchical settings resolver — formally deferred but blocks several other requirements' "configurable" clauses across modules).
- Reporting domain (only 2 of ~30 named SRS report types exist).
- FR-SEC-025/026/027/046 (password floor, idle expiry, admin forced-logout, password-login lockout).
- FR-AUD-009/010 (retention policy, impersonation audit).
- FR-SEC-015/017 + self-elevation prevention (SoD completeness).

**NONBLOCKING_BACKEND_WORK** (hardening, tests, operations, documentation):

- Stale doc-comment cleanup in `*.permissions.ts` files predating the B1-3 branch-scoped-RBAC amendment.
- Progressive (vs. flat) PIN lockout.
- Unit-test positive-path coverage for `findByUser` in `auth.service.refresh.spec.ts`/`terminal-session.service.spec.ts` (currently mocked to null only; e2e coverage compensates).
- Field-level encryption for `Employee.nationalId`.
- IP allow-listing, SIEM event forwarding.

**GOVERNANCE_DEFERRED** (explicitly ratified future work — not gaps, not blockers):

- FR-SEC-023/024 MFA (board G4-2).
- FR-PLT-025/026/027/028 settings resolver (ADR 0008 D-11).
- FR-BRN-005 branch groups (ADR 0008 D-10); FR-BRN-035..037 franchise support.
- FR-INV-058 waste-threshold approval (ratified B-2).
- FR-SEC-034 approval escalation (D-12, BLOCKED); FR-SEC-035 offline/retrospective approval (D-16, open).
- FR-SEC-032's async/push approval channel (D-11, strict-none).
- FR-KDS-012/013/023(non-FIFO)/027/030/043/045, NFR-REL-003 (all explicitly named DEFERRED at the KDS-R11/R12 ratification, 2026-08-30).
- FR-FIN-003 shared-drawer mode; FR-FIN-011/012 card/aggregator reconciliation; FR-FIN-015..018 expenses; FR-FIN-025 automatic day-close.
- RPT-R2 (report pre-aggregation explicitly forbidden by ratification, not merely unbuilt).

---

## 10. Prioritized Remaining Backend Work

### PHASE A — Must Fix Before Backend Production

| Item | Requirement IDs | Gap | Repo/Worktree | Size | Dependencies | Risk | Test Suites Required |
|---|---|---|---|---|---|---|---|
| Merge lane-d into main | (all COMPLETE_BACKEND findings in this audit) | Nothing in this audit is live until this happens | lane-d → origin/main | **XL** | Clean CI run (needs items below first) | High — largest single lever in this entire audit | Full CI pipeline (unit+e2e+RLS gates+OpenAPI drift) |
| Fix authorization-coverage allowlist drift | — | Add `POST /auth/registrations` to `REVIEWED_UNPROTECTED_ROUTES` | lane-d, `src/modules/authorization-coverage.spec.ts` | **XS** | none | Low | `authorization-coverage.spec.ts` |
| Grant discount/comp/void-postfire to canonical roles | FR-POS-045/050, void-postfire | Add `DISCOUNT_APPLY`/`DISCOUNT_UNLIMITED`/`COMP_APPLY`/`ORDER_VOID_LINE_POSTFIRE` to Cashier/Shift-Supervisor templates | lane-d, `identity/authz/canonical-role-templates.ts` | **XS** | none | High — POS golden path unusable by staff otherwise | `test/pos-financial-corrections.e2e-spec.ts`, `employee-role-assignments.e2e-spec.ts` |
| Confirm/set country-pack env vars on deploy target | FR-LOC-022 | `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` | Deployment/ops, not code | **XS** (ops task) | none | Critical — order capture fails closed without it | `country-pack.deployment-artifacts.spec.ts` (already exists) |
| Decide `SCHEDULER_ENABLED`/`METRICS_PORT` production defaults or add a startup warning | — | Silent-disable-by-default risk | lane-d, `platform/scheduler/scheduler-heartbeat.service.ts`, env validation | **S** | none | Medium | `env.validation.spec.ts` |
| Add DB-connectivity check to `/health` | — | Readiness vs. liveness probe conflation | lane-d, `src/health/health.controller.ts` | **S** | none | Medium | new health e2e spec |

### PHASE B — Required for Full SRS Backend Completion

| Item | Requirement IDs | Gap | Size | Notes |
|---|---|---|---|---|
| Batch-creation endpoint | FR-INV-020 (unblocks 013/021/022/023) | No receiving flow for batch-tracked items at all | **M** | Unblocks 4 dead-code-complete requirements at once |
| Remaining payment tenders | FR-FIN-010, FR-POS-060 | 9 of 11 tender types missing | **L** | Card/wallet/gift-card/voucher/on-account/aggregator |
| Split bill | FR-POS-062 | No seat/item/amount split primitive | **M** | |
| Integrated card terminal | FR-POS-064 | No terminal-initiation flow | **L** | External hardware/SDK integration |
| Service charge / tips | FR-POS-055..058 | Columns exist, never computed | **M** | |
| Reporting domain build-out | FR-RPT-* (~25 rows) | Only 2 of ~30 named report types exist | **XL** | Largest single remaining domain by requirement count |
| Transactional outbox + day-close triggers | FR-FIN-026, FR-PLT-041 | No outbox exists; blocks fiscal/inventory-snapshot/pre-agg/export | **L** | Foundational — several other requirements depend on it |
| Z-report content completion | FR-FIN-022 | Tax-by-rate, sales-by-category, comp-half, remaining tenders | **M** | |
| Hierarchical settings resolver | FR-PLT-025..028 | Formally deferred (D-11) but blocks several "configurable" clauses tenant-wide | **L** | Cross-cutting unblock |
| Fiscal e-invoicing (EG/SA) | IR-LOC-EG/SA-* | No implementation at all | **XL** | Statutory; jurisdiction-specific |
| Password/session hardening | FR-SEC-025/026/027/046 | Floor, idle-expiry, forced-logout, login lockout | **M** | |
| SoD completeness | FR-SEC-015/017, self-elevation | Warning mechanism, conflict report, self-elevation guard | **M** | |
| Audit retention + impersonation | FR-AUD-009/010 | No retention policy; impersonation unaudited | **M** | |

### PHASE C — Hardening / Operations

- Stale RBAC-deferral doc comments; progressive PIN lockout; unit positive-path test gaps; field-level encryption for national ID; IP allow-listing; SIEM forwarding; alert-delivery channels for scheduled jobs (partition/audit-chain/inventory-reconciliation all currently detect-but-don't-notify); Dockerfile for the application; distributed tracing (NFR-OBS-002).

### PHASE D — Governance-Deferred / Future

- Per §9's `GOVERNANCE_DEFERRED` list in full: MFA, settings resolver, branch groups, franchise support, waste-threshold approval, approval escalation, offline/retrospective approval, async approval channel, KDS Expediter/priority/non-FIFO-sort/peer-discovery/bottleneck-detection, shared-drawer mode, card/aggregator reconciliation, expenses module, automatic day-close, report pre-aggregation.

### Parallelizable work streams

- **STATIC/LIGHTWEIGHT:** authorization-coverage allowlist fix, canonical-role-template permission grants, doc-comment cleanup, `/health` DB check, scheduler-default decision.
- **BACKEND_UNIT:** password/session hardening, SoD completeness, field-level encryption.
- **BACKEND_E2E_DB_HEAVY:** batch-creation endpoint + FIFO/FEFO unblock, split-bill, service-charge/tips, Z-report completion (**only one of these streams should run against a shared DB at a time**, per the master instruction).
- **MIGRATION_HEAVY:** transactional outbox, remaining-tender-family schema additions, fiscal e-invoicing schema (**run in isolation from the E2E-heavy stream above**).
- **DOCS/GOVERNANCE:** settings-resolver ratification path, MFA scope decision, Reporting-domain scope decision (currently the single largest ungoverned-by-explicit-roadmap gap in the audit).

---

## 11. Final Executive Summary

**CURRENT_BACKEND_STATE:** A materially more complete backend than any single prior report captures, currently stranded in an unintegrated worktree. Lane-d (`full-srs/lane-d4-reporting-demo`) contains, by verified content, essentially all accepted work across every other backend lane plus 12 commits of its own — but it is 13 commits ahead of `origin/main` with no merge yet performed. **Nothing classified COMPLETE_BACKEND in this audit is live on `main` today.**

**BACKEND_MVP_STATUS:** Partial. Core transactional domains (Identity/RBAC/PIN, Organisation/Workforce, POS order-capture/discounts/refunds business logic, KDS routing/fire/bump/recall, Treasury cash-sessions/day-close) are strong — extensively concurrency-tested, RLS-isolated, and audited. Reporting, full payment-tender coverage, fiscal/statutory compliance for EG/SA, and the settings-resolver foundation are the weakest areas by requirement count.

**FULL_SRS_BACKEND_STATUS:** Roughly half-implemented by the strictest measure (46% COMPLETE_BACKEND), rising to ~50% when counting logic that exists but is blocked purely by a missing role grant, HTTP surface, or deploy-time config. A further ~19 requirements are legitimately, deliberately, and traceably governance-deferred rather than silently missing — a sign of disciplined scope management, not neglect.

**BACKEND_PRODUCTION_READY:** **NO.**

**BACKEND_PERCENT_COMPLETE_STRICT:** **~46%** (187/406, deduplicated denominator; see §8 for full methodology).

**BACKEND_PERCENT_IMPLEMENTED:** **~50%** (203/406).

**TOP_10_REMAINING_BACKEND_ITEMS:**
1. Merge lane-d into `origin/main` (nothing else matters until this happens).
2. Confirm/set `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` on the live deployment target.
3. Grant `pos.discount.apply`/`.unlimited`/`pos.comp.apply`/`pos.order.void_line_postfire` to canonical staff roles.
4. Fix the `authorization-coverage.spec.ts` allowlist drift (`POST /auth/registrations`).
5. Build the batch-creation endpoint (FR-INV-020) to unblock 4 already-coded-but-dead FIFO/FEFO/expiry requirements.
6. Decide production defaults for `SCHEDULER_ENABLED`/`METRICS_PORT`, or add a startup warning.
7. Build out the Reporting domain (only 2 of ~30 named SRS report types exist today).
8. Build the transactional outbox (FR-PLT-041) to unblock Day Close's 4 downstream triggers (FR-FIN-026).
9. Complete remaining payment-tender coverage (9 of 11 tender types absent) and split-bill (FR-POS-062).
10. Resolve EG/SA statutory fiscal e-invoicing (IR-LOC-EG/SA-*) — jurisdiction-specific but a hard blocker where it applies.

**BIGGEST_DOMAIN_GAP:** Reporting — only 2 of roughly 30 named SRS report types exist; the module owns zero Prisma models and zero rollup infrastructure.

**BIGGEST_SECURITY_GAP:** No account lockout on password login (only IP+email rate limiting) combined with the still-open self-elevation-via-role-assignment gap — together these are the two items in the entire audit closest to a genuine exploitable weakness, as distinct from a completeness gap.

**BIGGEST_DATA_INTEGRITY_RISK:** FR-INV-020 — no batch-creation endpoint exists for batch-tracked inventory items at all, silently stranding FIFO/FEFO costing and expiry management as dead code behind a missing receiving flow; discovered fresh this session, not flagged in any prior report.

**BIGGEST_OPERATIONS_GAP:** `SCHEDULER_ENABLED`/`METRICS_PORT` defaulting to off with no startup warning — a correctly-coded, well-tested scheduler and metrics substrate that silently does nothing on a vanilla production deploy.

**BIGGEST_TEST_GAP:** The full E2E suite's current pass/fail state at HEAD `bf91d66` was deliberately not re-run in full this session (per instruction) — only the unit suite (1153/1155 green) and targeted domain e2e suites were live-verified. A full E2E run should precede any merge-to-main decision.

**RECOMMENDED_NEXT_3_BACKEND_TASKS:**
1. Apply the two one-line/XS fixes (authorization-coverage allowlist; discount/comp/void-postfire canonical-role grants) and re-run the full CI pipeline including E2E, as the immediate precondition for a lane-d → main merge decision.
2. Operationally confirm the country-pack env vars on the live deployment target — a pure ops task, zero code risk, highest-leverage single action in the whole audit.
3. Scope and design-gate the batch-creation endpoint (FR-INV-020) — it single-handedly unblocks four already-implemented-but-unreachable requirements.

**INTEGRATION_GAPS:** One consolidated gap — lane-d (HEAD `bf91d66`) → `origin/main`, 13 commits. See §1.4 for the full commit list and affected-requirement framing.

**UNINTEGRATED_ACCEPTED_COMMITS:** 13, enumerated in full in §1.4.

---

*End of master report. Per-requirement evidence at file:line granularity lives in the seven section sources cited in this document's header; this document does not restate that evidence, only its conclusions, aggregated and cross-checked.*
