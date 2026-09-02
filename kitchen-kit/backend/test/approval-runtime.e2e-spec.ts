import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { AUDIT_ACTION } from './../src/modules/governance/audit/audit.constants';
import {
  APPROVAL_COMMANDS,
  ApprovalCommands,
  ApprovalDecisionConflictError,
  ApprovalDecisionRejectedError,
  ApprovalRequestConflictError,
  ApproverNotPermittedError,
  CreateApprovalRequestCommand,
} from './../src/modules/governance/contract';
import {
  TERMINAL_PIN_VERIFIER,
  TerminalPinVerifier,
  VerifiedTerminalPrincipal,
} from './../src/modules/identity/contract';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  INVENTORY_PERMISSIONS,
  INVENTORY_PERMISSION_DEFS,
} from './../src/modules/inventory/inventory.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-0's successor slice — the shared Governance Approval runtime
 * (migration 32, FR-SEC-030..033).
 *
 * Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Approval
 * Runtime Minimum Resolution — 2026-08-29" (RATIFIED) +
 * docs/reports/claude/2026-08-29_APPROVAL_runtime-design-acceptance-closure.md
 * (CONTROLLING).
 *
 * All calls go through the real `APPROVAL_COMMANDS`/`TERMINAL_PIN_VERIFIER`
 * services directly (not HTTP — Governance publishes no route at all, D-14
 * A-1), exactly the P1G-0 CONCURRENCY-block precedent this file follows for
 * every genuinely concurrent scenario.
 */
describe('Governance Approval runtime (e2e) — migration 32', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let approvals: ApprovalCommands;
  let pinVerifier: TerminalPinVerifier;
  let gatedAudit: GatedApprovalDecisionAudit;

  const stamp = Date.now();
  const password = 's3cure-passphrase';

  let tenantId: string;
  let branchId: string;
  let terminalId: string;

  let ownerUserId: string;
  let ownerEmployeeId: string;
  let manager1: VerifiedTerminalPrincipal;
  let manager2: VerifiedTerminalPrincipal;
  let noPermPrincipal: VerifiedTerminalPrincipal;

  const PERMISSION = INVENTORY_PERMISSIONS.APPROVE_HIGH_VARIANCE;
  const PIN_OWNER = '1111';
  const PIN_MGR1 = '2222';
  const PIN_MGR2 = '3333';
  const PIN_NOPERM = '4444';

  /**
   * Gate ONLY the `APPROVAL_DECISION_RECORDED` audit write — the LAST
   * statement inside `ApprovalsService.decide`'s successful-create path,
   * still inside the same transaction that holds the winning
   * `UNIQUE (tenant_id, approval_request_id)` row uncommitted. Filtered by
   * action, following the P1G-0 `GatedCashMovementAuditService` precedent,
   * so any concurrently-running `APPROVAL_REQUEST_CREATED` write is
   * unaffected.
   */
  class GatedApprovalDecisionAudit extends AuditService {
    private armed = false;
    private acquiredResolve: (() => void) | null = null;
    private gate: Promise<void> | null = null;
    private releaseGateFn: (() => void) | null = null;

    arm(): Promise<void> {
      this.armed = true;
      const acquired = new Promise<void>((res) => {
        this.acquiredResolve = res;
      });
      this.gate = new Promise<void>((res) => {
        this.releaseGateFn = res;
      });
      return acquired;
    }
    release(): void {
      this.releaseGateFn?.();
    }
    override async record(
      tx: Prisma.TransactionClient,
      event: Parameters<AuditService['record']>[1],
    ) {
      if (
        this.armed &&
        event.action === AUDIT_ACTION.APPROVAL_DECISION_RECORDED
      ) {
        this.armed = false;
        this.acquiredResolve?.();
        await this.gate;
      }
      return super.record(tx, event);
    }
  }

  /** Poll until a real, distinct backend is genuinely BLOCKED on the
   *  `approval_decisions` UNIQUE constraint (or its PK) — via
   *  `pg_stat_activity.wait_event_type='Lock'` on a backend whose own query
   *  names the table. Never a fixed sleep used as the proof itself. */
  async function waitForRealLockContention(
    client: PrismaClient,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await client.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%approval_decisions%'
      `;
      if (Number(rows[0].c) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for genuine Postgres lock contention on approval_decisions.',
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuditService)
      .useFactory({
        factory: (p: PrismaService) => {
          gatedAudit = new GatedApprovalDecisionAudit(p);
          return gatedAudit;
        },
        inject: [PrismaService],
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    approvals = app.get<ApprovalCommands>(APPROVAL_COMMANDS);
    pinVerifier = app.get<TerminalPinVerifier>(TERMINAL_PIN_VERIFIER);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(INVENTORY_PERMISSION_DEFS);

    const tenants = app.get(TenantsService);
    tenantId = (
      await tenants.create({
        slug: `approval-${stamp}`,
        legalName: 'Approval Runtime',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `Approval Brand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `AP${stamp % 10000}`,
        name: 'Approval Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchId = branch.id;
    // Every org.branches row must have a matching org.locations registry
    // row (repo-wide invariant, test/organisation.e2e-spec.ts) — Governance
    // itself never reads Location, but the fixture still owes it.
    await admin.location.create({
      data: {
        id: newId(),
        tenantId,
        locationType: 'branch',
        refId: branchId,
        branchId,
      },
    });

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId,
        branchId,
        name: 'Approval-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalId = terminal.id;

    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const pinService = app.get(PinService);

    const role = await roles.createTenantRole(tenantId, {
      name: `approve-role-${stamp}`,
    });
    await roles.addPermissions(tenantId, role.id, [PERMISSION]);

    /** Create a PIN-capable Employee (active, user-linked, permitted branch)
     *  and return its VerifiedTerminalPrincipal once via a real PIN login. */
    const mkPrincipal = async (
      code: string,
      pin: string,
      grantPermission: boolean,
    ): Promise<{
      principal: VerifiedTerminalPrincipal;
      userId: string;
      employeeId: string;
    }> => {
      const user = await users.createUser({
        email: `${code}.${stamp}@example.com`,
        password,
        displayName: code,
      });
      const membership = await memberships.grant(user.id, tenantId, 'active');
      if (grantPermission) {
        await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });
      }
      const employee = await admin.employee.create({
        data: {
          id: newId(),
          tenantId,
          userId: user.id,
          code: `${code}${stamp % 1000}`,
          displayName: code,
          homeBranchId: branchId,
          status: 'active',
        },
      });
      await admin.employeeBranch.create({
        data: { tenantId, employeeId: employee.id, branchId },
      });
      await pinService.setPin(tenantId, user.id, employee.id, pin);
      const principal = await pinVerifier.verifyTerminalPin({
        tenantId,
        terminalId,
        employeeCode: employee.code,
        pin,
      });
      return { principal, userId: user.id, employeeId: employee.id };
    };

    const ownerResult = await mkPrincipal('owner', PIN_OWNER, false);
    ownerUserId = ownerResult.userId;
    ownerEmployeeId = ownerResult.employeeId;

    manager1 = (await mkPrincipal('mgr1', PIN_MGR1, true)).principal;
    manager2 = (await mkPrincipal('mgr2', PIN_MGR2, true)).principal;
    noPermPrincipal = (await mkPrincipal('noperm', PIN_NOPERM, false))
      .principal;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkRequest = async (
    overrides: Partial<CreateApprovalRequestCommand> = {},
    requestedBy = ownerUserId,
  ) => {
    const command: CreateApprovalRequestCommand = {
      id: newId(),
      requestType: 'test_request',
      entityType: 'test_entity',
      entityId: newId(),
      value: { note: 'e2e', amountMinor: '5000' },
      requiredPermission: PERMISSION,
      expiresAt: new Date(Date.now() + 30_000),
      ...overrides,
    };
    const result = await prisma.withAuthContext(
      { userId: requestedBy, tenantId },
      (tx) => approvals.createRequest(tx, tenantId, requestedBy, command),
    );
    return result;
  };

  const decideAs = (
    approver: VerifiedTerminalPrincipal,
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    overrides: { id?: string; comment?: string } = {},
  ) =>
    prisma.withAuthContext({ userId: approver.userId, tenantId }, (tx) =>
      approvals.decide(tx, tenantId, {
        id: overrides.id ?? newId(),
        approvalRequestId,
        decision,
        comment: overrides.comment,
        approver,
      }),
    );

  // ============================================================= DOMAIN
  describe('DOMAIN — creation, replay/conflict, decision basics', () => {
    it('creates a pending request with all six FR-SEC-031 elements present', async () => {
      const { request, created } = await mkRequest();
      expect(created).toBe(true);
      expect(request.status).toBe('pending');
      expect(request.requestedBy).toBe(ownerUserId);
      expect(request.value).toEqual({ note: 'e2e', amountMinor: '5000' });
    });

    it('duplicate request id, identical facts -> replay, no duplicate audit', async () => {
      const id = newId();
      const entityId = newId();
      const expiresAt = new Date(Date.now() + 30_000);
      const command: CreateApprovalRequestCommand = {
        id,
        requestType: 'test_request',
        entityType: 'test_entity',
        entityId,
        value: { note: 'dup' },
        requiredPermission: PERMISSION,
        expiresAt,
      };
      const first = await prisma.withAuthContext(
        { userId: ownerUserId, tenantId },
        (tx) => approvals.createRequest(tx, tenantId, ownerUserId, command),
      );
      expect(first.created).toBe(true);
      const before = await admin.approvalRequest.count({ where: { id } });
      expect(before).toBe(1);

      const second = await prisma.withAuthContext(
        { userId: ownerUserId, tenantId },
        (tx) => approvals.createRequest(tx, tenantId, ownerUserId, command),
      );
      expect(second.created).toBe(false);
      expect(second.request.id).toBe(id);
      const after = await admin.approvalRequest.count({ where: { id } });
      expect(after).toBe(1);
    });

    it('duplicate request id, differing facts -> typed conflict', async () => {
      const { request } = await mkRequest();
      await expect(
        prisma.withAuthContext({ userId: ownerUserId, tenantId }, (tx) =>
          approvals.createRequest(tx, tenantId, ownerUserId, {
            id: request.id,
            requestType: 'DIFFERENT',
            entityType: 'test_entity',
            entityId: newId(),
            value: {},
            requiredPermission: PERMISSION,
            expiresAt: new Date(Date.now() + 30_000),
          }),
        ),
      ).rejects.toThrow(ApprovalRequestConflictError);
    });

    it('a decision transitions the request status', async () => {
      const { request } = await mkRequest();
      const { decision, created } = await decideAs(
        manager1,
        request.id,
        'approved',
      );
      expect(created).toBe(true);
      expect(decision.decision).toBe('approved');
      expect(decision.approverId).toBe(manager1.userId);

      const updated = await admin.approvalRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(updated.status).toBe('approved');
      // Append-only / immutability is proven against the real ros_app
      // connection in the "RLS / GRANTS matrix" describe block below.
    });

    it('duplicate decision id, identical facts -> replay, no CAS, no duplicate audit', async () => {
      const { request } = await mkRequest();
      const decisionId = newId();
      const first = await decideAs(manager1, request.id, 'approved', {
        id: decisionId,
      });
      expect(first.created).toBe(true);

      const auditCountBefore = await admin.auditEntry.count({
        where: {
          action: AUDIT_ACTION.APPROVAL_DECISION_RECORDED,
          entityId: decisionId,
        },
      });

      const second = await decideAs(manager1, request.id, 'approved', {
        id: decisionId,
      });
      expect(second.created).toBe(false);
      expect(second.decision.id).toBe(decisionId);

      const auditCountAfter = await admin.auditEntry.count({
        where: {
          action: AUDIT_ACTION.APPROVAL_DECISION_RECORDED,
          entityId: decisionId,
        },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('a second, DIFFERENT decision id for an already-decided request -> conflict, never replay, even with matching outcome', async () => {
      const { request } = await mkRequest();
      await decideAs(manager1, request.id, 'approved');
      await expect(decideAs(manager2, request.id, 'approved')).rejects.toThrow(
        ApprovalDecisionConflictError,
      );
    });

    it('deciding an unknown or already-decided request -> ApprovalNotPendingError', async () => {
      const { request } = await mkRequest();
      await decideAs(manager1, request.id, 'rejected');
      await expect(decideAs(manager2, request.id, 'approved')).rejects.toThrow(
        // A different decision id against an already-decided request is
        // reported as a decision conflict by the pre-INSERT existing-decision
        // check (§ zero-row algorithm), which fires before the not-pending
        // check would.
        ApprovalDecisionConflictError,
      );
    });

    it('decide rejects malformed permanent ids using a real VerifiedTerminalPrincipal (no fabricated brand)', async () => {
      const { request } = await mkRequest();
      await expect(
        prisma.withAuthContext({ userId: manager1.userId, tenantId }, (tx) =>
          approvals.decide(tx, tenantId, {
            id: 'not-a-uuid',
            approvalRequestId: request.id,
            decision: 'approved',
            approver: manager1,
          }),
        ),
      ).rejects.toThrow(/ULID rendered as a UUID/);

      await expect(
        prisma.withAuthContext({ userId: manager1.userId, tenantId }, (tx) =>
          approvals.decide(tx, tenantId, {
            id: newId(),
            approvalRequestId: 'not-a-uuid',
            decision: 'approved',
            approver: manager1,
          }),
        ),
      ).rejects.toThrow(/ULID rendered as a UUID/);
    });
  });

  // ========================================================= SCENARIO 5
  describe('SCENARIO 5 — expiry boundary semantics (decided_at <= expires_at)', () => {
    it('a decision well before expiry succeeds, and the DB-supplied decided_at is <= expires_at', async () => {
      const { request } = await mkRequest({
        expiresAt: new Date(Date.now() + 2000),
      });
      const { decision } = await decideAs(manager1, request.id, 'approved');
      expect(decision.decidedAt.getTime()).toBeLessThanOrEqual(
        request.expiresAt.getTime(),
      );
    });
  });

  // ========================================================= SCENARIO 6
  describe('SCENARIO 6 — decision after expiry', () => {
    it('a request already past its expires_at cannot receive a decision; zero rows, still pending', async () => {
      const alreadyExpired = new Date(Date.now() - 1000);
      const { request } = await mkRequest({ expiresAt: alreadyExpired });
      await expect(decideAs(manager1, request.id, 'approved')).rejects.toThrow(
        ApprovalDecisionRejectedError,
      );

      const rows = await admin.approvalDecision.count({
        where: { approvalRequestId: request.id },
      });
      expect(rows).toBe(0);
      const stillPending = await admin.approvalRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stillPending.status).toBe('pending');
    });
  });

  // ========================================================= SCENARIO 3/4
  describe('SCENARIOS 3 & 4 — self-approval and excluded approver, DB-enforced', () => {
    it('the requester cannot approve their own request', async () => {
      const { request } = await mkRequest({}, manager1.userId);
      await expect(decideAs(manager1, request.id, 'approved')).rejects.toThrow(
        ApprovalDecisionRejectedError,
      );
      const rows = await admin.approvalDecision.count({
        where: { approvalRequestId: request.id },
      });
      expect(rows).toBe(0);
    });

    it('the excluded approver cannot approve, even when they hold the required permission', async () => {
      const { request } = await mkRequest({
        excludedApproverUserId: manager1.userId,
      });
      await expect(decideAs(manager1, request.id, 'approved')).rejects.toThrow(
        ApprovalDecisionRejectedError,
      );
      // A different, non-excluded manager still succeeds.
      const { created } = await decideAs(manager2, request.id, 'approved');
      expect(created).toBe(true);
    });

    it('item 8: excludedApproverUserId is an Identity USER id, not an Employee id', async () => {
      const { request } = await mkRequest({
        excludedApproverUserId: ownerEmployeeId, // deliberately the EMPLOYEE id, not the user id
      });
      // Never matches approverId (a User id) -> the exclusion never fires,
      // and the decision succeeds — proving the column compares User ids.
      const { created } = await decideAs(manager1, request.id, 'approved');
      expect(created).toBe(true);
    });
  });

  // ========================================================= SCENARIO 12
  describe('SCENARIO 12 — approver missing the required permission', () => {
    it('no decision is created; a typed error is thrown before any INSERT', async () => {
      const { request } = await mkRequest();
      await expect(
        decideAs(noPermPrincipal, request.id, 'approved'),
      ).rejects.toThrow(ApproverNotPermittedError);
      const rows = await admin.approvalDecision.count({
        where: { approvalRequestId: request.id },
      });
      expect(rows).toBe(0);
    });
  });

  // ====================================================== SCENARIOS 13/14
  describe('SCENARIOS 13 & 14 — PIN verification integration', () => {
    it('wrong PIN -> no VerifiedTerminalPrincipal, no decision possible', async () => {
      await expect(
        pinVerifier.verifyTerminalPin({
          tenantId,
          terminalId,
          employeeCode: `mgr1${stamp % 1000}`,
          pin: '0000',
        }),
      ).rejects.toThrow();
    });

    it('lockout persists independently of any caller transaction/rollback, then blocks even the correct PIN', async () => {
      const usersSvc = app.get(UsersService);
      const membershipsSvc = app.get(MembershipsService);
      const pinService = app.get(PinService);
      const user = await usersSvc.createUser({
        email: `lockout.${stamp}@example.com`,
        password,
        displayName: 'lockout',
      });
      await membershipsSvc.grant(user.id, tenantId, 'active');
      const employee = await admin.employee.create({
        data: {
          id: newId(),
          tenantId,
          userId: user.id,
          code: `lock${stamp % 1000}`,
          displayName: 'lockout',
          homeBranchId: branchId,
          status: 'active',
        },
      });
      await admin.employeeBranch.create({
        data: { tenantId, employeeId: employee.id, branchId },
      });
      const realPin = '9999';
      await pinService.setPin(tenantId, user.id, employee.id, realPin);

      // 5 wrong attempts (PIN_MAX_FAILED_ATTEMPTS default) trip the lock.
      for (let i = 0; i < 5; i++) {
        await expect(
          pinVerifier.verifyTerminalPin({
            tenantId,
            terminalId,
            employeeCode: employee.code,
            pin: '0000',
          }),
        ).rejects.toThrow();
      }
      // The CORRECT PIN is now also refused — lockout, not just a bad guess.
      await expect(
        pinVerifier.verifyTerminalPin({
          tenantId,
          terminalId,
          employeeCode: employee.code,
          pin: realPin,
        }),
      ).rejects.toThrow(/temporarily locked/);
    }, 20_000);

    it('a valid manager PIN yields a principal with correct identity facts and permissions, and a decision succeeds', async () => {
      const principal = await pinVerifier.verifyTerminalPin({
        tenantId,
        terminalId,
        employeeCode: `mgr1${stamp % 1000}`,
        pin: PIN_MGR1,
      });
      expect(principal.branchId).toBe(branchId);
      expect(principal.terminalId).toBe(terminalId);
      expect(principal.permissions.has(PERMISSION)).toBe(true);

      const { request } = await mkRequest();
      const { created } = await decideAs(principal, request.id, 'approved');
      expect(created).toBe(true);
    });
  });

  // ========================================================= SCENARIO 10/11
  describe('SCENARIOS 10 & 11 — cross-tenant pairing and missing tenant context', () => {
    it('a decision cannot be structurally paired with a request from a different tenant', async () => {
      const otherTenants = app.get(TenantsService);
      const otherTenantId = (
        await otherTenants.create({
          slug: `approval-other-${stamp}`,
          legalName: 'Other',
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;

      const { request } = await mkRequest();
      // Attempt a decision under the OTHER tenant's RLS context, targeting
      // Tenant A's request id. The requests SELECT policy makes the row
      // invisible under tenant B's context, so it is reported NOT FOUND —
      // structurally unrepresentable, not merely rejected.
      await expect(
        prisma.withAuthContext(
          { userId: manager1.userId, tenantId: otherTenantId },
          (tx) =>
            approvals.decide(tx, otherTenantId, {
              id: newId(),
              approvalRequestId: request.id,
              decision: 'approved',
              approver: manager1,
            }),
        ),
      ).rejects.toThrow();

      const rows = await admin.approvalDecision.count({
        where: { approvalRequestId: request.id },
      });
      expect(rows).toBe(0);
    });

    it('missing tenant context fails closed on the INSERT policy', async () => {
      const { request } = await mkRequest();
      // No app.tenant_id set at all -> NULLIF(...)::uuid is NULL -> the
      // WITH CHECK's top-level conjunct evaluates to NULL, never TRUE.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            INSERT INTO "governance"."approval_decisions"
              ("id","tenant_id","approval_request_id","approver_id","decision")
            VALUES (${newId()}::uuid, ${tenantId}::uuid, ${request.id}::uuid,
                    ${manager1.userId}::uuid, 'approved')
          `;
        }),
      ).rejects.toThrow();
    });
  });

  // ========================================================= RLS / GRANTS
  describe('RLS / GRANTS matrix', () => {
    it('approval_requests: same-tenant SELECT works, cross-tenant is invisible', async () => {
      const { request } = await mkRequest();
      const seenOwn = await prisma.withAuthContext(
        { userId: ownerUserId, tenantId },
        (tx) => tx.approvalRequest.findUnique({ where: { id: request.id } }),
      );
      expect(seenOwn).not.toBeNull();

      const otherTenants = app.get(TenantsService);
      const otherTenantId = (
        await otherTenants.create({
          slug: `approval-rls-${stamp}`,
          legalName: 'RLS Other',
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
      const seenCross = await prisma.withAuthContext(
        { userId: ownerUserId, tenantId: otherTenantId },
        (tx) => tx.approvalRequest.findUnique({ where: { id: request.id } }),
      );
      expect(seenCross).toBeNull();
    });

    it('approval_requests: no column except status is writable by ros_app', async () => {
      const { request } = await mkRequest();
      // `prisma` is the app's OWN PrismaService — a real ros_app connection,
      // not the migrator. The column-level GRANT UPDATE("status") makes
      // every other column structurally unwritable.
      await expect(
        prisma.withAuthContext(
          { userId: ownerUserId, tenantId },
          (tx) =>
            tx.$executeRaw`
            UPDATE "governance"."approval_requests"
            SET "request_type" = 'x' WHERE "id" = ${request.id}::uuid
          `,
        ),
      ).rejects.toThrow();
    });

    it('approval_requests: SELECT/INSERT are table-level, UPDATE is column("status")-level only, DELETE/TRUNCATE absent', async () => {
      // `role_table_grants` does NOT surface a column-level-only grant (the
      // `status` UPDATE grant), so UPDATE must be checked via
      // `role_column_grants` instead — verified empirically against this
      // exact Postgres version.
      const tableGrants = await admin.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='governance' AND table_name='approval_requests' AND grantee='ros_app'
      `;
      const tablePrivileges = tableGrants.map((g) => g.privilege_type);
      expect(tablePrivileges).toEqual(
        expect.arrayContaining(['SELECT', 'INSERT']),
      );
      expect(tablePrivileges).not.toContain('DELETE');
      expect(tablePrivileges).not.toContain('TRUNCATE');
      expect(tablePrivileges).not.toContain('UPDATE');

      const columnUpdateGrants = await admin.$queryRaw<
        { column_name: string }[]
      >`
        SELECT column_name FROM information_schema.role_column_grants
        WHERE table_schema='governance' AND table_name='approval_requests'
          AND grantee='ros_app' AND privilege_type='UPDATE'
      `;
      expect(columnUpdateGrants.map((g) => g.column_name)).toEqual(['status']);
    });

    it('approval_requests: ros_app genuinely cannot DELETE a real request row', async () => {
      const { request } = await mkRequest();
      await expect(
        prisma.withAuthContext(
          { userId: ownerUserId, tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "governance"."approval_requests" WHERE "id" = ${request.id}::uuid`,
        ),
      ).rejects.toThrow();
      const stillThere = await admin.approvalRequest.count({
        where: { id: request.id },
      });
      expect(stillThere).toBe(1);
    });

    it('approval_decisions: SELECT works, UPDATE/DELETE/TRUNCATE unavailable to ros_app', async () => {
      const grants = await admin.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='governance' AND table_name='approval_decisions' AND grantee='ros_app'
      `;
      const privileges = new Set(grants.map((g) => g.privilege_type));
      expect(privileges.has('SELECT')).toBe(true);
      expect(privileges.has('UPDATE')).toBe(false);
      expect(privileges.has('DELETE')).toBe(false);
      expect(privileges.has('TRUNCATE')).toBe(false);
    });

    it('approval_decisions: ros_app genuinely cannot UPDATE or DELETE a real decision row', async () => {
      const { request } = await mkRequest();
      const { decision } = await decideAs(manager1, request.id, 'approved');

      await expect(
        prisma.withAuthContext(
          { userId: ownerUserId, tenantId },
          (tx) =>
            tx.$executeRaw`
            UPDATE "governance"."approval_decisions"
            SET "comment" = 'hacked' WHERE "id" = ${decision.id}::uuid
          `,
        ),
      ).rejects.toThrow();

      await expect(
        prisma.withAuthContext(
          { userId: ownerUserId, tenantId },
          (tx) =>
            tx.$executeRaw`
            DELETE FROM "governance"."approval_decisions" WHERE "id" = ${decision.id}::uuid
          `,
        ),
      ).rejects.toThrow();

      const stillThere = await admin.approvalDecision.findUniqueOrThrow({
        where: { id: decision.id },
      });
      expect(stillThere.comment).toBeNull();
    });

    it('approval_decisions: ros_app has column-level INSERT that excludes decided_at and created_at', async () => {
      const columnGrants = await admin.$queryRaw<
        { column_name: string; privilege_type: string }[]
      >`
        SELECT column_name, privilege_type FROM information_schema.role_column_grants
        WHERE table_schema='governance' AND table_name='approval_decisions'
          AND grantee='ros_app' AND privilege_type='INSERT'
      `;
      const insertableColumns = new Set(columnGrants.map((g) => g.column_name));
      expect(insertableColumns.has('decided_at')).toBe(false);
      expect(insertableColumns.has('created_at')).toBe(false);
      expect(insertableColumns.has('approver_id')).toBe(true);
      expect(insertableColumns.has('decision')).toBe(true);
    });

    it('proves ros_app cannot supply decided_at even if it tries', async () => {
      const { request } = await mkRequest();
      await expect(
        prisma.withAuthContext(
          { userId: manager1.userId, tenantId },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "governance"."approval_decisions"
              ("id","tenant_id","approval_request_id","approver_id","decision","decided_at")
            VALUES (${newId()}::uuid, ${tenantId}::uuid, ${request.id}::uuid,
                    ${manager1.userId}::uuid, 'approved', now())
          `,
        ),
      ).rejects.toThrow();
    });
  });

  // ============================================== SCENARIOS 1 & 2 & 8 & 30
  describe('SCENARIOS 1, 2, 8, 30 — decision-cardinality races (real Postgres UNIQUE constraint)', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: two managers approve the SAME request concurrently -> exactly one decision, one audit, loser conflicts`, async () => {
        const { request } = await mkRequest();

        const lockAcquired = gatedAudit.arm();
        const first = decideAs(manager1, request.id, 'approved');
        await lockAcquired;

        const second = decideAs(manager2, request.id, 'approved');
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const results = await Promise.allSettled([first, second]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(
          ApprovalDecisionConflictError,
        );

        const rows = await admin.approvalDecision.findMany({
          where: { approvalRequestId: request.id },
        });
        expect(rows).toHaveLength(1);
        const auditRows = await admin.auditEntry.count({
          where: {
            action: AUDIT_ACTION.APPROVAL_DECISION_RECORDED,
            entityId: rows[0].id,
          },
        });
        expect(auditRows).toBe(1);

        const finalRequest = await admin.approvalRequest.findUniqueOrThrow({
          where: { id: request.id },
        });
        expect(finalRequest.status).toBe('approved');
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: approve vs reject concurrently -> first insert wins, second conflicts, status matches winner`, async () => {
        const { request } = await mkRequest();

        const lockAcquired = gatedAudit.arm();
        const approvePromise = decideAs(manager1, request.id, 'approved');
        await lockAcquired;

        const rejectPromise = decideAs(manager2, request.id, 'rejected');
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const results = await Promise.allSettled([
          approvePromise,
          rejectPromise,
        ]);
        const fulfilled = results.find((r) => r.status === 'fulfilled');
        expect(fulfilled).toBeDefined();

        const finalRequest = await admin.approvalRequest.findUniqueOrThrow({
          where: { id: request.id },
        });
        expect(finalRequest.status).toBe(fulfilled!.value.decision.decision);

        const rows = await admin.approvalDecision.count({
          where: { approvalRequestId: request.id },
        });
        expect(rows).toBe(1);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: duplicate permanent decision id raced concurrently -> exactly one business effect, one row, one audit`, async () => {
        const { request } = await mkRequest();
        const decisionId = newId();

        const lockAcquired = gatedAudit.arm();
        const first = decideAs(manager1, request.id, 'approved', {
          id: decisionId,
        });
        await lockAcquired;

        // Same manager, same decision id, same content — a genuine
        // concurrent retry, not a different approver.
        const second = decideAs(manager1, request.id, 'approved', {
          id: decisionId,
        });
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const [r1, r2] = await Promise.all([first, second]);
        // Exactly one created the row; the other replayed it.
        expect([r1.created, r2.created].sort()).toEqual([false, true]);
        expect(r1.decision.id).toBe(decisionId);
        expect(r2.decision.id).toBe(decisionId);

        const rows = await admin.approvalDecision.count({
          where: { id: decisionId },
        });
        expect(rows).toBe(1);
        const auditRows = await admin.auditEntry.count({
          where: {
            action: AUDIT_ACTION.APPROVAL_DECISION_RECORDED,
            entityId: decisionId,
          },
        });
        expect(auditRows).toBe(1);
      }, 20_000);
    }
  });

  // ==================================================== SCENARIO 9
  describe('SCENARIO 9 — atomicity of decision INSERT + status CAS under a genuine failure', () => {
    /**
     * `ApprovalsService.decide`'s own "CAS affected 0 rows -> throw" branch
     * is UNREACHABLE in real operation: winning the per-request UNIQUE
     * constraint on the decision INSERT is exclusive proof that no other
     * decide() call can be concurrently mutating this request's status
     * (status is transitioned ONLY by decide(), gated by that SAME
     * constraint). This test instead proves the underlying PostgreSQL
     * guarantee decide()'s design relies on directly: using the SAME two
     * statement shapes (decision INSERT, then request status UPDATE) inside
     * one explicit transaction that is deliberately aborted between them,
     * proving NO partial state — zero decision rows, unchanged status —
     * survives a rollback. This is real transactional atomicity, not a
     * mock.
     */
    it('a transaction that fails between the decision INSERT and the status UPDATE leaves zero decision rows and an unchanged request status', async () => {
      const { request } = await mkRequest();
      const decisionId = newId();

      await expect(
        admin.$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "governance"."approval_decisions"
              ("id","tenant_id","approval_request_id","approver_id","decision")
            VALUES (${decisionId}::uuid, ${tenantId}::uuid, ${request.id}::uuid,
                    ${manager1.userId}::uuid, 'approved')
          `;
          // Deliberately injected failure BEFORE the status CAS.
          throw new Error('injected failure between INSERT and CAS');
        }),
      ).rejects.toThrow('injected failure between INSERT and CAS');

      const decisionRows = await admin.approvalDecision.count({
        where: { id: decisionId },
      });
      expect(decisionRows).toBe(0);
      const stillPending = await admin.approvalRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stillPending.status).toBe('pending');

      // The real service can still decide this request normally afterward —
      // proving the aborted attempt left no residue at all.
      const { created } = await decideAs(manager1, request.id, 'approved');
      expect(created).toBe(true);
    }, 15_000);
  });

  // ============================================= SCENARIO 15 (MANDATORY)
  describe('SCENARIO 15 — long-transaction expiry discriminator (statement_timestamp vs transaction_timestamp)', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: a transaction begun BEFORE expiry, held open ACROSS the boundary, is rejected when it attempts the decision INSERT AFTER real expiry`, async () => {
        const startRow = await admin.$queryRaw<{ now: Date }[]>`
          SELECT statement_timestamp() AS now
        `;
        const expiresAt = new Date(startRow[0].now.getTime() + 400);
        const { request } = await mkRequest({ expiresAt });

        let caught: unknown;
        await expect(
          prisma.withAuthContext(
            { userId: manager1.userId, tenantId },
            async (tx) => {
              // Prove the transaction genuinely began BEFORE expiry.
              const t0 = await tx.$queryRaw<{ t: Date }[]>`
                SELECT transaction_timestamp() AS t
              `;
              expect(t0[0].t.getTime()).toBeLessThan(expiresAt.getTime());

              // Bounded poll (cadence only, never the proof) on a SEPARATE
              // connection until real wall time has crossed expiresAt.
              const deadline = Date.now() + 5000;
              for (;;) {
                const crossedRows = await admin.$queryRaw<
                  { crossed: boolean }[]
                >`SELECT statement_timestamp() > ${expiresAt}::timestamptz AS crossed`;
                if (crossedRows[0].crossed) break;
                if (Date.now() > deadline) {
                  throw new Error(
                    'Timed out waiting to cross the expiry boundary.',
                  );
                }
                await new Promise((r) => setTimeout(r, 15));
              }

              // Prove statement time INSIDE the still-open transaction has
              // ALSO crossed the boundary, while transaction time has NOT —
              // the exact discriminator between the two clocks.
              const after = await tx.$queryRaw<{ stmt: Date; txn: Date }[]>`
                SELECT statement_timestamp() AS stmt, transaction_timestamp() AS txn
              `;
              expect(after[0].stmt.getTime()).toBeGreaterThan(
                expiresAt.getTime(),
              );
              expect(after[0].txn.getTime()).toBe(t0[0].t.getTime());

              try {
                await approvals.decide(tx, tenantId, {
                  id: newId(),
                  approvalRequestId: request.id,
                  decision: 'approved',
                  approver: manager1,
                });
              } catch (err) {
                caught = err;
                throw err; // propagate so the whole transaction rolls back
              }
            },
          ),
        ).rejects.toThrow();
        expect(caught).toBeInstanceOf(ApprovalDecisionRejectedError);

        const rows = await admin.approvalDecision.count({
          where: { approvalRequestId: request.id },
        });
        expect(rows).toBe(0);
        const stillPending = await admin.approvalRequest.findUniqueOrThrow({
          where: { id: request.id },
        });
        expect(stillPending.status).toBe('pending');
      }, 15_000);
    }
  });
});
