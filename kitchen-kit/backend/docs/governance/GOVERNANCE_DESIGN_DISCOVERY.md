# ROS Governance — Design Discovery

**Task:** P1-004. READ-ONLY architecture and requirements analysis.
**Date:** 2026-08-17
**Branch:** `feat/production-spec` @ `896b572e48be1b8499e6f5e896464f14469fe168`

No source, schema, migration, test, configuration, RLS policy or permission was
created or modified. This document is the sole artifact. **It is not a design
gate and it authorises nothing.**

---

## 1. Purpose

Establish, from source evidence only, what the SRS actually requires of the
Governance approval workflow; what the approved SQL already provides; what the
repository already implements; and precisely which decisions must be ratified
before a design gate can be written.

Where sources conflict, the conflict is documented rather than resolved. Where
the SRS is silent, a **GAP** is recorded and no solution is proposed.

---

## 2. Authoritative Sources

| # | Source | What was inspected |
|---|---|---|
| 1 | `ROS_SRS_v1.0.pdf` | §15.1 access control, §15.2 permission catalogue, §15.4 SoD, §15.5 authentication, §15.6 Approval Workflow Engine, §20.1 audit, §26.2 error model, §26.3 endpoints, plus all 36 requirements referencing approval |
| 2 | `ROS_DrawDB_Compatible_v3.sql` §13 GOVERNANCE | `approval_requests`, `approval_steps`, `approval_decisions`, `anomaly_flags`, `audit_entries` — read verbatim |
| 3 | ADR 0001–0008 | 0002 tenant context, 0003 RLS, 0004 terminal identity, 0007 audit trail, 0008 D-02/D-09/D-11 |
| 4 | Design gates | `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md`, `docs/inventory/INVENTORY_DESIGN_GATE.md`, `INVENTORY_PHASE_CLOSEOUT.md` |
| 5 | `docs/reconciliation/PHASE_1_SRS_REQUIREMENT_MAP.md` | Prior analysis — **independently re-verified, and two errors found (§23)** |
| 6 | Inventory implementation | `waste.service.ts`, `counts.service.ts`, `transfers.service.ts`, `inventory.permissions.ts` |
| 7 | Identity/RBAC | `permissions.service.ts`, `roles.service.ts`, `membership-roles.service.ts`, `guards/permission.guard.ts`, `context/tenant-context.ts` |
| 8 | Audit implementation | `audit.service.ts`, `audit-hash.ts`, **`audit-verify.ts`**, `audit.constants.ts` |
| 9 | Live database | `pg_class`, `pg_policies`, `pg_constraint`, `information_schema` (read-only) |
| 10 | Tests | 9 relevant suites, enumerated in §22 |

Precedence: the SRS governs requirements; ratified ADRs and design gates govern
already-decided architecture.

---

## 3. Current Repository Baseline

Carried from P1-002 (verified, not re-run): build/lint/typecheck PASS, Prisma
valid, 14 migrations up to date, drift clean, unit 153/153, E2E 318/318.

**Governance schema, live:** exactly one table — `audit_entries`.
RLS enabled + forced, **2 policies** (SELECT, INSERT only), `ros_app` grants
`INSERT, SELECT`. No approval table exists.

---

## 4. Governance Requirements

### 4.1 Primary — SRS §15.6, verbatim

| Req | Pri | Text |
|---|---|---|
| `FR-SEC-030` | [M] | "provide a general approval mechanism used by discounts, refunds, purchase orders, waste, count adjustments, expenses, and price changes" |
| `FR-SEC-031` | [M] | "Approval requests SHALL specify: the requesting user, the action, the affected entity, **the value**, **the required approver permission**, and **an expiry**" |
| `FR-SEC-032` | [M] | "obtainable synchronously (**manager PIN on the terminal**) or asynchronously (**push notification** to the manager's mobile device), with the terminal remaining usable while awaiting an asynchronous decision" |
| `FR-SEC-033` | [M] | "Approval decisions SHALL record approver, timestamp, decision, and any comment, and SHALL be **immutable**" |
| `FR-SEC-034` | [S] | "escalation: if no decision is made within a configured period, the request escalates to **the next approval level**" |
| `FR-SEC-035` | [M] | "Where an operation must proceed offline and no approver is present … configurable policy: block the operation, or permit it with mandatory retrospective approval flagged in an exception report" |

### 4.2 Directly binding on Governance, outside §15.6

| Req | Pri | Why it binds |
|---|---|---|
| `FR-SEC-016` | [M] | **BLOCK, not warn**, on approving one's own requisition / discount / cash variance, and posting a count one performed "where the tenant has enabled strict SoD" |
| `FR-PRC-019` | [M] | "the requester SHALL NOT be an approver of their own requisition or order" |
| `FR-PRC-018` | [M] | Defines a **multi-band, multi-level** approver model: below threshold 1 auto-approved; T1–T2 Branch Manager; T2–T3 Operations Director; above T3 Tenant Owner |
| `FR-POS-047` | [M] | Threshold configuration dimensions: **"Per role, per branch"** |
| `FR-AUD-006` | [M] | Purchase approvals must always generate audit entries |

### 4.3 Complete approval-dependent set — 36 requirements reference approval

**Verified against the SRS, not assumed.**

| Domain | Requirements |
|---|---|
| Inventory (implemented) | `FR-INV-032`, `FR-INV-035`, `FR-INV-047`, `FR-INV-050`, `FR-INV-058` |
| Sales / POS | `FR-POS-047`, `048`, `049`, `073`, `075`, `BR-POS-003` |
| Procurement | `FR-PRC-010`, `018`, `019`, `020`, `021`, `022`, `023`, `033`, `042` |
| Finance | `FR-FIN-006`, `015`, `017` |
| Workforce | `FR-HRM-016`, `017`, `034` |
| Branch ops | `FR-BRN-016` |
| Security / Audit | `FR-SEC-016`, `030`–`035`, `FR-AUD-006` |

> **Correction to P1-003.** `FR-INV-046` is **not** an approval dependency. Its
> text is: "Variances exceeding a configurable threshold … SHALL require **a
> recount or a written explanation** before posting." It never mentions
> approval. The Phase 1 map and the Inventory closeout both listed it among the
> approval-blocked set. See §23 Conflict C-1.
>
> `FR-INV-050` **is** an approval dependency and was missed by both — it requires
> count sessions to retain "recounts, and **approvals**".

---

## 5. Current Governance Data Model

### 5.1 Exists in the live database

Only `governance.audit_entries` — 25 columns, RLS enabled + forced, 2 policies
(SELECT, INSERT), `ros_app` holds `INSERT, SELECT` only, `UNIQUE (tenant_id,
sequence_no)`, SHA-256 hash chain per tenant (ADR 0007).

**Two columns already exist for approval linkage and are currently unused:**
`approver_id UUID NULL` and `approval_id UUID NULL`. They are present in both
the approved SQL and the shipped Prisma model.

### 5.2 Exists in the approved SQL only — NOT implemented

Reproduced exactly; no column is inferred.

```sql
CREATE TABLE governance.approval_requests (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    request_type  VARCHAR(32) NOT NULL,   -- discount, void, refund, po, expense, waste
    entity_type   VARCHAR(48) NOT NULL,
    entity_id     UUID NOT NULL,
    requested_by  UUID NOT NULL REFERENCES identity.users(id),
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_requester_not_approver CHECK (true)
);
CREATE TABLE governance.approval_steps (
    id                  UUID PRIMARY KEY,
    approval_request_id UUID NOT NULL REFERENCES governance.approval_requests(id) ON DELETE CASCADE,
    sequence            SMALLINT NOT NULL,
    approver_role_id    UUID REFERENCES identity.roles(id)
);
CREATE TABLE governance.approval_decisions (
    id               UUID PRIMARY KEY,
    approval_step_id UUID NOT NULL REFERENCES governance.approval_steps(id) ON DELETE CASCADE,
    approver_id      UUID NOT NULL REFERENCES identity.users(id),
    decision         VARCHAR(16) NOT NULL,   -- approved, rejected
    reason           TEXT,
    decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_approver_not_requester CHECK (true)
);
```

### 5.3 Exact current-state findings

| Aspect | Finding |
|---|---|
| Tenant isolation | `tenant_id` on `approval_requests` only. **`approval_steps` and `approval_decisions` have no `tenant_id`** |
| RLS | **None defined** for any approval table in the approved SQL |
| Grants | **None defined** |
| Indexes | **None defined** |
| Uniqueness | Primary keys only. No `(tenant_id, id)`, no uniqueness on `(request, sequence)` |
| Composite tenant-safe FKs | **None.** All FKs are single-column, contrary to ADR 0008 D-09 |
| Immutability | **No mechanism.** No REVOKE, no append-only pattern |
| Timestamps | `created_at`, `decided_at`. **No `updated_at`, no `resolved_at`** |
| Self-approval | Two constraints that are literal no-ops: `CHECK (true)`, commented "enforced by app" |
| `FR-SEC-031` fields | **`value` MISSING · `required_permission` MISSING · `expiry` MISSING** |

### 5.4 FR-SEC-031 discrepancy — verified against the actual source

P1-003 flagged this; it is **CONFIRMED by direct inspection**.

| FR-SEC-031 element | Column in approved SQL | Status |
|---|---|---|
| requesting user | `requested_by` | PRESENT |
| the action | `request_type` (+ `entity_type`) | PRESENT (naming differs) |
| affected entity | `entity_type` + `entity_id` | PRESENT |
| **the value** | — | **MISSING** |
| **required approver permission** | — | **MISSING** (`approval_steps.approver_role_id` references a **role**, not a permission) |
| **an expiry** | — | **MISSING** |

The `approver_role_id` substitution is itself a conflict: FR-SEC-031 says
*permission*, the approved SQL models *role*. See §23 Conflict C-2.

---

## 6. Approval Lifecycle

| Lifecycle element | SRS-defined | Existing-design-defined | Not defined |
|---|---|---|---|
| Request creation | Implied by FR-SEC-030/031 (fields enumerated) | `approval_requests` table | **Who may create; whether creation is caller-driven or system-derived from a threshold** |
| Who can create | — | — | **Not defined** |
| Entity/action represented | `FR-SEC-031` (action, affected entity); `request_type` enumerated in the SQL comment as discount, void, refund, po, expense, waste | `request_type`, `entity_type`, `entity_id` | The enumeration omits **count adjustments** and **price changes**, which FR-SEC-030 requires |
| Approver selection | `FR-SEC-031` "required approver permission"; `FR-PRC-018` value-band → approver level | `approval_steps.approver_role_id` | **Permission-vs-role conflict (C-2)**; how bands map to steps |
| Approval recorded | `FR-SEC-033` (approver, timestamp, decision, comment) | `approval_decisions` | — |
| Rejection recorded | `FR-SEC-033` ("decision"); SQL comment `approved, rejected` | `decision VARCHAR(16)` | — |
| After approval | — | — | **Not defined.** Whether Governance calls back, or the caller re-submits |
| After rejection | — | — | **Not defined** |
| After expiry | `FR-SEC-031` requires an expiry to exist | — | **What expiry *does* is not defined** |
| Cancellation | — | — | **Not defined** |
| Requests editable | — | — | **Not defined** |
| Approval revocable | — | — | **Not defined** |
| Multiple steps | `FR-PRC-018` value bands with distinct approvers | `approval_steps` (plural, with `sequence`) | — |
| Sequential approval | `FR-SEC-034` "escalates to the **next** approval level"; `approval_steps.sequence` | `sequence SMALLINT` | — |
| Parallel approval | — | — | **Not defined.** No source describes concurrent approvers |

**Assessment:** the SRS defines the *inputs* and the *decision record* well, and
`FR-PRC-018` + `approval_steps.sequence` establish sequential multi-level
approval. It defines almost nothing about **what happens after a decision** —
that is the single largest lifecycle gap (GAP-3).

---

## 7. Approval Decision Model

`FR-SEC-033` verbatim: *"Approval decisions SHALL record approver, timestamp,
decision, and any comment, and SHALL be immutable."*

| Element | Explicit SRS requirement | Approved SQL | Assumption risk |
|---|---|---|---|
| Approver identity | YES | `approver_id → identity.users(id)` | — |
| Decision | YES | `decision VARCHAR(16)`; comment says `approved, rejected` | Enumeration is a **comment**, not a constraint |
| Timestamp | YES | `decided_at TIMESTAMPTZ DEFAULT now()` | — |
| Reason/comment | YES ("any comment" — optional) | `reason TEXT NULL` | — |
| **Immutability** | **YES, explicit** | **No mechanism** | Must be designed |
| Tenant isolation | Not stated for decisions specifically | **No `tenant_id`** | Inheritance vs. own column — design decision |
| Audit relationship | `FR-AUD-006` requires purchase approvals audited; `audit_entries.approval_id`/`approver_id` exist | Columns exist, unused | Whether every decision writes an audit entry is **not stated** |
| Duplicate decisions | — | Nothing prevents two decisions on one step | **Not defined** (GAP-7) |
| Ordering | Implied by `approval_steps.sequence` | `sequence SMALLINT`, not unique | Uniqueness not constrained |
| Multiple approvers | `FR-PRC-018` implies one approver per level | One decision row per step | Parallel approval **not defined** |

**Self-approval is a hard requirement, not a soft one.** `FR-SEC-016` requires
the system to **block**; `FR-PRC-019` restates it for procurement. The approved
SQL encodes this only as `CHECK (true)` — a no-op with an explanatory comment.

---

## 8. Permission Model

### 8.1 Existing infrastructure

- Catalogue: `identity.permissions` seeded per module; `IDENTITY_PERMISSION_DEFS`, `ORGANISATION_*`, `CATALOGUE_*`, `INVENTORY_*`, `PRODUCTION_*`
- Assignment chain: `roles` → `role_permissions` → `membership_roles` → `memberships`
- Resolution: `TenantContextService.require(request)` returns a permission `Set`; `PermissionGuard` tests `some`/`every` (`guards/permission.guard.ts:44-49`)
- Scope: **tenant only.** `membership_roles.branch_id` exists but is never read; `tenant-context.ts:11` records it as "RESERVED — not populated this phase" (ADR 0008 D-02)

### 8.2 What the SRS defines

**SRS §15.2 defines no generic approval permission.** It defines domain-specific
approve codes: `pos.discount.approve`, `cash.variance.approve`,
`purchase.order.approve_tier_1/2/3`, `purchase.invoice.approve_payment`,
`hr.overtime.approve`, `inventory.approve_high_variance`,
`inventory.waste.approve`. The only `governance.*` code is
`governance.view_anomalies`.

`FR-SEC-031` requires the request to carry "**the required approver
permission**". Combined with §26.2's error example — whose `meta` block is
literally `{ "requiredPermission": "pos.discount.approve" }` — the SRS
consistently treats the approval permission as **data on the request naming an
existing domain permission**, never as a new permission code.

### 8.3 Conclusions

| Question | Answer | Evidence |
|---|---|---|
| Is an approval permission explicitly defined? | **No generic one** | §15.2 catalogue |
| Does the SRS define a fixed approval permission? | **No** | §15.2 |
| Is approval authority based on the requested action's permission? | **Yes** | `FR-SEC-031` + §26.2 `meta.requiredPermission` |
| Is `required_permission` explicitly defined? | **Yes as a requirement, absent from the schema** | `FR-SEC-031` vs approved SQL |

**A Governance phase should invent zero permission codes**, exactly as D-17-06
required of Production Spec. `approval_steps.approver_role_id` (a role FK)
contradicts this permission-based model — Conflict C-2.

**No `DESIGN GAP — PERMISSION MODEL` is raised for the authority model itself**;
it is source-defined. The gap is the *missing column* (GAP-1) and the
*role-vs-permission conflict* (C-2). One question does remain open: whether
reading/listing approval requests needs a permission at all, since §15.2
provides none — recorded as GAP-9.

---

## 9. Tenant / Branch Scope

| Aspect | Finding |
|---|---|
| Tenant scope | `approval_requests.tenant_id` present. `approval_steps` and `approval_decisions` have **none** |
| Branch scope | **The SRS never states the scope of an approval request.** `FR-POS-047` says thresholds are configured "per role, per branch", and `audit_entries` carries `branch_id` — but no requirement scopes the *request* to a branch |
| Brand scope | Not mentioned in any approval requirement |
| Membership/role | `approval_steps.approver_role_id → identity.roles(id)` is the only linkage |
| Authorization context | Tenant-scoped only today (ADR 0008 D-02 deferral) |
| RLS | None defined for approval tables |

**GAP-5 — approval request scope is not SRS-defined.** Whether an approval
request is tenant-scoped or branch-scoped cannot be determined from the sources.
This matters directly: `FR-SEC-021` requires PIN to be valid only "within the
employee's permitted branches", so synchronous approval implies branch semantics
the approval model does not define.

---

## 10. Inventory Dependencies

| Req | Current behavior (exact source) | Expected approval behavior | Missing dependency | Proposed integration boundary | Design question |
|---|---|---|---|---|---|
| `FR-INV-032` | `transfers.service.ts` records a discrepancy as a separate `manual_adjustment` (D-INV-06), E2E tested | Discrepancy record "requiring investigation and approval" | Approval workflow; "investigation" is undefined | Governance reads/writes only its own tables; Inventory unchanged | Is "investigation" a state, a report, or a role action? **Not SRS-defined** |
| `FR-INV-035` | Reason code + `inventory.adjust` permission + `ck_reason_required` enforced | Approval above a configurable value threshold | Approval workflow **and** threshold source | Threshold evaluation must sit outside Inventory (B-2) | Where does the threshold live? (GAP-2) |
| `FR-INV-047` | `counts.service.ts:237` — `if (session.requiresApproval) throw new ForbiddenException(...)`. `count_sessions.requires_approval` column exists | Approval-requiring for high-value adjustments | Approval workflow; **`count_sessions` has no `approval_request_id`** | Linking requires an **Inventory schema change** | May a Governance phase alter a closed Inventory table? (Decision D-5) |
| `FR-INV-050` | Count history retained (`count_sessions`, `count_lines`, recount linkage) | History must include **approvals** | Approval workflow + a link from session to request | Same as `FR-INV-047` | Same |
| `FR-INV-058` | `waste.service.ts:46` — same refuse-with-403 pattern. `waste_records` has **both** `requires_approval` **and** `approval_request_id` | Manager approval above a configurable value threshold | Approval workflow; threshold source | `approval_request_id` exists but is a **bare UUID with no FK** | Add a composite tenant-safe FK per D-09? That alters a closed Inventory table (Decision D-5) |

**Current gate semantics (ratified as B-2):** `requiresApproval` is
**caller-supplied**; when true the operation is **refused with 403**, never
completed unapproved. Two E2E tests protect this
(`test/inventory.e2e-spec.ts:570`, `:625`). Any Governance integration must
transition these from *refuse* to *permit-when-approved* without weakening the
refusal path.

**Asymmetry, verified:** `waste_records` has `approval_request_id`;
`count_sessions` does not; the approved SQL defines it for neither table
(`count_sessions` has no approval column at all in the approved SQL — the
shipped `requires_approval` is itself an Inventory-phase deviation).

---

## 11. PIN Authentication Dependency

| Question | Answer |
|---|---|
| Already implemented? | **No.** No PIN code anywhere in `src/modules`; `identity.credentials` stores Argon2 password hashes only |
| Partially implemented? | **No** |
| Required by Governance? | **Yes, for the synchronous half of `FR-SEC-032`** — "manager PIN on the terminal". Also `FR-POS-048` (manager PIN or card swipe) |
| Required by Inventory? | **No.** No Inventory requirement names PIN |
| Independent? | **No** — `FR-SEC-021` requires PIN valid "only on registered terminals **within the employee's permitted branches**", which requires branch-scoped assignments (`FR-SEC-002`, deferred by ADR 0008 D-02) |
| Blocked? | `FR-SEC-022` is blocked on a lockout-threshold configuration home (GAP-6) |
| Unclear? | Whether synchronous approval is in Phase 1 scope at all (Decision D-2) |

**SRS-explicit dependency chain — not inferred:**
`FR-SEC-002` branch scope → `FR-SEC-021/022` PIN → `FR-SEC-032` synchronous approval.

Terminal identity exists (ADR 0004: registration, fingerprints, status;
`test/terminal.e2e-spec.ts`, 12 tests) but pairing/activation is deferred and
there is no credential wipe.

---

## 12. Notification Dependency

> **Requirement-number note.** The P1-004 brief places notifications under
> `FR-SEC-034`. Per the SRS, **notification is in `FR-SEC-032`** ("push
> notification to the manager's mobile device"); `FR-SEC-034` is **escalation**.
> Both are analysed here and in §13.

| Aspect | SRS position |
|---|---|
| Channel | `FR-SEC-032` names "push notification to the manager's mobile device". `FR-PRC-020` additionally requires "an email link with a signed, single-use, time-limited token". `FR-POS-048` names "remote approval request to the manager's mobile app" |
| Recipients | The manager / approver. No selection rule beyond the required permission |
| Triggering events | Request creation (implied); escalation (`FR-SEC-034`) |
| Delivery expectations | Not stated for approvals |
| Retries | Not stated for approvals |
| Persistence | Not stated for approvals |
| Notification status | `IR-INT-043 [S]` requires per-notification delivery status — but that is the **Integrations** domain, not Governance |
| External infrastructure | Push/email channels are Integrations-domain requirements; **no notification infrastructure exists in the repository** |

**Conclusion:** the SRS requires notification **conceptually** for asynchronous
approval and defines the channels, but the delivery infrastructure belongs to
the unimplemented **Integrations** domain. Governance must not create it.

---

## 13. Scheduler / Expiry Dependency

> **Requirement-number note.** The brief places expiry under `FR-SEC-035`. Per
> the SRS, `FR-SEC-035` is the **offline policy**; **expiry originates in
> `FR-SEC-031`** (an expiry field) and the **configured period** in `FR-SEC-034`
> (escalation). All three are analysed.

| Question | Finding |
|---|---|
| What expires | The approval **request** (`FR-SEC-031` "an expiry") |
| When | Not defined — no default, no source for the value |
| How detected | **Not defined.** Could be lazy-on-read or a scheduled sweep |
| Scheduler explicitly required? | **Not for expiry.** `FR-SEC-034` says "if no decision is made within a configured period, the request escalates" — that requires *time-triggered* behaviour but never names a scheduler |
| Must expiry mutate status? | **Not defined** |
| Are expired requests immutable? | **Not defined** |
| Approval attempts after expiry | **Not defined** |

No scheduler exists (`@nestjs/schedule` absent from `package.json`; zero `@Cron`
usages). Elsewhere the SRS *does* name scheduled jobs explicitly — `FR-DR-002`,
`FR-AUD-005`, `FR-INV-011`, `FR-INV-051`, `FR-SEC-061` — which makes the absence
of that wording in §15.6 notable, not accidental.

**GAP-4 — expiry semantics undefined.**

---

## 14. Threshold / Value Configuration

| Question | SRS position |
|---|---|
| Threshold values | **Never given.** Every requirement says "configurable": `FR-INV-035`, `FR-INV-047`, `FR-INV-058`, `FR-POS-047`, `FR-POS-073`, `FR-FIN-006`, `FR-FIN-017`, `FR-HRM-034`, `FR-PRC-018`, `FR-PRC-033` |
| Threshold ownership | Not stated. Inventory B-2 ratified that Inventory owns the **gate** only and "Governance will own determining when approval is required" — a project decision, not SRS text |
| Configuration location | **Partially defined.** `FR-POS-047` states discount thresholds are configured **"Per role, per branch"**. `FR-PRC-018` defines **value bands** with an approver level per band. No general mechanism is defined |
| Precedence | Not stated. The settings hierarchy `FR-PLT-025` exists but is deferred (ADR 0008 D-11) and is not linked to thresholds by any requirement |
| Runtime behaviour | Not stated |

**`DESIGN GAP — THRESHOLD MODEL` (GAP-2).** The SRS supplies two concrete
*shapes* — per-role-per-branch limits (`FR-POS-047`) and value bands with
approver levels (`FR-PRC-018`) — but no storage, no precedence and no owner. No
default is proposed here.

---

## 15. API Surface

Search of SRS §26.3 "Representative Endpoints": the **only** approval-related
endpoint defined anywhere is:

```
POST /v1/purchase-orders/{id}/approve        Approve
```

— and it belongs to **Procurement**, an unimplemented domain. §26.3 defines **no
governance, approval-request or audit endpoint**.

| Candidate endpoint | Classification |
|---|---|
| Create approval request | **NOT-DEFINED** |
| Retrieve request | **NOT-DEFINED** |
| List requests | **NOT-DEFINED** |
| Approve | **NOT-DEFINED** for a generic request. Only `POST /v1/purchase-orders/{id}/approve` is SRS-DEFINED, and it is domain-local |
| Reject | **NOT-DEFINED** |
| Expiry | **NOT-DEFINED** |
| History / decision history | **NOT-DEFINED** |

§26.3 is titled *Representative Endpoints*, so the omission is a gap rather than
a prohibition — the same situation that produced GAP-1/Option A in Production
Spec. **No endpoint is recommended here as if it were required.**

Unresolved and inherited: the `/v1` prefix deviation recorded in
`docs/RECONCILIATION_POST_PRODUCTION.md` §15-D1 (gate text says `/v1`, all
implemented controllers are unprefixed) still awaits ratification and will apply
to any Governance route.

---

## 16. Error Semantics

**The SRS §26.2 error model example is itself an approval error** — direct,
unusually specific evidence:

```json
{ "type": "https://api.ros.app/errors/discount-approval-required",
  "title": "Discount requires approval",
  "status": 422,
  "code": "DISCOUNT_APPROVAL_REQUIRED",
  "correlationId": "01J8XZ...",
  "meta": { "requiredPermission": "pos.discount.approve" } }
```

| Condition | SRS | Existing project convention |
|---|---|---|
| Approval required | **422** + RFC 7807 + stable `code` + `meta.requiredPermission` | Inventory currently returns **403 Forbidden** (`waste.service.ts:46`, `counts.service.ts:237`) |
| Unauthorized | 401 | 401 — consistent |
| Forbidden | 403 | 403 — consistent |
| Not found / cross-tenant | **404, never 403** ("returning 403 confirms that a resource exists in another tenant") | 404 — consistent and tested in every phase |
| Expired | Not defined | — |
| Duplicate decision | Not defined | — |
| Invalid state | 422 "Semantically invalid — business rule violation" | 409 used for lifecycle conflicts in Production Spec |

**Conflict C-3:** the SRS prescribes **422 + RFC 7807 + `meta.requiredPermission`**
for "approval required"; the shipped Inventory gate returns a plain **403**. The
repository also has no RFC 7807 problem-details layer at all (`FR-API-001`
NOT IMPLEMENTED). No new error code is invented here.

---

## 17. RLS / Security Model

**The approved SQL defines no RLS, no grants and no policies for any approval
table.** Everything below is *required behaviour to be designed*, not existing
behaviour.

Established project pattern (ADR 0003, applied identically in five schemas):
`ENABLE` + `FORCE ROW LEVEL SECURITY`; four policies; predicate
`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
SELECT/DELETE use `USING`, INSERT uses `WITH CHECK`, UPDATE uses both.

| Table | Tenant anchor available? | Consequence |
|---|---|---|
| `approval_requests` | `tenant_id` present | Direct anchor, four policies — straightforward |
| `approval_steps` | **No `tenant_id`** | Either add one (deviation, enables D-09 composite FKs — precedent: Inventory `stock_levels` D-INV-09, Production `recipe_lines`) or inherit via `EXISTS(parent)` (precedent: `waste_lines`, `modifiers`) |
| `approval_decisions` | **No `tenant_id`** | Same choice, plus immutability interacts with the policy set (§18) |

`ros_app` grants for approval tables are undefined in every source.

---

## 18. Immutability Model

`FR-SEC-033` requires decisions to be **immutable**. Two ratified precedents exist:

| Precedent | Mechanism | Fits decisions? |
|---|---|---|
| **ADR 0007** (`audit_entries`, `stock_movements`) | `GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE, TRUNCATE`; no update/delete policy | **Yes** — a decision is written once and never changes |
| **Production GAP-2** (`recipe_versions`) | `REVOKE UPDATE` + `GRANT UPDATE (status)` + status-predicated RLS | Needed only where a lifecycle transition must mutate a row |

| Entity | Should UPDATE be forbidden? | DELETE? | Source position |
|---|---|---|---|
| `approval_decisions` | **Yes** — `FR-SEC-033` explicit | Yes, by the same clause | SRS-defined |
| `approval_requests` | **Unclear.** `status DEFAULT 'pending'` implies transitions (pending → approved/rejected/expired) | Not stated | **Not defined** — mutability of the request is nowhere stated |
| `approval_steps` | Not stated | Not stated | **Not defined** |

If `approval_requests.status` must transition, a blanket REVOKE is impossible and
the Production GAP-2 column-level pattern becomes the candidate — but **the set
of legal statuses is not defined by any source** (see §27).

---

## 19. Audit Integration

| Finding | Evidence |
|---|---|
| `audit_entries` **already carries `approver_id` and `approval_id`** | Approved SQL and live `information_schema` — both present, both unused |
| `AuditService` **cannot populate them** | `AuditEvent` (`audit.service.ts:8-25`) exposes no `approverId`/`approvalId`; zero occurrences across the audit module |
| Hash coverage | `computeEntryHash` covers tenantId, sequenceNo, occurredAt, actorType, actorId, action, entityType, entityId, beforeState, afterState, previousHash. It does **not** cover `approver_id`, `approval_id`, `reasonCode`, `reasonText` or `correlationId` |

**Consequence:** approval linkage written into audit rows would sit **outside the
tamper-evident chain** unless `computeEntryHash` changes — and changing it
invalidates every existing chain. That is a genuine design decision (D-8), not
an implementation detail.

**What must be audited:** `FR-AUD-006` explicitly names "purchase approvals".
`FR-AUD-001` requires an entry for *every* state-changing operation, which
covers request creation and decisions. Existing convention (Organisation,
Catalogue, Inventory, Production) audits every mutation via `AuditService.record`
inside the same transaction.

---

## 20. Idempotency

`FR-API-020` requires an `Idempotency-Key` on "every POST and PATCH", and
**mandatory** on "all financially significant endpoints". `NFR-REL-011` requires
at-most-once financial effect *enforced by idempotency keys*.

**The SRS never enumerates "financially significant endpoints"**, and no
requirement binds idempotency to Governance specifically. An approval decision is
plausibly financially significant — it authorises a discount, refund or PO — but
that is inference, not source.

**Per the brief's instruction, no such binding is assumed.** Idempotency is
NOT IMPLEMENTED project-wide (0 matches for `idempotenc` in `src/`), and whether
Governance endpoints require it is Decision D-10.

---

## 21. Transactions / Concurrency

| Aspect | SRS position |
|---|---|
| Concurrent approvals | **Not specified** |
| Duplicate approval | **Not specified.** Nothing in the schema prevents two decisions on one step |
| Race conditions | **Not specified** |
| State transitions | Only `status DEFAULT 'pending'` and the comment `approved, rejected`. No transition rules |
| Transactionality | **Not specified** for approvals. General precedent exists: Inventory writes ledger + projection in one transaction; Production demotes-then-promotes in one transaction |
| Locking | **Not specified.** Precedent exists — `AuditService` uses `pg_advisory_xact_lock` per tenant to serialise chain writes |

**GAP-7 — concurrency and duplicate-decision semantics undefined.** No locking
strategy is proposed.

---

## 22. Existing Test Coverage

| Suite | Tests | Behaviour already protected |
|---|---|---|
| `test/rbac.e2e-spec.ts` | 11 | Role creation, permission attachment, assignment, guard enforcement |
| `test/rls.e2e-spec.ts` | 12 | Identity-schema tenant isolation as `ros_app` |
| `test/tenant-context.e2e-spec.ts` | 14 | Tenant selection, context resolution, fail-closed |
| `test/audit.e2e-spec.ts` | 7 | Audit write, chain linkage, append-only rejection |
| `test/auth.e2e-spec.ts` | 7 | Login, token issue |
| `test/password.e2e-spec.ts` | 8 | Change/reset, session revocation |
| `test/terminal.e2e-spec.ts` | 12 | Terminal registration, fingerprints, status |
| `test/inventory.e2e-spec.ts` | 34 | **Includes 2 approval-gate tests** (`:570` count refused, `:625` waste refused) |
| `test/inventory-rls.e2e-spec.ts` | 18 | Inventory tenant isolation, append-only ledger |
| `audit-hash.spec.ts` | 5 | Hash determinism and tamper detection |
| **`audit-verify.spec.ts`** | **6** | **Chain verification: content tampering, broken linkage, bad genesis, sequence gaps/duplicates** |
| `audit.service.spec.ts` | 6 | Writer behaviour, sanitisation |

**Correction to P1-003:** `src/modules/governance/audit/audit-verify.ts` exists
and exports `verifyAuditChain()` with 6 unit tests. P1-003 classified
`FR-AUD-005` as NOT IMPLEMENTED; the **verification logic is implemented** —
what is missing is the *scheduled job* and the *platform alert*. Correct status
is **PARTIAL**. See §23 Conflict C-4.

---

## 23. Source Conflicts

| ID | Source A | Source B | Exact conflict | Governing source | Decision required |
|---|---|---|---|---|---|
| **C-1** | SRS `FR-INV-046`: "SHALL require a recount or a written explanation before posting" | `PHASE_1_SRS_REQUIREMENT_MAP.md` §5 and `INVENTORY_PHASE_CLOSEOUT.md` list `FR-INV-046` as approval-blocked | `FR-INV-046` **never mentions approval** | **SRS** | No — documentation correction only. `FR-INV-050` should be added to the approval set |
| **C-2** | SRS `FR-SEC-031`: "the required approver **permission**"; §26.2 `meta.requiredPermission` | Approved SQL `approval_steps.approver_role_id UUID REFERENCES identity.roles(id)` | SRS models approval authority as a **permission**; the approved SQL models it as a **role** | **SRS** (requirements authority) | **YES — Decision D-3** |
| **C-3** | SRS §26.2: approval-required → **422**, RFC 7807, `code`, `meta.requiredPermission` | Shipped Inventory: plain **403 Forbidden** (`waste.service.ts:46`, `counts.service.ts:237`), ratified as B-2 | Different status code and payload shape for the same condition | **SRS** for the target; B-2 is a ratified interim | **YES — Decision D-6** |
| **C-4** | `audit-verify.ts` + 6 passing unit tests | `PHASE_1_SRS_REQUIREMENT_MAP.md` §10 marks `FR-AUD-005` NOT IMPLEMENTED | Verification logic exists; the map understated it | **Repository** | No — correction only. Status should be PARTIAL |
| **C-5** | SRS `FR-SEC-030`: mechanism covers "discounts, refunds, purchase orders, waste, **count adjustments**, expenses, **price changes**" | Approved SQL comment: `request_type -- discount, void, refund, po, expense, waste` | The SQL enumeration **omits count adjustments and price changes**, and **adds void** | **SRS** | **YES — Decision D-4** |
| **C-6** | SRS `FR-SEC-016`/`FR-PRC-019`: system SHALL **block** self-approval | Approved SQL: `CHECK (true)` twice, commented "enforced by app" | The approved constraints are literal no-ops | **SRS** | **YES — Decision D-7** |

---

## 24. Design Gaps

| ID | Gap | Why it is a gap |
|---|---|---|
| **GAP-1** | `approval_requests` lacks `value`, `required_permission`, `expiry` | All three are mandated verbatim by `FR-SEC-031`; confirmed absent by direct inspection |
| **GAP-2** | **THRESHOLD MODEL** — no storage, owner or precedence for the "configurable threshold" in 10+ requirements | SRS gives two shapes (`FR-POS-047` per-role-per-branch; `FR-PRC-018` value bands) but no mechanism |
| **GAP-3** | Post-decision behaviour undefined — what happens to the underlying operation after approval or rejection | No source describes continuation, callback, or re-submission |
| **GAP-4** | Expiry semantics undefined — detection, status effect, immutability, post-expiry attempts | `FR-SEC-031` requires an expiry to exist and nothing more |
| **GAP-5** | Approval request **scope** undefined (tenant vs branch) | No requirement scopes the request; `FR-SEC-021` implies branch semantics for PIN approval |
| **GAP-6** | PIN lockout threshold has no configuration home | `FR-SEC-022` "configurable number of failures" |
| **GAP-7** | Concurrency, duplicate decisions and locking undefined | §21 |
| **GAP-8** | Escalation "next approval level" — how bands map to steps, and where the "configured period" lives | `FR-SEC-034` [S] |
| **GAP-9** | No permission governs **reading** approval requests | §15.2 supplies no such code; inventing one would violate the no-invented-codes discipline |
| **GAP-10** | `count_sessions` cannot reference an approval (no `approval_request_id`); `waste_records.approval_request_id` is a bare UUID with no FK, contrary to ADR 0008 D-09 | Both are closed-phase Inventory tables |
| **GAP-11** | Audit approval-linkage fields sit outside the hash chain | `computeEntryHash` omits `approver_id`/`approval_id`; changing it invalidates existing chains |
| **GAP-12** | Legal status set for `approval_requests` undefined | Only `'pending'` (default) and the decision comment `approved, rejected` exist |

---

## 25. Design Decision Register

| ID | Decision | Why Needed | SRS Evidence | Existing Design | Options Explicitly Supported by Sources | Recommendation | Requires Ratification |
|---|---|---|---|---|---|---|---|
| **D-1** | Add `value`, `required_permission`, `expiry` to `approval_requests`? | GAP-1 — three mandated fields absent | `FR-SEC-031` | Approved SQL lacks all three | (a) Add all three as a documented deviation; (b) omit and fail `FR-SEC-031` | **(a)** — `FR-SEC-031` is `[M]` and enumerates them verbatim; omission cannot satisfy the requirement | **YES** |
| **D-2** | Which half of `FR-SEC-032` is in scope? | Sync needs PIN + branch RBAC; async needs Integrations | `FR-SEC-032` | Neither exists | (a) Neither — core only; (b) sync only (pulls in `FR-SEC-002`, `021`, `022`); (c) both | **(a)** for a first Governance phase — both halves import large, separately-deferred dependencies (ADR 0008 D-02; Integrations). This preserves the project's phase-gating discipline | **YES** |
| **D-3** | Approver authority by **permission** or **role**? (Conflict C-2) | The schema and the SRS disagree | `FR-SEC-031`; §26.2 `meta.requiredPermission`; §15.2 has no generic approval code | `approval_steps.approver_role_id → identity.roles(id)` | (a) permission (SRS); (b) role (approved SQL); (c) both | **(a) permission**, with role retained only if multi-step banding is implemented. The SRS is the requirements authority and states "permission" twice | **YES** |
| **D-4** | Canonical `request_type` enumeration (Conflict C-5) | SQL comment and `FR-SEC-030` disagree | `FR-SEC-030` lists 7 categories | SQL comment lists 6, different set | (a) `FR-SEC-030`'s list; (b) the SQL comment's list; (c) union | **(a)** — `FR-SEC-030` is normative; a SQL comment is not | **YES** |
| **D-5** | May a Governance phase alter closed Inventory tables? | GAP-10 — `count_sessions` link, `waste_records` FK | None | `waste_records.approval_request_id` bare UUID; `count_sessions` has none | (a) No Inventory change — link from Governance only; (b) add FK + column to Inventory | **NO SOURCE-SUPPORTED RECOMMENDATION** — this is a project boundary decision, exactly the class that triggered STOP in Production Spec | **YES** |
| **D-6** | Error semantics for "approval required" (Conflict C-3) | SRS says 422 + RFC 7807; shipped code says 403 | §26.2 example | Inventory 403, ratified B-2 | (a) Adopt 422 + RFC 7807 (requires `FR-API-001`, unimplemented); (b) keep 403; (c) 422 for new Governance routes, leave Inventory | **NO SOURCE-SUPPORTED RECOMMENDATION** for the transition path — the SRS target is clear, but changing Inventory's shipped behaviour is a ratified-decision change | **YES** |
| **D-7** | Self-approval enforcement mechanism (Conflict C-6) | `CHECK (true)` is a no-op; SRS says **block** | `FR-SEC-016`, `FR-PRC-019` | Two placeholder constraints | (a) Service-enforced (schema comment's intent); (b) real DB CHECK (needs requester on the decision row or a denormalised column); (c) both | **(c)** where technically possible — the project consistently prefers structural enforcement (ADR 0008 D-09), and `FR-SEC-016` says *block*, not warn. Note `FR-SEC-016` also conditions count self-posting on "strict SoD" being **enabled**, which needs settings (deferred) | **YES** |
| **D-8** | Do `approver_id`/`approval_id` enter the audit hash? | GAP-11 — otherwise linkage is not tamper-evident | `FR-AUD-004` defines the chain over "its own content" | `computeEntryHash` omits them | (a) Extend the hash (**invalidates every existing chain**); (b) leave outside the chain; (c) leave outside and document | **NO SOURCE-SUPPORTED RECOMMENDATION** — `FR-AUD-004`'s "canonical_json(entry_n)" is ambiguous about which fields constitute the entry | **YES** |
| **D-9** | Threshold ownership and storage | GAP-2; B-2 deferred this to Governance | `FR-POS-047` per-role-per-branch; `FR-PRC-018` value bands | Settings resolver deferred (ADR 0008 D-11) | (a) Governance owns thresholds; (b) defer again — callers keep supplying `requiresApproval`; (c) block on `FR-PLT-025` | **(b) for a first phase** — it preserves the ratified B-2 contract and avoids inventing a configuration mechanism the SRS does not define. **(a)/(c) require the settings resolver first** | **YES** |
| **D-10** | Does idempotency bind to Governance endpoints? | `FR-API-020`; §20 | No requirement binds them | Not implemented project-wide | (a) Yes; (b) no; (c) defer with idempotency generally | **NO SOURCE-SUPPORTED RECOMMENDATION** — "financially significant" is never enumerated | **YES** |
| **D-11** | Tenant anchoring for `approval_steps` / `approval_decisions` | Neither has `tenant_id`; RLS undefined | `FR-PLT-003`, `FR-PLT-010` | Two ratified precedents exist | (a) Add `tenant_id` + composite FKs (D-09; precedent D-INV-09, `recipe_lines`); (b) inherit via `EXISTS(parent)` (precedent `waste_lines`) | **(a)** — decisions reference `identity.users`, a cross-aggregate edge that D-09 requires to be tenant-safe, and D-09 is ratified architecture | **YES** |
| **D-12** | Mutability of `approval_requests` / `approval_steps` | GAP-12, §18 | `FR-SEC-033` covers decisions only | ADR 0007 and Production GAP-2 patterns | (a) ADR 0007 blanket REVOKE (needs immutable requests); (b) Production GAP-2 column-level `UPDATE (status)`; (c) fully mutable requests | **(b)** *if* a legal status set is ratified (D-13); a request whose `status` starts `'pending'` must transition somehow | **YES** |
| **D-13** | Legal `approval_requests.status` set and transitions | GAP-12 — only `'pending'` is defined | None | `DEFAULT 'pending'`; decision comment `approved, rejected` | Source supports at least `pending`, `approved`, `rejected`. `expired`/`cancelled`/`escalated` are **not** source-defined | **NO SOURCE-SUPPORTED RECOMMENDATION** beyond the three states — expiry (GAP-4) and cancellation are undefined | **YES** |
| **D-14** | API surface and `/v1` prefix | §15 — no SRS endpoint exists for generic approvals | §26.3 "Representative"; unresolved D1 deviation | (a) Author endpoints as a documented deviation (GAP-1/Option A precedent); (b) no HTTP surface this phase | **NO SOURCE-SUPPORTED RECOMMENDATION** — depends on D-2 | **YES** |
| **D-15** | Permission for reading approval requests | GAP-9 — §15.2 supplies none | §15.2 | Zero-invented-codes discipline (D-17-06) | (a) Reuse `governance.view_anomalies` (semantically wrong); (b) reuse the request's `required_permission`; (c) no read surface | **NO SOURCE-SUPPORTED RECOMMENDATION** | **YES** |

---

## 26. Conceptual Entity Relationship

Source-supported entities only. Dashed edges are **required by the SRS but absent
from the approved SQL**.

```
identity.tenants
      │ 1
      │ N
governance.approval_requests ─────────── requested_by ──▶ identity.users
      │  tenant_id, request_type, entity_type, entity_id,
      │  status, created_at
      │  ┄┄ value            (FR-SEC-031, ABSENT — GAP-1)
      │  ┄┄ required_permission (FR-SEC-031, ABSENT — GAP-1, Conflict C-2)
      │  ┄┄ expires_at       (FR-SEC-031, ABSENT — GAP-1)
      │ 1
      │ N
governance.approval_steps ── approver_role_id ──▶ identity.roles
      │  sequence                                   (Conflict C-2:
      │  (no tenant_id — D-11)                       SRS says permission)
      │ 1
      │ N
governance.approval_decisions ── approver_id ──▶ identity.users
         decision, reason, decided_at
         (no tenant_id — D-11; immutability undefined — D-12)

governance.audit_entries
   ┄┄ approver_id   ──▶ identity.users     (column EXISTS, unused)
   ┄┄ approval_id   ──▶ approval_requests  (column EXISTS, unused, no FK)
   (both outside the hash chain — GAP-11)

inventory.waste_records
   ┄┄ approval_request_id  (column EXISTS, bare UUID, NO FK — GAP-10)
       requires_approval BOOLEAN
inventory.count_sessions
       requires_approval BOOLEAN
   ┄┄ approval_request_id  (ABSENT entirely — GAP-10)

Permission resolution (existing, tenant-scoped only):
   memberships ──▶ membership_roles ──▶ roles ──▶ role_permissions ──▶ permissions
                        │
                        └─ branch_id (EXISTS, NEVER READ — ADR 0008 D-02)
```

---

## 27. Governance State Machine

**State machine cannot yet be ratified from current sources.**

What the sources establish:

- `approval_requests.status` exists, `VARCHAR(16) NOT NULL DEFAULT 'pending'`
- `approval_decisions.decision` is commented `approved, rejected`
- `FR-SEC-034` implies an **escalation** transition between approval levels
- `FR-SEC-031` implies an **expiry** concept

What no source defines:

- the legal status set (only `'pending'` is written down)
- whether a decision sets the request status, or a separate transition does
- what expiry does to status, and whether it is time-triggered or lazy
- whether `cancelled` exists
- multi-step aggregation: does one rejection reject the whole request? does the
  request advance to the next step on approval, or complete?
- terminal states and whether they are immutable

Because the transition rules — not merely the state names — are absent, no state
machine is proposed. Decisions **D-12** and **D-13** must be ratified first.

---

## 28. Design Gate Readiness

# NOT READY — DESIGN GAPS REMAIN

The approved SQL provides a real starting skeleton and the SRS defines the
inputs, the decision record, immutability, self-approval prohibition and the
error shape with unusual precision. But a gate cannot be written while the
following remain unresolved:

**Blockers (must be ratified before a design gate):**

1. **D-1 / GAP-1** — three `FR-SEC-031`-mandated fields are absent from the approved SQL
2. **D-3 / Conflict C-2** — approver authority: permission (SRS) vs role (approved SQL)
3. **D-13 / GAP-12** — no legal status set, therefore no state machine (§27)
4. **D-12 / GAP-3, GAP-4** — mutability, post-decision behaviour and expiry semantics undefined
5. **D-5 / GAP-10** — whether closed Inventory tables may be altered
6. **D-2** — which half of `FR-SEC-032` is in scope, which determines whether PIN (`FR-SEC-021/022`) and branch-scoped RBAC (`FR-SEC-002`, ADR 0008 D-02) are pulled in
7. **D-9 / GAP-2** — threshold ownership, deferred to Governance by B-2 and still undefined
8. **D-7 / Conflict C-6** — self-approval enforcement, where `FR-SEC-016` says *block* and the schema says `CHECK (true)`

Non-blocking but ratification-requiring: **D-4**, **D-6**, **D-8**, **D-10**,
**D-11**, **D-14**, **D-15**.

---

## 29. Recommended Next Step

Author a **Governance Design Gate ratification request** — not the gate itself —
presenting the 15 decisions in §25 for explicit ratification, in the same
one-by-one form used for ADR 0008 (D-01…D-17), the Inventory gate (C-01…C-11,
B-1/B-2) and Production Spec (D-17-02…D-17-08, GAP-1/GAP-2).

Ratification should be sought in dependency order: **D-2 first** (it determines
whether PIN and branch-scoped RBAC enter scope, and therefore the size of the
entire phase), then **D-1, D-3, D-4, D-13, D-12** (the data model and state
machine), then **D-5, D-7, D-9** (boundary and enforcement), then the remainder.

Once ratified, the design gate can be written against a settled model. **No
implementation may begin before that gate is itself ratified.**

---

### Requirements analyzed
**42** — `FR-SEC-030`…`035` (6), `FR-SEC-016`, `FR-PRC-018`/`019`/`020` (3),
`FR-POS-047`/`048`/`049`/`073`/`075` (5), `BR-POS-003`, `FR-INV-032`/`035`/`046`/`047`/`050`/`058` (6),
`FR-FIN-006`/`015`/`017` (3), `FR-HRM-016`/`017`/`034` (3), `FR-BRN-016`, `FR-PRC-010`/`021`/`022`/`023`/`033`/`042` (6),
`FR-AUD-001`/`004`/`005`/`006` (4), `FR-API-020`, `NFR-REL-011`, `FR-SEC-002`, `FR-SEC-021`, `FR-SEC-022`

### Design gaps
**12** (GAP-1 … GAP-12)

### Source conflicts
**6** (C-1 … C-6)

### Decisions requiring ratification
**15** (D-1 … D-15)

### Governance implementation blockers
**8** (§28, items 1–8)

### Design Gate readiness
**NOT READY — DESIGN GAPS REMAIN**
