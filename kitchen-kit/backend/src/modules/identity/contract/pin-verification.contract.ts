/**
 * Identity PUBLIC contract — Identity's FIRST published surface (SRS §5.4).
 *
 * Authority: docs/reports/claude/2026-08-29_APPROVAL_runtime-final-design-gate.md
 * §3, corrected by docs/reports/claude/2026-08-29_APPROVAL_runtime-design-
 * acceptance-closure.md §4 (CONTROLLING on the trust-boundary posture).
 *
 * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13) ────────────────────
 * RENAMED from the former `VerifiedTerminalPrincipal`/`TerminalPinVerifier`/
 * `TERMINAL_PIN_VERIFIER`/`verifyTerminalPin`. POS and KDS are application
 * SESSIONS, not registered device identities (see the product-decision
 * record in the P0 report and the governance/product-decision register).
 * There is no longer a "registered terminal" for a manager PIN to be
 * verified AT — the verification is now BRANCH-scoped: the SAME
 * `employeeCode` + `pin` + permitted-branch check `PinService.authenticate`
 * already performs for login, reused here for an IN-BAND approval decision.
 * The branch is derived by the CALLING module from the entity being
 * approved (the order's branch, the cash session's branch, ...) — never a
 * device identity. See `approval-branch.ts`-style derivation in each
 * consumer (Sales/Treasury/Procurement) for the exact rule.
 *
 * The ONE capability a consuming module needs to obtain a synchronous
 * manager-PIN approval decision (FR-SEC-032): verify a PIN for an employee
 * permitted at a given BRANCH and receive back the verified actor's
 * identity facts AND their effective permission codes, without minting any
 * session or token.
 *
 * ── CLASSIFICATION: a verification contract, not a query or a command ──────
 * It has real side effects (failed-attempt counters, lockout) but creates no
 * durable domain state of its own — neither shape fits, so this follows the
 * `<subject>.contract.ts` form the repository already uses when one port
 * carries a business flow regardless of read/write direction.
 *
 * ── WHY THIS IS NOT `tx`-FIRST (a deliberate departure from every other
 *    contract in the repository) ──────────────────────────────────────────
 * `PinService.authenticate` opens its OWN `prisma.withAuthContext(...)`
 * transaction, and nested `withAuthContext` calls are explicitly unsupported
 * (`prisma.service.ts`). More importantly, a failed attempt's lockout
 * counter is persisted in a SEPARATE transaction specifically so it survives
 * a caller's rollback — if this call joined the caller's transaction, an
 * attacker could obtain unlimited PIN attempts simply by forcing that outer
 * transaction to roll back. This contract therefore manages its own
 * transaction(s) and must be called BEFORE the consuming module opens its
 * business transaction, never inside it.
 *
 * ── WHY THIS RETURNS THE EFFECTIVE PERMISSION SET ───────────────────────────
 * The Governance Approval runtime must validate `required_permission`
 * against the DECIDING user, who is not the request's own principal — and no
 * existing service answers "does user X hold permission Y" for a user other
 * than the current request's principal (`TenantContextService.resolve` needs
 * a full signed principal). Returning the set here — resolved from the SAME
 * membership this call already validates — is the minimum addition; a
 * general "query any user's permissions" API would be a strictly larger
 * Identity surface, and a private import of `TenantContextService` would be
 * a boundary violation.
 *
 * ── TRUST BOUNDARY (stated explicitly, per the 2026-08-29 acceptance
 *    closure §4) ─────────────────────────────────────────────────────────
 * `VerifiedApproverPrincipal` asserts that Identity verified a manager PIN
 * for an employee permitted at the given branch. A consumer (Governance)
 * CONSUMES this assertion and does not re-verify it — the same trust the
 * shipped `AuditService.record` already places in every caller's `actorId`,
 * and the same trust `SalesPaymentService`/`CashMovementsService`/
 * `CashSessionsService` already place in a caller-supplied trusted
 * `employeeId`. It is a design-discipline boundary (this is a modular
 * MONOLITH — a hostile in-process caller could bypass any module's public
 * contract entirely via a raw Prisma call, so no TypeScript-level guard is a
 * security boundary against that threat model). The SECURITY-CRITICAL
 * invariants — tenant isolation, requester != approver, excluded-approver !=
 * approver, expiry, one-final-decision — are enforced by the DATABASE and
 * hold regardless of what any caller passes.
 *
 * `VerifiedApproverPrincipal` is nonetheless BRANDED (an ambient, non-exported
 * `unique symbol`) so it cannot be fabricated by an ordinary object literal —
 * fabrication requires an explicit, greppable `as`/`as unknown as` cast. Even
 * Identity's own implementation must use that cast (a `declare`d unique
 * symbol has no runtime value), which is intentional: it turns "who can
 * produce this type" from an accident of structural typing into one visible,
 * reviewable act. `module-boundaries.spec.ts` mechanically confines that cast
 * to `src/modules/identity/`.
 *
 * Nothing here mints an auth session or token, and there is NO Governance or
 * Identity HTTP endpoint for this — it is an internal service capability
 * only (D-14 A-1 by analogy; FR-SEC-032 assigns no verifying module, and the
 * SRS context map places authentication in Identity, "upstream, conformist,
 * -> every context").
 */

/**
 * Ambient brand. Deliberately NOT exported as a value — only Identity's
 * implementation may construct a conforming object, and only via an explicit
 * cast (a `declare`d `unique symbol` has no runtime representation, so even
 * that implementation must cast). See the module docblock above.
 */
declare const VERIFIED_BY_IDENTITY: unique symbol;

export interface VerifyApproverPinInput {
  readonly tenantId: string;
  /**
   * The branch the approving employee's PIN/membership is verified against —
   * OPERATIONAL identity context, never a device identity. Derived by the
   * caller from the entity being approved (an order's branch, a cash
   * session's branch, ...), or, when no single unambiguous branch exists
   * (e.g. a tenant-wide Purchase Order), an explicit `approvalBranchId`
   * request field the caller's own DTO names.
   */
  readonly branchId: string;
  readonly employeeCode: string;
  readonly pin: string;
}

export interface VerifiedApproverPrincipal {
  /** Brand — see the module docblock. Never present at runtime. */
  readonly [VERIFIED_BY_IDENTITY]: true;
  readonly userId: string;
  readonly employeeId: string;
  readonly membershipId: string;
  readonly branchId: string;
  /** The verified actor's effective permission CODES in this tenant. */
  readonly permissions: ReadonlySet<string>;
}

export const APPROVER_PIN_VERIFIER = Symbol('APPROVER_PIN_VERIFIER');

export interface ApproverPinVerifier {
  /**
   * Verify a manager PIN for an employee permitted at `branchId` and return
   * the verified actor's identity facts plus their effective permission
   * codes.
   *
   * Reuses the EXACT `PinService.authenticate` verification path (employee
   * active + user-linked, permitted branch, PIN hash, lockout, active
   * membership) — nothing is duplicated here. Throws the same generic
   * authentication failure `PinService.authenticate` throws on any of those
   * checks failing; the failed-attempt counter and lockout persist
   * independently of the caller's own transaction/rollback.
   *
   * MUST be called BEFORE the consuming module opens its business
   * transaction (see the module docblock — nested `withAuthContext` is
   * unsupported, and joining the caller's transaction would let lockout
   * counters be rolled back away).
   */
  verifyApproverPin(
    input: VerifyApproverPinInput,
  ): Promise<VerifiedApproverPrincipal>;
}
