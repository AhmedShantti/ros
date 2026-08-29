-- ---------------------------------------------------------------------------
-- Migration 32 (Governance) — the shared Approval runtime (FR-SEC-030..033).
--
-- Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Approval
-- Runtime Minimum Resolution — 2026-08-29" (RATIFIED) and
-- docs/reports/claude/2026-08-29_APPROVAL_runtime-design-acceptance-closure.md
-- (CONTROLLING over the earlier design gate where they differ).
--
-- Governance-owned only (D-17 strict boundary, by analogy). No Inventory,
-- Sales or Treasury object is created, altered or written to by this
-- migration. No cash-variance consumer, no request_type enumeration, no
-- Governance HTTP surface. No `approval_steps` table (P-1 cl. 2; D-12
-- BLOCKED, untouched).
--
-- ── PARENT LINKAGE (P-1, RATIFIED) ──────────────────────────────────────────
-- `approval_decisions` references `approval_requests` DIRECTLY via a
-- tenant-safe composite FK. No step table exists between them.
--
-- ── LIFECYCLE (D-4) ──────────────────────────────────────────────────────
-- pending -> approved | rejected. No `cancelled`/`escalated`/`expired`
-- status. `status` is the ONLY mutable column on `approval_requests` (D-6
-- Model B + Mechanism 1, the Production GAP-2 precedent).
--
-- ── DECISION CARDINALITY (narrow amendment of D-15 clause 4, via clause 14)
-- Exactly one final decision per request, enforced by
-- UNIQUE (tenant_id, approval_request_id) on approval_decisions. D-15's
-- other prohibitions are preserved: no approval-specific pessimistic lock,
-- no approval-specific idempotency mechanism, no pending-status conjunct on
-- the decisions INSERT policy (that lives on the requests UPDATE policy,
-- D-9 U4, below).
--
-- ── EXPIRY CLOCK (D-10, corrected by the 2026-08-29 acceptance closure) ────
-- D-10 fixes evaluation at the decision INSERT boundary ("evaluated when an
-- approval decision is inserted"; "at the database approval-decision INSERT
-- boundary"; "unexpired at decision time"). `now()`/`CURRENT_TIMESTAMP` are
-- PostgreSQL TRANSACTION-start timestamps, not statement-start, so they do
-- NOT satisfy that boundary inside a long-lived enclosing transaction (e.g.
-- a future CashSession close). `statement_timestamp()` is used instead —
-- stable for the INSERT statement, never frozen at transaction start.
-- `approval_decisions.decided_at` is bound to the IDENTICAL basis via its
-- own `DEFAULT statement_timestamp()`, and `ros_app` is denied column-level
-- INSERT privilege on `decided_at` so it can never be supplied by a caller
-- and diverge from the value the RLS predicate itself evaluated.
--
-- ── VALUE (SB-2, RATIFIED) ───────────────────────────────────────────────
-- `value JSONB NOT NULL` is an OPAQUE carrier. No Governance CHECK, index or
-- RLS predicate reads its internals. Money inside it is a base-10 integer
-- string of minor units (never a JSON number).
-- ---------------------------------------------------------------------------

CREATE TABLE "governance"."approval_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- Opaque to Governance (D-13 "generic carrier"). No CHECK enumerating
    -- values — D-16's enumeration remains OPEN (register: "MUST remain
    -- OPEN. DO NOT RATIFY."); only the Phase-1 constraint FORM is settled.
    "request_type" VARCHAR(32) NOT NULL,
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" UUID NOT NULL,
    -- Identity User who requested this approval. Plain UUID, no FK — see
    -- the GRANTS section below for why.
    "requested_by" UUID NOT NULL,
    -- SB-1: an existing SRS §15.2 permission CODE, immutable data. No FK to
    -- identity.permissions (SB-1 RESOLVED — RP-1).
    "required_permission" VARCHAR(64) NOT NULL,
    -- SB-2: opaque carrier. Governance never parses this.
    "value" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    -- Item 8 (F-1 = R-b): an additional Identity User prohibited from
    -- approving this request. Generic name, no domain vocabulary. Plain
    -- UUID, no FK. NULL when no such exclusion applies.
    "excluded_approver_user_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_approval_request_status" CHECK ("status" IN ('pending', 'approved', 'rejected')),
    CONSTRAINT "ck_approval_request_type_present" CHECK (length(btrim("request_type")) > 0),
    CONSTRAINT "ck_approval_request_permission_present" CHECK (length(btrim("required_permission")) > 0)
);

CREATE UNIQUE INDEX "approval_requests_tenant_id_id_key"
  ON "governance"."approval_requests"("tenant_id", "id");
CREATE INDEX "approval_requests_tenant_id_status_idx"
  ON "governance"."approval_requests"("tenant_id", "status");
CREATE INDEX "approval_requests_tenant_id_entity_type_entity_id_idx"
  ON "governance"."approval_requests"("tenant_id", "entity_type", "entity_id");

CREATE TABLE "governance"."approval_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    -- Identity User who decided. Plain UUID, no FK — same posture as
    -- requested_by and as governance.audit_entries.approver_id.
    "approver_id" UUID NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "comment" TEXT,
    -- Bound to statement_timestamp() below via DEFAULT; ros_app cannot
    -- supply this column (see the column-level GRANT INSERT below).
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_approval_decision_value" CHECK ("decision" IN ('approved', 'rejected')),
    -- The one-final-decision invariant (narrow D-15 clause 4 amendment via
    -- clause 14). This UNIQUE constraint is the entire concurrency
    -- mechanism for the two-manager race — D-15 forbids any additional
    -- locking scheme.
    CONSTRAINT "uq_approval_decision_per_request" UNIQUE ("tenant_id", "approval_request_id")
);

CREATE INDEX "approval_decisions_tenant_id_approver_id_idx"
  ON "governance"."approval_decisions"("tenant_id", "approver_id");

-- P-1 (RATIFIED): approval_decisions references approval_requests DIRECTLY.
-- Tenant-safe composite FK — a cross-tenant decision/request pair is
-- structurally unrepresentable, independent of RLS. SB-3 RESOLVED (DP-1 +
-- ON DELETE RESTRICT): approval_requests has no DELETE capability at all
-- (see GRANTS below), so this RESTRICT can never actually fire; it exists
-- only as a documented invariant should that posture ever change. ON DELETE
-- CASCADE remains explicitly rejected (it would permit deleting append-only
-- approval_decisions through the parent).
ALTER TABLE "governance"."approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_approval_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id")
  REFERENCES "governance"."approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- Future governance tables must grant ros_app explicitly (see the note in
-- 20260812175712_governance_audit_entries/migration.sql — no
-- ALTER DEFAULT PRIVILEGES, for Render deployment compatibility).
--
-- No FK on requested_by / excluded_approver_user_id / approver_id to
-- identity.users(id): identity.users is GLOBAL (no tenant_id column), so
-- such an FK would guarantee row existence only, never tenant membership —
-- zero tenant safety. Tenant safety instead comes from this table's own
-- tenant_id under FORCE RLS, plus the membership-validated provenance of
-- every user id the application writes here. No safe ON DELETE action
-- exists either (SET NULL would silently void the item-8 exclusion;
-- CASCADE would delete a request that can never be deleted; RESTRICT would
-- permanently block deleting any user ever named on any request, since
-- requests are never deleted). This matches the existing
-- governance.audit_entries precedent (approver_id/approval_id are FK-less
-- there too), and is why no back-relation is added to the User or Tenant
-- Prisma models.

-- approval_requests: D-6 Model B + Mechanism 1 (Production GAP-2 precedent).
-- `status` is the ONLY column ros_app may ever UPDATE; every other column
-- becomes structurally unwritable after INSERT. SB-3: no DELETE capability
-- at all (no DELETE grant, and — see RLS below — no DELETE policy).
GRANT SELECT, INSERT ON "governance"."approval_requests" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_requests" FROM ros_app;
GRANT UPDATE ("status") ON "governance"."approval_requests" TO ros_app;

-- approval_decisions: append-only (D-8), AND column-level INSERT so
-- `decided_at` (and `created_at`) can never be supplied by ros_app — only
-- their DEFAULT expressions can produce a value, which is what binds
-- decided_at to the SAME statement_timestamp() the RLS predicate below
-- evaluates. IMPORTANT: no table-level INSERT grant is issued (that would
-- defeat the column-level restriction) — only this explicit column list.
GRANT SELECT ON "governance"."approval_decisions" TO ros_app;
GRANT INSERT ("id", "tenant_id", "approval_request_id", "approver_id", "decision", "comment")
  ON "governance"."approval_decisions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_decisions" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "governance"."approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance"."approval_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_requests_select ON "governance"."approval_requests" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A request must be born pending — the entry half of D-4's one-way lifecycle.
CREATE POLICY approval_requests_insert ON "governance"."approval_requests" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status = 'pending');

-- D-9 U4, ratified verbatim: the compare-and-set for the request's ONE
-- legal transition. This is where "status='pending'" lives — deliberately
-- NOT as a fifth conjunct on the decisions INSERT policy (D-15 clause 9
-- forbids that; preserved below).
CREATE POLICY approval_requests_update ON "governance"."approval_requests" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND status = 'pending')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('approved', 'rejected'));

-- No DELETE policy exists (SB-3 / item 3) — DELETE is also revoked above,
-- so this is defence in depth, not the sole guard.

ALTER TABLE "governance"."approval_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance"."approval_decisions" FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_decisions_select ON "governance"."approval_decisions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The four DB-enforced conjuncts (item 8 / D-7 / D-10, as corrected by the
-- 2026-08-29 acceptance closure):
--   1. tenant isolation
--   2. requester != approver (D-7 M2 — the required NOT EXISTS traversal)
--   3. unexpired AT THE DECISION STATEMENT (D-10, statement_timestamp())
--   4. excluded_approver_user_id != approver, when non-NULL (item 8)
-- NULL-safety: when excluded_approver_user_id IS NULL, the third OR-branch
-- evaluates to NULL (not TRUE), so it can never admit-block a normal
-- approval — no separate `IS NOT NULL` guard is needed.
-- No `status = 'pending'` conjunct here (D-15 clause 9, preserved).
CREATE POLICY approval_decisions_insert ON "governance"."approval_decisions" FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM "governance"."approval_requests" r
      WHERE r.tenant_id = approval_decisions.tenant_id
        AND r.id        = approval_decisions.approval_request_id
        AND (    r.requested_by              = approval_decisions.approver_id
              OR r.expires_at                <  statement_timestamp()
              OR r.excluded_approver_user_id = approval_decisions.approver_id )
    )
  );

-- No UPDATE and no DELETE policy on approval_decisions — fully append-only
-- (D-8), and UPDATE/DELETE/TRUNCATE are already revoked above.
