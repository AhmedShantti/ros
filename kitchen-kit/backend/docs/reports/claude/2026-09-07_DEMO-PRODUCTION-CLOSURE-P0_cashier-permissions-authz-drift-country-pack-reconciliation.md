# DEMO-PRODUCTION-CLOSURE-P0 — Cashier Permission Gap, Authorization-Coverage Drift, Country-Pack Production Readiness, Role Reconciliation

**Report type:** Implementation/verification report (closes only client-demo blockers named in the task; explicitly not a full-SRS slice)
**Authority statement:** This report is non-authoritative evidence. The SRS (`ROS_SRS_v1.0.pdf`, §15.2, §22.2) and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (CLARIFICATION C in particular) remain the sole authority for requirements and permission-tier decisions. Nothing in this document creates, amends, or ratifies governance.
**Date:** 2026-09-07
**HEAD (start and end — no commit made this session per the operator's own instruction to await explicit direction before committing):** `bf91d6671a1c39fd0b3c0e8b4ba6c66aa8132ed8`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** 3 source files modified (`canonical-role-templates.ts`, `canonical-role-templates.spec.ts`, `authorization-coverage.spec.ts`); no historical migration touched; no destructive git command run; no commit, no push. Pre-existing untracked report files and `docs/reports/claude/INDEX.md` modification from prior sessions were left as found (not authored by this task).
**Task identifier:** DEMO-PRODUCTION-CLOSURE-P0 — fix only backend/runtime blockers on the stated demo golden path (owner setup → cashier PIN/order/discount/comp/fire/KDS/payment/receipt/refund/close-shift). No full-SRS domain work performed.

---

## 1. CANONICAL CASHIER POS PERMISSIONS

### CASHIER_PERMISSION_GAP

Confirmed via direct trace of `canonical-role-templates.ts`, `sales.permissions.ts`, `orders.controller.ts`, `discounts.service.ts`, and `post-fire-void.service.ts` (not inferred): four permission codes existed in the catalogue and were wired to real routes, but were absent from every staff canonical role template (`cashier`, `branch_manager`, `shift_supervisor`, `kitchen_staff`) — reachable only by `Owner` (which receives `ALL_PERMISSION_CODES` at signup):

- `pos.discount.apply` — gates `POST .../lines/:lineId/discount` and `POST .../discount` (order-level).
- `pos.discount.unlimited` — checked inline in `DiscountsService` to bypass the approval-threshold check (`resolveApproval`); not a route gate.
- `pos.comp.apply` — gates `POST .../lines/:lineId/comp`.
- `pos.order.void_line_postfire` — gates `POST .../lines/:lineId/void-postfire`.

A normal staff Cashier (or Shift Supervisor / Branch Manager) received an immediate 403 on any of these four routes, before any manager-approval logic could even run.

### ROLE_DECISION

Traced the actual approval semantics per permission before assigning a tier — not a blanket grant:

- `pos.discount.apply` (SRS §15.2 "Apply discounts within limits") — ordinary, threshold-gated action. `DiscountsService.applyLineDiscount`/`applyOrderDiscount` still separately call `evaluateApprovalRequired` and `resolveApproval`, which — absent an explicit `DiscountApprovalPolicyVersion` (none provisioned by default) — requires a manager PIN + `pos.discount.approve` for EVERY discount regardless of this grant. **→ Cashier-tier.**
- `pos.comp.apply` (SRS §15.2 "Give complimentary items", FR-POS-050) — `DiscountsService.applyComp` carries **no** approval/threshold mechanism at all in the domain model (verified by reading the full method body); the permission alone is the complete authority the SRS defines for it, and the demo golden path's own "discount/comp if shown" step names it as an ordinary cashier action. **→ Cashier-tier.**
- `pos.discount.unlimited` (SRS §15.2 "Apply discounts without limit") — this is the per-actor override that **bypasses** the `pos.discount.approve` gate entirely (`discounts.service.ts:192-199`/`391-398`: `unlimited === true` skips `evaluateApprovalRequired` outright). A bypass-of-approval permission is manager-tier by definition. **→ Shift-Supervisor-tier, NOT Cashier.**
- `pos.order.void_line_postfire` — `GOVERNANCE_DECISION_REGISTER.md` **CLARIFICATION C** (line 5434) is explicit and binding: *"AFTER a line is fired — the cashier SHALL NOT directly mutate that fired content. A correction or void after fire is a **privileged** operation requiring **Manager-or-higher authority**."* `post-fire-void.service.ts` was verified to carry no in-service approval step (unlike discounts) — the permission itself IS the entire gate, so granting it to Cashier would violate CLARIFICATION C outright, regardless of route-reachability. **→ Shift-Supervisor-tier, NOT Cashier.**

This is the smallest SRS/governance-consistent separation: Cashier gains only the two ordinary, still-approval-gated-where-applicable actions; the two manager-only capabilities move to the one existing manager-tier canonical role built for exactly this purpose (Shift Supervisor already holds `pos.discount.approve` and `cash.session.close_other`).

### ROLE_FIX

`src/modules/identity/authz/canonical-role-templates.ts`:
- `CASHIER_PERMISSION_CODES` += `SALES_PERMISSIONS.DISCOUNT_APPLY`, `SALES_PERMISSIONS.COMP_APPLY`.
- `SHIFT_SUPERVISOR_PERMISSION_CODES` += `SALES_PERMISSIONS.DISCOUNT_UNLIMITED`, `SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE` (in addition to the Cashier set it already spreads, `cash.session.close_other`, and `pos.discount.approve`).
- `branch_manager` and `kitchen_staff` templates: **unchanged** (no scope creep beyond the four named permissions).
- Docblocks updated in place to record the above reasoning (why each of the four codes landed where it did), matching the file's existing per-role rationale convention.

### ROLE_TESTS

Extended `canonical-role-templates.spec.ts` with a new `describe` block (4 new `it`s, matching the file's existing pattern for the prior refund-permission fix):
1. Cashier can apply an ordinary discount and comp.
2. Cashier does NOT get `pos.discount.unlimited` or `pos.order.void_line_postfire`.
3. Shift Supervisor inherits ordinary discount/comp from Cashier and separately holds unlimited-discount and post-fire-void.
4. Branch Manager template is unchanged by this fix.

`npx jest src/modules/identity/authz/canonical-role-templates.spec.ts` → **9/9 passing** (5 pre-existing + 4 new).

---

## 2. AUTHORIZATION COVERAGE CI DRIFT

### AUTH_COVERAGE_ROOT_CAUSE

Ran `authorization-coverage.spec.ts` before any change: exactly 2 failures, both traced to the same single cause — `POST /auth/registrations` (`RegistrationsController`, `src/modules/identity/registrations/registrations.controller.ts:60`) has no `@RequirePermission`/`@AuthorizationTarget` (correct — it is `SIGNUP-1`, the unauthenticated tenant self-service signup route that CREATES the first principal, so there is nothing to authorize against) and was simply missing its `REVIEWED_UNPROTECTED_ROUTES` allowlist entry. Confirmed pure allowlist/test drift, not a real authorization hole: every neighboring unauthenticated route (`POST /auth/login`, `POST /auth/pin`, etc.) already has an entry with the same shape of justification; this route was the one omission.

### AUTH_COVERAGE_FIX

Added exactly one entry to `REVIEWED_UNPROTECTED_ROUTES` in `src/modules/authorization-coverage.spec.ts`:

```
'POST /auth/registrations':
  'SIGNUP-1 (FR-PLT-020) — public tenant self-service signup. Unauthenticated
  entry point by design; it CREATES the first principal (user, tenant, Owner
  role) rather than acting against one that already exists, so there is no
  business target to authorize against. Rate-limited by ThrottlerGuard
  (IP-keyed) and strict whitelist DTO validation instead.'
```

No `@RequirePermission` was added to the signup controller (explicitly out of scope per task instruction — it must remain public).

### AUTH_COVERAGE_TEST

`npx jest src/modules/authorization-coverage.spec.ts` → **9/9 passing** (was 7/9 before the fix).

---

## 3. COUNTRY PACK PRODUCTION READINESS

No domain logic was inspected as defective and none was changed (per task instruction — inspection only). Verified against current source (`src/config/env.validation.ts`, `country-pack.loader.ts`, `country-pack.trust.provider.ts`) and against the prior, still-accurate `2026-08-26_RENDER_country-pack-order-create-unblock.md` report in this same directory, whose file-existence claims were re-verified this session (`config/country-packs/EG-2026.1.pack.json` and `config/country-packs/trust-manifest.json` both still present, still committed, content unchanged).

### COUNTRY_PACK_REQUIRED_ENV

Both variables are OPTIONAL to the app (fail-closed if unset — no crash, just an inactive pack) and are read as plain `fs` paths relative to the process's working directory at boot (`CountryPackLoader.onModuleInit`, `ConfiguredCountryPackTrustStore`'s constructor). Assuming Render's service root is `kitchen-kit/backend` (consistent with `node dist/main`'s cwd and with the prior report's own confirmed-working Render configuration):

```
COUNTRY_PACK_DIR=config/country-packs
COUNTRY_PACK_TRUST_MANIFEST=config/country-packs/trust-manifest.json
```

Both are repository-relative paths only — no secret values, no key material. The files they point to ship with the built image; nothing extra needs to be uploaded to Render. Render must be redeployed/restarted after setting these — they are read once, at process boot, not polled.

### COUNTRY_PACK_PRODUCTION_PROBE

Startup-log check (no HTTP call needed, no secret disclosed):

1. Absence of `"No country-pack trust manifest configured. Every pack signature will be rejected..."` (`ConfiguredCountryPackTrustStore`).
2. Presence of `"Country-pack trust manifest loaded: 1 release key(s), 1 active."` (`country-pack.trust.provider.ts:78`, string re-verified present in current source).
3. Presence of `"Activated country pack EG-2026.1."` (`country-pack.loader.ts:82`).
4. Presence of `"Active country packs: {\"EG\":[\"2026.1\"]}"` (`country-pack.service.ts:147`), **not** the `"No country pack is active"` warning.

If (2)-(4) appear and (1) does not, the pack loaded successfully and `POST /orders` will proceed past `CountryPackUnavailableError` for an EG/EGP branch. This is a read of existing, already-instrumented log lines — no new logging or probe endpoint was added (out of scope: "health endpoint redesign" is an explicitly excluded item).

---

## 4. DEMO ROLE RECONCILIATION

### EXISTING_CASHIER_RECONCILIATION_STEPS

Traced `EmployeesService.assignRoleToEmployee` (`src/modules/workforce/employees/employees.service.ts:460-504`), which backs `POST /workforce/employees/:employeeId/role-assignments` (`EmployeesController.assignRole`). Confirmed the self-heal path already exists and requires no migration:

Before creating the (possibly redundant) `MembershipRole` assignment row, the service looks up the target `Role` by id, resolves its `name` via `canonicalRoleKeyForName`, and — if the name matches a canonical template (e.g. `"Cashier"`) — calls `ensureCanonicalRole(tx, tenantId, 'cashier')` first. `ensureCanonicalRole` is create-or-reuse-BY-NAME and upsert-only on `RolePermission`: it finds the tenant's EXISTING `Cashier` role row and upserts every permission code in the CURRENT template onto it (including the two newly added in §1 — `pos.discount.apply`, `pos.comp.apply`) without creating a duplicate role or losing any existing grant.

**Exact operator steps for the existing demo employee (no backend redeploy of a migration, no manual DB edit):**

1. In the Employees UI (or directly: `POST /workforce/employees/{employeeId}/role-assignments`), open the existing Cashier employee's record.
2. Use "Assign Role" and select the role named **`Cashier`** again (same role, same scope as before) — a fresh `Idempotency-Key` header, since this is technically a new assignment call.
3. Submit. The call reconciles the existing `Cashier` role's permission grants to the current template (adds `pos.discount.apply`/`pos.comp.apply`) as a side effect, before recording the (additional, harmless) assignment.
4. No other employee holding the same `Cashier` role needs a separate action — the reconciliation is on the ROLE row, shared by every employee assigned to it, not per-employee.

No migration or backfill script was added or is needed — reassignment through the existing Employees workflow is already the intended, already-implemented self-heal path (confirmed by reading `DEMO-OPS-HOTFIX-2`'s own doc comment in `canonical-role-templates.ts`, which anticipated exactly this scenario for a prior, narrower template change).

---

## 5. DO NOT TOUCH NON-DEMO ITEMS

Confirmed no work was done on: FR-INV-020 batch creation, Reporting build-out, new payment tenders, split bill, service charge/tips, transactional outbox, scheduler redesign, metrics redesign, health endpoint redesign, SRS security expansion, EG/SA fiscal integrations. `branch_manager` and `kitchen_staff` canonical templates were explicitly left unchanged (§1).

---

## 6. VERIFY

- `npx jest src/modules/identity/authz/canonical-role-templates.spec.ts` — **9/9 passing**.
- `npx jest src/modules/authorization-coverage.spec.ts` — **9/9 passing**.
- `npx jest src/modules/identity/authz/guards/permission.guard.spec.ts` — **22/22 passing** (relevant RBAC guard coverage, unaffected).
- `npx jest src/modules/identity` (full module) — **107/107 passing**.
- `npx jest src/modules/sales` (unit specs — no discount/comp/post-fire-void unit specs exist; those paths are e2e-only, and full E2E was explicitly out of scope this task) — **87/87 passing**.
- Full unit suite, `npx jest` (repo-wide, unit config — does not include e2e specs) — **1159/1159 passing**, 0 failures.
- `npx tsc --noEmit` — **clean, exit 0** (the prior baseline `access-token.service.spec.ts` type error noted in the 2026-08-26 report is no longer present).
- `npm run build` (`nest build`) — **succeeded, exit 0**.

No full E2E was run, per task instruction.

---

## Requirement / evidence discipline note

All test/verification results above were executed live in this session, not reported from a prior run. Discount/comp/post-fire-void SERVICE-LEVEL behavior (approval thresholds, tax recomputation, stacking rules) was NOT re-verified end-to-end in this session — it was traced by reading `discounts.service.ts`/`post-fire-void.service.ts` source directly to determine the correct permission TIER, and is unchanged by this task (no service logic was edited, only the canonical role→permission mapping and one test allowlist).

---

## Final status

**SAFE_TO_DEPLOY:** Yes, for the four items closed in this report (Cashier discount/comp reachability, authorization-coverage CI green, country-pack env values confirmed against current source, role-reconciliation path confirmed self-healing). Deployment still requires: (a) setting the two `COUNTRY_PACK_*` env vars on Render if not already set (§3 — this session cannot confirm Render's live env, no deployment access), and (b) re-running "Assign Role → Cashier" for the existing demo Cashier employee (§4) so the existing tenant's Cashier role row picks up the two new grants — a fresh signup already gets them at `ensureCanonicalRole` time.

**REMAINING_DEMO_BLOCKERS** (observed during this task, NOT fixed — outside the four named gaps, flagged for visibility only):
- `pos.discount.approve` (the manager-approval act itself) is on `shift_supervisor` but NOT on `branch_manager`, despite Branch Manager being the more likely "manager" persona in a small demo tenant with no Shift Supervisor employee created. Owner already holds it (full grant at signup) and can act as the approver in the demo without any fix, so this is not blocking, but is worth the user's awareness if the demo script assumes a Branch Manager can approve.
- This session could not confirm the live Render environment variable state or a live pack-activation log (no deployment access) — §3's probe is ready to run post-deploy but was not executed against production this session.
