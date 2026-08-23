# ROS Phase 1 — SRS Requirement Map

**Document type:** analysis / documentation only. No source, schema, migration, test,
configuration, RLS policy or database object was created or modified.
**Date:** 2026-08-17
**Branch:** `feat/production-spec` @ `896b572e48be1b8499e6f5e896464f14469fe168`

---

## 1. Purpose

Map, at requirement level, the work proposed for Phase 1 so that scope is chosen
deliberately rather than by accretion. The document answers which SRS
requirements are relevant to Phase 1, which are already satisfied, which are
partial, blocked or absent, which are Governance dependencies, which should stay
out of Phase 1, and which require a ratified design decision before any code is
written.

It is a **recommendation**. It authorises nothing.

---

## 2. Authoritative Sources

| Rank | Source | Use |
|---|---|---|
| 1 | `ROS_SRS_v1.0.pdf` | Primary requirements authority. All requirement text quoted from `pdftotext -layout` extraction |
| 2 | `ROS_DrawDB_Compatible_v3.sql` | Approved database design — notably §13 GOVERNANCE, which **already defines** `approval_requests`, `approval_steps`, `approval_decisions` |
| 3 | ADRs 0001–0008 | Ratified architecture decisions |
| 4 | `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md`, `docs/inventory/INVENTORY_DESIGN_GATE.md`, `docs/inventory/INVENTORY_PHASE_CLOSEOUT.md`, `docs/catalogue/*` | Ratified phase gates |
| 5 | `docs/RECONCILIATION_POST_PRODUCTION.md` | Prior reconciliation |
| 6 | Live repository and database | Implementation evidence |

Where the SRS does not define something, it is recorded as **GAP** and no
solution is proposed.

---

## 3. Verified Starting Baseline

Established by P1-001 and P1-002, not re-verified here:

- Branch `feat/production-spec`, checkpoint `896b572e…`, `main` unchanged at `48a16f92…`
- Production implementation **PASS**: ESLint / build / build-config typecheck clean; Prisma valid; 14 migrations up to date; drift clean; unit 153/153; E2E 318/318
- `governance` schema contains **`audit_entries` only** — no approval tables
- No Sales/POS, Procurement, Workforce, CRM, KDS or Reporting implementation
- Known pre-existing failure at `src/modules/identity/auth/access-token.service.spec.ts:28` — not to be fixed

---

## 4. Requirement Classification Method

**Status** — exactly one per requirement:

| Status | Meaning |
|---|---|
| COMPLETE | Implemented with verification evidence |
| PARTIAL | Some required behaviour exists; one or more required parts missing |
| BLOCKED | Cannot be satisfied because a required dependency/capability is absent |
| NOT IMPLEMENTED | No meaningful implementation |
| OUT OF SCOPE | Excluded by an approved decision |
| GAP | SRS requires behaviour but the implementation/decision is under-defined |

**Design status** — `DESIGN COMPLETE` · `DESIGN PARTIAL` · `DESIGN REQUIRED` ·
`NO ADDITIONAL DESIGN IDENTIFIED`.

Evidence cites concrete artifacts. Absence is stated as
`NO IMPLEMENTATION EVIDENCE FOUND`. Table existence alone is never treated as
completion.

**66 unique requirements** are mapped across the nine candidate areas.

---

## 5. Governance / Approval Requirements

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-SEC-030` [M] | §15.6 | General approval mechanism used by discounts, refunds, POs, waste, count adjustments, expenses, price changes | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND. `governance` schema contains only `audit_entries` | RBAC (done), audit (done) | DESIGN PARTIAL — approved SQL §13 defines `approval_requests`; RLS/permissions/state machine undefined | **Phase 1 — Must Do** |
| `FR-SEC-031` [M] | §15.6 | Request specifies requesting user, action, affected entity, value, **required approver permission**, expiry | **NOT IMPLEMENTED** | Approved SQL `governance.approval_requests` has `request_type, entity_type, entity_id, requested_by, status` — **no `value`, no `required_permission`, no `expiry` column** | FR-SEC-030 | DESIGN REQUIRED — three SRS-mandated fields are missing from the approved SQL | **Phase 1 — Must Do** |
| `FR-SEC-032` [M] | §15.6 | Sync approval (manager PIN on terminal) **or** async (push notification), terminal usable while awaiting | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | Sync half → `FR-SEC-021/022` PIN (absent). Async half → notification channels (SRS §Integrations `IR-INT-04x`, absent) | DESIGN REQUIRED | **Phase 1 — partial only** (see §15) |
| `FR-SEC-033` [M] | §15.6 | Decisions record approver, timestamp, decision, comment; **immutable** | **NOT IMPLEMENTED** | Approved SQL `governance.approval_decisions` defines the columns. Immutability pattern proven twice (ADR 0007; Production GAP-2) | FR-SEC-030 | DESIGN PARTIAL — immutability mechanism selectable from two proven precedents | **Phase 1 — Must Do** |
| `FR-SEC-034` [S] | §15.6 | Escalation to the next approval level after a configured period | **NOT IMPLEMENTED** | `governance.approval_steps(sequence, approver_role_id)` exists in approved SQL; no scheduler in repo (`@nestjs/schedule` absent from `package.json`) | Scheduler (§11); settings for "configured period" (`FR-PLT-025`, deferred) | DESIGN REQUIRED | **Later Phase** |
| `FR-SEC-035` [M] | §15.6 | Offline: configurable policy — block, or permit with mandatory retrospective approval in an exception report | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | Offline/Sync domain (absent); Reporting (absent) | DESIGN REQUIRED | **Later Phase** |
| `FR-INV-032` [M] | §11 | Received ≠ dispatched creates a transfer discrepancy record **requiring investigation and approval** | **BLOCKED** | Discrepancy recording implemented — `src/modules/inventory/movements/transfers.service.ts` posts a separate `manual_adjustment` (D-INV-06), tested in `test/inventory.e2e-spec.ts`. Investigation + approval half absent | `FR-SEC-030` | DESIGN REQUIRED | **Phase 1 — unblocked by Governance** |
| `FR-INV-035` [M] | §11 | Manual adjustments require reason code, permission gate, **and approval above a configurable value threshold** | **BLOCKED** | Reason code + permission gate implemented (`inventory.adjust`, `ck_reason_required`). Threshold approval absent | `FR-SEC-030`; threshold source **GAP-1** | DESIGN REQUIRED | **Phase 1 — unblocked by Governance** |
| `FR-INV-046` [M] | §11 | Variance beyond threshold requires recount or written explanation before posting | **BLOCKED** | `counts.service.ts` refuses posting when `requiresApproval` is true (B-2) — nothing can grant it | `FR-SEC-030`; threshold source **GAP-1** | DESIGN REQUIRED | **Phase 1 — unblocked by Governance** |
| `FR-INV-047` [M] | §11 | Count posting permission-gated and approval-requiring for high-value adjustments | **BLOCKED** | `inventory.count.post` + `inventory.approve_high_variance` permissions exist; `count_sessions.requires_approval` column exists | `FR-SEC-030`; threshold source **GAP-1** | DESIGN REQUIRED | **Phase 1 — unblocked by Governance** |
| `FR-INV-058` [M] | §11 | Waste above a configurable value threshold requires manager approval before posting | **BLOCKED** | `waste.service.ts` refuses when `requiresApproval` is true; `waste_records.requires_approval` **and `approval_request_id`** columns both exist (bare UUID, **no FK**) | `FR-SEC-030`; threshold source **GAP-1** | DESIGN REQUIRED | **Phase 1 — unblocked by Governance** |

### Key finding — no new permission code is needed

SRS §15.2 defines **no generic approval permission**. It defines domain-specific
approve codes: `pos.discount.approve`, `cash.variance.approve`,
`purchase.order.approve_tier_1/2/3`, `purchase.invoice.approve_payment`,
`hr.overtime.approve`, `inventory.approve_high_variance`,
`inventory.waste.approve`. The only `governance.*` code is
`governance.view_anomalies`.

`FR-SEC-031` requires the request to carry "the required approver permission" —
i.e. the mechanism **references an existing domain permission as data**. A
Governance phase must therefore invent **zero** permission codes, exactly as
D-17-06 required of Production Spec.

---

## 6. Branch-Scoped RBAC

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-SEC-002` [M] | §15.1 | Role assignments carry a scope: tenant, brand, branch-set, or single branch | **NOT IMPLEMENTED** | `identity.membership_roles.branch_id uuid NULL` exists but is **never read**. `src/modules/identity/context/tenant-context.ts:11` states branchId is "RESERVED — not populated this phase". Deferred by **ADR 0008 D-02** | Organisation (done) | DESIGN PARTIAL — ADR 0008 D-02 records the deferral, not the design | **Phase 1 — Recommended** (prerequisite for PIN) |
| `FR-SEC-003` [M] | §15.1 | A user MAY hold multiple assignments with different scopes | **PARTIAL** | Multiple `membership_roles` rows per membership supported and tested (`test/rbac.e2e-spec.ts`); assignments carry no scope | `FR-SEC-002` | DESIGN PARTIAL | **Phase 1 — Recommended** |
| `FR-SEC-004` [M] | §15.1 | Effective permissions = union within each assignment's own scope; **permissions SHALL NOT leak across scopes** | **PARTIAL** | Union computed per membership; no scope boundary exists, so the non-leakage clause is untestable | `FR-SEC-002` | DESIGN PARTIAL | **Phase 1 — Recommended** |
| `FR-SEC-005` [S] | §15.1 | Assignments support validity dates enabling auto-expiring temporary elevation | **NOT IMPLEMENTED** | No `valid_from`/`valid_to` on `identity.membership_roles` (verified in `information_schema.columns`) | `FR-SEC-002` | DESIGN REQUIRED | **Parallel / Later** — `[S]` priority |

---

## 7. Authentication / Security Hardening

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-SEC-020` [M] | §15.5 | Support email+password, PIN (4–8 digits), employee card, biometric, SSO SAML/OIDC | **PARTIAL** | Email + password implemented (ADR 0001; `test/auth.e2e-spec.ts`). PIN, card, biometric, SSO absent | — | DESIGN PARTIAL | **Split** — see per-method rows |
| `FR-SEC-021` [M] | §15.5 | PIN valid only on registered terminals **within the employee's permitted branches**; never grants dashboard access | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | **`FR-SEC-002` branch scope** (SRS-explicit) + terminal identity (ADR 0004, partial) | DESIGN REQUIRED | **Phase 1 — Recommended** (gates sync approval) |
| `FR-SEC-022` [M] | §15.5 | PINs salted-hashed, unique within a branch, lockout after configurable failures | **NOT IMPLEMENTED** | `identity.credentials` holds Argon2 password hashes only | `FR-SEC-021`; lockout threshold config **GAP-2** | DESIGN REQUIRED | **Phase 1 — Recommended** |
| `FR-SEC-023` [M] | §15.5 | MFA supported for dashboard, enforceable as mandatory per role | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | — | DESIGN REQUIRED | **Later Phase** |
| `FR-SEC-024` [M] | §15.5 | MFA **mandatory** for roles holding `security.user.manage`, `settings.tenant.manage`, `api.key.manage` | **NOT IMPLEMENTED** | Those three codes are not in the implemented permission catalogue either | `FR-SEC-023` | DESIGN REQUIRED | **Later Phase** |
| `FR-SEC-025` [M] | §15.5 | Password policy configurable **per tenant**, min 10 chars, checked against a breached-password list | **PARTIAL** | `assertPasswordMeetsPolicy()` enforces a fixed minimum (ADR 0005). No per-tenant configurability, no breach list | Per-tenant config → `FR-PLT-025` settings (deferred) | DESIGN REQUIRED | **Later Phase** |
| `FR-SEC-026` [M] | §15.5 | Configurable idle expiry: 15 min POS, 60 min dashboard, 8 h KDS | **PARTIAL** | `JWT_ACCESS_TTL=15m` / `JWT_REFRESH_TTL=30d` global (`src/config/env.validation.ts`). No per-surface idle timeout | Surface identity (POS/KDS absent) | DESIGN REQUIRED | **Later Phase** |
| `FR-SEC-027` [M] | §15.5 | Administrator-forced logout of a user's sessions across all devices | **PARTIAL** | Revocation exists internally — password change revokes other sessions, reset revokes all (ADR 0005, `test/password.e2e-spec.ts`). **No administrator-facing surface** | RBAC (done) | DESIGN PARTIAL — mechanism exists, surface undefined | **Phase 1 — Optional / Parallel** (small, self-contained) |
| `FR-SEC-028` [M] | §15.5 | Terminals individually registered; revocation immediately invalidates credentials **and wipes local data on next contact** | **PARTIAL** | Registration, fingerprints, status transitions implemented (ADR 0004; `test/terminal.e2e-spec.ts`). No credential wipe; pairing/activation deferred by ADR 0004 | Offline/local store (absent) for the wipe half | DESIGN PARTIAL | **Later Phase** |

---

## 8. Settings

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-PLT-025` [M] | §6.4 | Hierarchical settings resolver following the SRS precedence | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND. `org.settings` explicitly deferred by **ADR 0008 D-11** | Organisation (done) | DESIGN PARTIAL — ADR 0008 D-11 records deferral | **Phase 1 — Recommended** (unblocks every "configurable" clause) |
| `FR-PLT-026` [M] | §6.4 | Settings lockable at any level, preventing lower-level override; lock level named in UI | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-PLT-025` | DESIGN REQUIRED | **Phase 1 — Recommended** |
| `FR-PLT-027` [S] | §6.4 | Settings inspector showing which level supplied a value and the value at each level | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-PLT-025` | DESIGN REQUIRED | **Later Phase** — `[S]`, UI-facing |
| `FR-PLT-028` [M] | §6.4 | Financial settings versioned with effective dates; historical transactions interpreted with the version **in force at transaction time** | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-PLT-025`; Fiscal + Sales (absent) | DESIGN REQUIRED | **Later Phase** — no transactional consumer exists yet |

> **Precedent warning.** `FR-PLT-028` is temporal-versioning of the same family
> as D-17-08. Any design must be ratified explicitly and must not silently
> import Production Spec's `effective_from` resolution — D-17-08 ratified that
> recipes are selected by **lifecycle state only**, and that decision is not
> transferable.

---

## 9. API Idempotency

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-API-020` [M] | §26.5 | Every POST and PATCH accepts `Idempotency-Key`; **mandatory** on all financially significant endpoints | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND — 0 matches for `idempotenc` in `src/` | — | DESIGN REQUIRED — "financially significant" is undefined (**GAP-3**) | **Phase 1 — Optional / Parallel** |
| `FR-API-021` [M] | §26.5 | Store key, request fingerprint and response for at least 30 days | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND. No idempotency table in the approved SQL (**GAP-4**) | — | DESIGN REQUIRED | **Phase 1 — Optional / Parallel** |
| `FR-API-022` [M] | §26.5 | Repeated key + identical fingerprint returns the stored response with `Idempotent-Replay: true` | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-API-021` | DESIGN REQUIRED — fingerprint algorithm undefined | **Phase 1 — Optional / Parallel** |
| `FR-API-023` [M] | §26.5 | Repeated key + **different** fingerprint returns 409 Conflict | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-API-021` | DESIGN REQUIRED | **Phase 1 — Optional / Parallel** |
| `NFR-REL-011` [M] | §21.10 | At-most-once financial effect for any operation, **enforced by idempotency keys** | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | `FR-API-020`…`023` | DESIGN REQUIRED | **Phase 1 — Optional / Parallel** |

> No financially significant endpoint exists yet (no Sales, Payments,
> Procurement or Finance). Building idempotency now is **cheap and pre-emptive**;
> building it after those domains ship is a retrofit across every write path.

---

## 10. Audit

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-AUD-001` [M] | §20.1 | Immutable audit entry for **every** state-changing operation | **PARTIAL** | `AuditService.record()` called across identity, organisation, catalogue, inventory, production. No mechanism proves universal coverage | — | DESIGN REQUIRED — coverage gate undefined | **Parallel** |
| `FR-AUD-002` [M] | §20.1 | Entry contains the specified fields | **COMPLETE** | `governance.audit_entries` carries actor/entity/action/metadata/correlation; `test/audit.e2e-spec.ts` | — | NO ADDITIONAL DESIGN IDENTIFIED | — |
| `FR-AUD-003` [M] | §20.1 | Append-only; app role holds INSERT+SELECT, never UPDATE/DELETE | **COMPLETE** | ADR 0007; `REVOKE UPDATE, DELETE` verified live (`permission denied`) | — | NO ADDITIONAL DESIGN IDENTIFIED | — |
| `FR-AUD-004` [M] | §20.1 | SHA-256 hash chain per tenant | **COMPLETE** | `src/modules/governance/audit/audit-hash.ts`; unit + E2E tested | — | NO ADDITIONAL DESIGN IDENTIFIED | — |
| `FR-AUD-005` [M] | §20.1 | **Scheduled job** verifies chain integrity; platform security alert on break | **NOT IMPLEMENTED** | Chain is computed but never verified after the fact. No scheduler | Scheduler (§11); alert channel | DESIGN REQUIRED | **Phase 1 — Recommended** |
| `FR-AUD-006` [M] | §20.1 | Enumerated actions always audited (auth, permission, role, price, recipe, discount, comp, void, refund, cash variance, stock adjustment, count, waste, purchase approval, config, export, integration) | **PARTIAL** | Auth, permission/role, price, recipe, stock, count, waste audited. Discounts/comps/voids/refunds/cash variances **cannot** be audited — those domains do not exist | Sales, Finance, Procurement | NO ADDITIONAL DESIGN IDENTIFIED | **Later** (follows each domain) |
| `FR-AUD-007` [M] | §20.1 | Audit log access is itself audited | **NOT IMPLEMENTED** | No audit read surface exists, so there is nothing to audit | `FR-AUD-008` | DESIGN PARTIAL | **Phase 1 — Recommended** (with 008) |
| `FR-AUD-008` [M] | §20.1 | Searchable/filterable by actor, entity, action, date range, branch, correlation ID; exportable with `audit.view` + `report.export` | **NOT IMPLEMENTED** | Data is captured but **completely inaccessible** — no controller in `src/modules/governance/` | `audit.view`, `report.export` (both §15.2-attested, unimplemented) | DESIGN REQUIRED | **Phase 1 — Recommended** |
| `FR-AUD-009` [M] | §20.1 | Retained for the greater of 7 years or the branch jurisdiction's statutory period | **NOT IMPLEMENTED** | No retention policy or enforcement | Jurisdiction data (country packs, absent) | DESIGN REQUIRED | **Later Phase** |
| `FR-AUD-010` [M] | §20.1 | Support impersonation requires recorded reason, time limit, tenant-visible notification, full audit capture | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | Notification channel (Integrations, absent) | DESIGN REQUIRED | **Later Phase** |

---

## 11. Scheduler / Background Jobs

The SRS mandates **outcomes**; only `FR-DR-002`, `FR-AUD-005`, `FR-INV-011`,
`FR-INV-051` and `FR-SEC-061` name a "scheduled job" explicitly. A scheduler is
therefore an **implied capability**, not an SRS requirement in its own right.

| Requirement | SRS Section | Required capability | Current implementation | Gap | Status | Phase Recommendation |
|---|---|---|---|---|---|---|
| `FR-DR-002` [M] | §25.5 | Partitions created automatically ≥3 months ahead, alert on failure | 14 monthly partitions created manually; **no DEFAULT partition** | Automation + alerting | **NOT IMPLEMENTED** | **Phase 1 — Must Do** (live risk) |
| `FR-AUD-005` [M] | §20.1 | Scheduled chain-integrity verification + platform alert | None | Job + alert channel | **NOT IMPLEMENTED** | **Phase 1 — Recommended** |
| `FR-INV-011` [M] | §11 | Levels reconcilable to ledger; **scheduled daily verify**, alert on divergence | On-demand `GET /inventory/reconciliation` (`reconciliation.service.ts`) | Scheduling + alerting | **PARTIAL** | **Phase 1 — Recommended** |
| `FR-INV-051` [M] | §11 | Scheduled job verifies Σmovements = level for every (item, location); platform alert | Same on-demand endpoint | Scheduling + alerting | **PARTIAL** | **Phase 1 — Recommended** |
| `FR-INV-024` [M] | §11 | Expiry alerts at configurable horizons (default 7/3/1 days) | `GET /inventory/expiring` query | Scheduling, delivery, horizon config | **PARTIAL** | **Phase 1 — Recommended** |
| `FR-INV-066` [M] | §11 | Low-stock alerts when available < reorder point | `GET /inventory/low-stock` query | Scheduling + delivery | **PARTIAL** | **Phase 1 — Recommended** |
| `FR-INV-014` [M] | §11 | Negative stock permitted and recorded, **raising an alert** | Permitted + recorded (`costing.ts` shortfall, never blocks) | Alert delivery | **PARTIAL** | **Phase 1 — Recommended** |
| `FR-SEC-061` [M] | §15.9 | Retention periods configurable; scheduled job purges/anonymises past retention | None | Job + retention config | **NOT IMPLEMENTED** | **Later Phase** |

> **`FR-DR-002` is the only operational risk that is live today.**
> `inventory.stock_movements` is RANGE-partitioned with **no DEFAULT partition**;
> inserts past the last boundary (2027-09) will fail hard.

---

## 12. CI/CD / Operational Security

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `FR-PLT-013` [M] | §6.2 | CI executes a cross-tenant isolation suite for **every** `tenant_id` table | **PARTIAL** | Four RLS suites exist (`rls`, `catalogue-rls`, `inventory-rls`, `production-rls`) — comprehensive but **not exhaustive per table**, and **no CI runs them** | CI | DESIGN PARTIAL | **Phase 1 — Recommended** |
| `FR-PLT-014` [M] | §6.2 | CI **fails** if any `tenant_id` table lacks enabled+forced RLS | **NOT IMPLEMENTED** | No `.github` directory anywhere in the repository | CI | NO ADDITIONAL DESIGN IDENTIFIED — the query is trivial | **Phase 1 — Must Do** |
| `FR-SEC-048` [M] | §15.8 | Parameterised queries exclusively; concatenated SQL **fails static analysis** | **PARTIAL** | Prisma parameterises; the single `$queryRawUnsafe` in `reconciliation.service.ts` uses bound parameters. **No static-analysis gate** | CI | NO ADDITIONAL DESIGN IDENTIFIED | **Phase 1 — Recommended** |
| `FR-SEC-049` [M] | §15.8 | Dependencies scanned every build; build fails on critical findings | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | CI | NO ADDITIONAL DESIGN IDENTIFIED | **Phase 1 — Recommended** |
| `FR-SEC-050` [M] | §15.8 | Secrets injected at runtime from a secret manager, never in images or repos | **NOT IMPLEMENTED** | `.env` file (correctly gitignored and untracked) | Deployment platform | DESIGN REQUIRED | **Later Phase** |
| `FR-OPS-003` [M] | §24.1 | All infrastructure as code (Terraform), reviewed and version controlled | **NOT IMPLEMENTED** | Only `docker-compose.yml` for a local Postgres | Deployment platform | DESIGN REQUIRED | **Later Phase** |
| `FR-OPS-004` [M] | §24.1 | Container images signed, scanned, with an SBOM | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | CI + registry | DESIGN REQUIRED | **Later Phase** |
| `FR-DR-010` [M] | §25.5 | Versioned, forward-only migrations in source control | **COMPLETE** | 14 migrations in `prisma/migrations/`; `migrate status` clean; drift clean | — | NO ADDITIONAL DESIGN IDENTIFIED | — |
| `FR-DR-011` [M] | §25.5 | Migrations backward compatible with the previously deployed app version | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND — no expand/migrate/contract process, no staging validation | Deployment platform | DESIGN REQUIRED | **Later Phase** |

---

## 13. Observability / NFR

| Requirement | SRS Section | Requirement Summary | Current Status | Existing Evidence | Dependency | Design Status | Phase Recommendation |
|---|---|---|---|---|---|---|---|
| `NFR-OBS-001` | §27 | Structured JSON logs with tenant, branch, correlation, causation ids | **PARTIAL** | `governance.audit_entries.correlation_id` exists. **No logging pipeline** — no pino/winston, no request correlation middleware | — | DESIGN REQUIRED | **Phase 1 — Recommended** |
| `NFR-OBS-002` | §27 | Distributed tracing across API, workers, database | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | — | DESIGN REQUIRED | **Later Phase** |
| `NFR-OBS-003` | §27 | RED metrics per endpoint and handler | **NOT IMPLEMENTED** | NO IMPLEMENTATION EVIDENCE FOUND | — | DESIGN REQUIRED | **Later Phase** |
| `NFR-OBS-004` | §27 | Business metrics (orders/min, sync backlog, fiscal failures, offline terminals) | **NOT IMPLEMENTED** | Every named metric belongs to an unimplemented domain | Sales, Sync, Fiscal | NO ADDITIONAL DESIGN IDENTIFIED | **Later Phase** |
| `NFR-OBS-005` | §27 | No PII or secrets in logs, enforced by a redaction layer with an allowlist | **NOT IMPLEMENTED** | `sanitizeMetadata()` exists for audit metadata only, not for logs | `NFR-OBS-001` | DESIGN REQUIRED | **Phase 1 — Recommended** (with 001) |
| `NFR-OBS-006` | §27 | Alerts for every SLO breach with documented runbooks | **NOT IMPLEMENTED** | No SLOs defined, no alerting | `NFR-OBS-003` | DESIGN REQUIRED | **Later Phase** |
| `NFR-OBS-007` | §27 | Per-tenant health view for support without database access | **NOT IMPLEMENTED** | `GET /health` returns a static payload only | — | DESIGN REQUIRED | **Later Phase** |

> No NFR is marked COMPLETE. **48 of 52 NFRs project-wide have no measurement
> capability at all**; a partial technical mechanism is never treated as
> satisfaction.

---

## 14. Cross-Domain Dependencies

```
                          ADR 0008 D-02 (deferred)
                                    |
                          FR-SEC-002  branch-scoped RBAC
                                    |
                    +---------------+----------------+
                    |                                |
        FR-SEC-021/022  PIN auth            FR-SEC-003/004 scope union
                    |
        FR-SEC-032  synchronous approval (manager PIN on terminal)
                    |
+-------------------+------------------------------------------+
|                                                              |
|   FR-SEC-030/031/033  APPROVAL WORKFLOW  <---- approved SQL 13 exists
|                    |                                          |
|      +-------------+-------------+-------------+              |
|      v             v             v             v              |
|  FR-INV-032   FR-INV-035    FR-INV-046/047  FR-INV-058        |
|  (transfer)   (adjustment)  (count)         (waste)           |
|      |                                                        |
|      +--> future: Sales discounts/voids/refunds,              |
|           Procurement PO approval, Finance cash variance      |
+---------------------------------------------------------------+

     FR-PLT-025 settings resolver (ADR 0008 D-11, deferred)
                    |
        +-----------+-----------+-----------+
        v           v           v           v
   INV thresholds  SEC-022    SEC-025     SEC-034
   (GAP-1)         lockout    pw policy   escalation period

     SCHEDULER (implied capability, not an SRS requirement)
                    |
        +-----------+-----------+-----------+-----------+
        v           v           v           v           v
   FR-DR-002   FR-AUD-005  FR-INV-011/051  FR-INV-024/066  FR-SEC-061

     CI PIPELINE (absent)
                    |
        +-----------+-----------+
        v           v           v
   FR-PLT-013  FR-PLT-014  FR-SEC-048/049
```

### Reverse dependencies

- **`FR-SEC-032` sync approval → `FR-SEC-021/022` PIN → `FR-SEC-002` branch scope.**
  SRS-EXPLICIT, not inferred: FR-SEC-032 names "manager PIN on the terminal", and
  FR-SEC-021 requires PIN to be valid only "within the employee's permitted
  branches", which requires branch-scoped assignments.
- **`FR-SEC-032` async approval → notification channels** (SRS §Integrations
  `IR-INT-04x`). Integrations is unimplemented.
- **`FR-SEC-034` escalation → scheduler + settings.**
- **`FR-SEC-035` offline policy → Offline/Sync + Reporting.**

### Potential dependencies requiring confirmation

- **`waste_records.approval_request_id` → `governance.approval_requests`.**
  The column exists as a **bare UUID with no FK**. Whether Governance adds the
  composite tenant-safe FK (touching an Inventory table) is
  **POTENTIAL DEPENDENCY — REQUIRES DESIGN CONFIRMATION**.
- **`count_sessions` has `requires_approval` but no `approval_request_id`**, and
  the approved SQL defines neither for that table. Linking count sessions to
  approvals would require an **Inventory schema change** —
  **POTENTIAL DEPENDENCY — REQUIRES DESIGN CONFIRMATION**.

---

## 15. Phase 1 Recommended Scope

### Must Do

| Requirements | Rationale |
|---|---|
| `FR-SEC-030`, `FR-SEC-031`, `FR-SEC-033` | The approval workflow core. Five Inventory requirements are dead-ended inside a **closed** phase; nothing can grant approval today |
| `FR-DR-002` | The only live operational risk: no DEFAULT partition, manual creation, hard failure after 2027-09 |
| `FR-PLT-014` | Mandatory CI gate; the partition-RLS bypass proved green tests ≠ a secure boundary |

### Recommended

`FR-SEC-002`/`003`/`004` (branch-scoped RBAC — prerequisite for PIN and therefore
for synchronous approval) · `FR-PLT-025`/`026` (settings resolver — unblocks every
"configurable threshold" clause, including **GAP-1**) · `FR-AUD-005`, `FR-AUD-007`,
`FR-AUD-008` (audit is write-only today) · `FR-INV-011`/`024`/`051`/`066`/`014`
(scheduling and alert delivery only — the logic already exists) ·
`FR-PLT-013`, `FR-SEC-048`, `FR-SEC-049` (CI gates) · `NFR-OBS-001`/`005`
(no NFR is assertable without measurement) · `FR-SEC-021`/`022` (PIN, if
synchronous approval is wanted in Phase 1)

### Parallel

`FR-API-020`…`023` + `NFR-REL-011` (idempotency — no financially significant
endpoint exists yet, so this is pre-emptive and cheap now, a retrofit later) ·
`FR-SEC-027` (admin forced-logout surface — mechanism already exists) ·
`FR-AUD-001` coverage gate

### Later

`FR-SEC-023`/`024` MFA · `FR-SEC-025` per-tenant password policy · `FR-SEC-026`
per-surface idle expiry · `FR-SEC-028` credential wipe · `FR-SEC-034` escalation ·
`FR-SEC-035` offline policy · `FR-SEC-050`, `FR-OPS-003`, `FR-OPS-004`,
`FR-DR-011` · `FR-PLT-027`, `FR-PLT-028` · `FR-AUD-009`, `FR-AUD-010`,
`FR-SEC-061` · `NFR-OBS-002`/`003`/`004`/`006`/`007`

### Blocked

`FR-INV-032`, `FR-INV-035`, `FR-INV-046`, `FR-INV-047`, `FR-INV-058` — all
blocked solely on `FR-SEC-030`. They unblock the moment the approval core ships.

### Requires Decision

`FR-SEC-031` (three SRS-mandated fields absent from the approved SQL) ·
`FR-SEC-032` (which half is in scope) · threshold configuration (**GAP-1**) ·
idempotency scope and storage (**GAP-3**, **GAP-4**) · the two potential
Inventory-boundary dependencies in §14

---

## 16. Requirements Explicitly NOT Pulled Into Phase 1

| Requirement(s) | Reason |
|---|---|
| `FR-SEC-023`, `FR-SEC-024` MFA | Security hardening, not a Governance dependency. FR-SEC-024 is mandatory only for three permission codes that are not yet implemented |
| `FR-SEC-026` per-surface idle expiry | The surfaces it names (POS, KDS) do not exist |
| `FR-SEC-028` credential wipe | Requires an offline local store; Offline domain absent |
| `FR-SEC-034` escalation | `[S]` priority; needs both scheduler and settings |
| `FR-SEC-035` offline approval policy | Requires Offline/Sync and Reporting |
| `FR-PLT-027` settings inspector | `[S]`, UI-facing; no client surface in this repository |
| `FR-PLT-028` financial setting versioning | No transactional consumer exists; risks contaminating the D-17-08 precedent |
| `FR-AUD-009`, `FR-SEC-061` retention | Depends on jurisdiction data from country packs (absent) |
| `FR-AUD-010` impersonation | Requires notification channels (Integrations, absent) |
| `FR-OPS-003`/`004`, `FR-SEC-050`, `FR-DR-011` | Deployment-platform concerns, not application capability |
| `NFR-OBS-002`/`003`/`004`/`006`/`007` | Depend on a logging/metrics foundation that `NFR-OBS-001` must establish first |
| `FR-AUD-006` remaining actions | The domains that would emit them do not exist |

**Scope-control principle applied:** "security-related" was not treated as
equivalent to "Phase 1". Requirements were separated into foundational platform
capability, Governance dependency, security hardening, operational
infrastructure and domain functionality. Only the first two, plus the single
live operational risk, are recommended as Must Do.

---

## 17. Open Gaps

| ID | Gap | SRS position | Impact |
|---|---|---|---|
| **GAP-1** | **Threshold configuration is undefined.** `FR-INV-035`, `FR-INV-046`, `FR-INV-047`, `FR-INV-058` all require a "configurable value threshold"; the SRS never states where thresholds live, who sets them, or their precedence | SRS requires the behaviour, defines no mechanism | Blocks completion of 4 Inventory requirements. Inventory B-2 explicitly deferred this to Governance |
| **GAP-2** | **PIN lockout threshold** ("configurable number of failures") has no defined configuration home | Same class as GAP-1 | Blocks `FR-SEC-022` completion |
| **GAP-3** | **"Financially significant endpoints"** is never enumerated by the SRS | `FR-API-020` | Cannot determine where `Idempotency-Key` is mandatory |
| **GAP-4** | **No idempotency table** exists in the approved SQL despite `FR-API-021` requiring 30-day storage of key, fingerprint and response | Approved SQL omission | Schema deviation required |
| **GAP-5** | **`FR-SEC-031` field shortfall.** The approved SQL `governance.approval_requests` lacks `value`, `required_permission` and `expiry`, all three SRS-mandated | Approved SQL omission | Schema deviation required |
| **GAP-6** | **`count_sessions` cannot reference an approval.** It has `requires_approval` but no `approval_request_id`, and the approved SQL defines neither | Approved SQL omission | Linking requires an Inventory schema change |
| **GAP-7** | **`waste_records.approval_request_id` is a bare UUID with no FK**, contrary to ADR 0008 D-09's composite tenant-safe FK principle | Implementation/design tension | Cross-tenant approval reference is currently representable |
| **GAP-8** | **Alert delivery channel undefined** for `FR-AUD-005`, `FR-INV-011/014/024/051/066`. The SRS says "alert" without naming a transport | SRS requires outcome, not mechanism | Scheduling can ship; delivery cannot |

---

## 18. Design Decisions Required Before Implementation

1. **Approval request schema deviation (GAP-5).** Add `value`,
   `required_permission` and `expiry` to `governance.approval_requests`? All
   three are SRS-mandated by `FR-SEC-031` and absent from the approved SQL.
2. **Approval scope for Phase 1 (`FR-SEC-032`).** Synchronous only, both halves,
   or neither? Synchronous requires PIN (`FR-SEC-021/022`), which requires
   branch-scoped RBAC (`FR-SEC-002`). Async requires Integrations.
3. **Permission model.** Confirm that **no new permission code is created** and
   that `required_permission` references existing §15.2 domain codes as data.
4. **Threshold ownership (GAP-1/GAP-2).** Does Governance own threshold
   evaluation, or is it deferred again? Inventory B-2 ratified that Inventory
   owns the *gate* only and Governance owns *when approval is required* — that
   determination is still undefined.
5. **Inventory boundary (GAP-6/GAP-7).** May the Governance phase alter
   `inventory.waste_records` (add an FK) and `inventory.count_sessions` (add
   `approval_request_id`)? Both are closed phases.
6. **Immutability mechanism for `FR-SEC-033`.** ADR 0007 full REVOKE, or the
   Production GAP-2 column-level grant pattern? Decisions may need a status
   transition, which would rule out a blanket REVOKE.
7. **Self-approval prohibition.** The approved SQL carries two placeholder
   constraints, `ck_requester_not_approver CHECK (true)` and
   `ck_approver_not_requester CHECK (true)`, explicitly commented "enforced by
   app". SRS §15.4 requires *blocking*, not warning. Database-level or service-level?
8. **Scheduler selection.** `@nestjs/schedule`, external cron, or database-native?
   Affects `FR-DR-002`, `FR-AUD-005` and five Inventory alert requirements.
9. **Alert transport (GAP-8).**
10. **Idempotency scope and storage (GAP-3/GAP-4).**
11. **Settings resolver design (`FR-PLT-025`)**, currently deferred by ADR 0008 D-11,
    and whether it must land before or alongside thresholds.

---

## 19. Proposed Next Design Gate

A **Governance Approval Workflow Design Gate**, following the established
discovery → blockers → ratification → implementation pattern. It must contain:

1. **Status** and authoritative sources, including approved SQL §13 verbatim.
2. **Requirements in scope** — `FR-SEC-030`, `031`, `033` at minimum; explicit
   disposition of `032`, `034`, `035`.
3. **Domain model** for `approval_requests`, `approval_steps`,
   `approval_decisions`, with every deviation from the approved SQL enumerated
   and justified (GAP-5 is unavoidable).
4. **Tenant isolation** — `tenant_id` placement, `UNIQUE (tenant_id, id)`,
   composite tenant-safe FKs per ADR 0008 D-09, ENABLE + FORCE RLS with the
   standard predicate, four policies per table.
5. **Immutability design** for `FR-SEC-033` (decision 6 above).
6. **Self-approval prohibition** (decision 7), replacing the `CHECK (true)`
   placeholders.
7. **Permission mapping** — proving zero new codes.
8. **Integration contract with Inventory** — how `requires_approval` transitions
   from refuse to permit, and whether Inventory tables may be altered
   (decision 5). This is the boundary question most likely to trigger a STOP.
9. **Threshold ownership** (decision 4) — explicitly, since B-2 deferred it here.
10. **API surface**, resolving the unratified `/v1` prefix deviation recorded in
    `docs/RECONCILIATION_POST_PRODUCTION.md` §15-D1.
11. **Explicit exclusions** — no scheduler, no notifications, no escalation, no
    offline policy, no new permissions, no SoD.
12. **Test matrix** — RLS with positive controls, immutability, self-approval
    rejection, the Inventory gate transitioning to permit.
13. **Open questions requiring ratification before implementation.**

---

## 20. Conclusion

**66 requirements mapped** across nine candidate areas: **4 COMPLETE**,
**17 PARTIAL**, **5 BLOCKED**, **40 NOT IMPLEMENTED**, **0 OUT OF SCOPE**,
**0 GAP-status** — with **8 design-level gaps** recorded separately in §17,
because none of them is a requirement whose *status* is ambiguous; each is a
requirement whose *implementation route* is undefined.

Phase 1 should be **narrow**: the approval workflow core
(`FR-SEC-030`/`031`/`033`), partition automation (`FR-DR-002`), and the RLS CI
gate (`FR-PLT-014`) as Must Do — with branch-scoped RBAC, the settings resolver,
audit querying and job scheduling as Recommended. Everything else is explicitly
held back in §16.

**The exact next action:** author the **Governance Approval Workflow Design
Gate** described in §19 as a read-only discovery-and-design task, surfacing the
eleven decisions in §18 for ratification. No implementation may begin until that
gate is ratified.

**Nothing in this document authorises implementation.**
