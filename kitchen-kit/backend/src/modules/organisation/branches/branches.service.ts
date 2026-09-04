import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { BranchStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import type { ScopedGrant } from '../../identity/context/tenant-context';
import {
  SCOPE_REVIEW_QUERY,
  type ScopeReviewQuery,
} from '../../identity/contract';
import { LocationsService } from '../locations/locations.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import { BranchSummary, toBranchSummary } from './branch.view';

const CODE_CONFLICT = 'A branch with this code already exists in the tenant.';
const BRAND_NOT_FOUND = 'Brand not found.';

export interface CreateBranchInput {
  brandId: string;
  code: string;
  name: string;
  timezone: string;
  baseCurrency: string;
  countryCode: string;
  address?: Record<string, unknown>;
  automaticAvailability?: boolean;
}

export interface UpdateBranchInput {
  name?: string;
  timezone?: string;
  baseCurrency?: string;
  countryCode?: string;
  address?: Record<string, unknown>;
  automaticAvailability?: boolean;
}

/**
 * Branch administration (SRS §7.3 #5 — aggregate root containing OperatingHours,
 * Tables and PrintRouting).
 *
 * Tenant safety is enforced at three layers: the tenant comes only from the
 * validated TenantContext; RLS hides other tenants' rows; and the composite FK
 * `(tenant_id, brand_id) → brands(tenant_id, id)` makes a branch pointing at
 * another tenant's brand structurally impossible (ADR 0008 D-09) — PostgreSQL
 * evaluates FK checks with row security disabled, so the FK is the only thing
 * that can enforce that edge.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
    @Inject(SCOPE_REVIEW_QUERY)
    private readonly scopeReview: ScopeReviewQuery,
  ) {}

  /**
   * M-4+ SECOND-ACTIVE-BRANCH GATE (ratified amendment clause 13.C).
   *
   * The B1-2 migration backfilled every pre-existing role assignment as TENANT
   * scope, because that is what an unscoped assignment actually meant. Those
   * inherited grants are harmless while a tenant operates ONE branch — they
   * already covered it. The moment a tenant becomes multi-branch they would
   * SILENTLY widen to cover the new branch too, which is exactly the outcome the
   * ratified decision forbids ("Inherited access MUST NOT be silently widened
   * when a tenant moves into multi-branch operation").
   *
   * So the gate fires at the 1 -> 2 transition, and only there:
   *
   *   currently >= 2 active branches -> NOT gated. The tenant is already
   *     multi-branch (limb D): migration must not fail it, must not declare it
   *     branch-RBAC-ready, and must not retroactively break its operations.
   *     Its review-required state is derived and reported, not enforced here.
   *   currently  < 2, and this operation would produce the second active
   *     branch, and unreviewed inherited grants remain -> DENY, fail closed,
   *     with an actionable message.
   *
   * The count and the review check run INSIDE the caller's transaction, so the
   * decision cannot straddle a concurrent activation.
   *
   * This is the ONLY Organisation business behaviour B1-2 changes; it is
   * specifically authorised because the migration requires it.
   */
  private async assertMayBecomeMultiBranch(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const activeCount = await tx.branch.count({
      where: { status: 'active' },
    });
    if (activeCount !== 1) {
      // 0 -> 1 is the first branch; >= 2 is the already-multi-branch case.
      return;
    }
    if (!(await this.scopeReview.hasUnreviewedInheritedAssignments(tx))) {
      return;
    }
    throw new ForbiddenException(
      'This tenant cannot activate a second branch while role assignments inherited ' +
        'by the scoped-RBAC migration are still unreviewed: they were granted tenant-wide ' +
        'before branches were an authorization boundary, and activating a second branch ' +
        'would silently extend them to it. Review or re-scope every assignment reported by ' +
        'GET /auth/permissions (scopeReviewRequired), then retry.',
    );
  }

  async create(
    tenantId: string,
    actorId: string,
    input: CreateBranchInput,
  ): Promise<BranchSummary> {
    try {
      const branch = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          // `branches.status` defaults to `active`, so creating a branch IS
          // activating one — the gate belongs here as well as on setStatus.
          await this.assertMayBecomeMultiBranch(tx);
          const created = await tx.branch.create({
            data: {
              id: newId(),
              tenantId,
              brandId: input.brandId,
              code: input.code,
              name: input.name,
              timezone: input.timezone,
              baseCurrency: input.baseCurrency,
              countryCode: input.countryCode,
              ...(input.address !== undefined
                ? { address: input.address as Prisma.InputJsonValue }
                : {}),
              ...(input.automaticAvailability !== undefined
                ? { automaticAvailability: input.automaticAvailability }
                : {}),
            },
          });
          // P15-4: register the branch in org.locations inside the SAME
          // transaction, so a branch can never exist without its location row
          // (the identity Inventory will FK against).
          await this.locations.register(tx, tenantId, 'branch', created.id);
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_CREATED,
            entityType: AUDIT_ENTITY.BRANCH,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              code: created.code,
              name: created.name,
              brandId: created.brandId,
            },
          });
          return created;
        },
      );
      return toBranchSummary(branch);
    } catch (err) {
      // P2003 here means the brand is not in this tenant (or does not exist) —
      // 404 either way, so a foreign brand id is indistinguishable from a
      // missing one.
      rethrowAsNotFoundOnFk(err, BRAND_NOT_FOUND, CODE_CONFLICT);
    }
  }

  list(tenantId: string): Promise<BranchSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.branch.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((branches) => branches.map(toBranchSummary));
  }

  /**
   * MTMB-1 — the branches actually visible to a caller's LIVE scoped
   * authority, for frontend branch discovery (SRS §5.6 / FR-SEC-002..004).
   *
   * Deliberately NOT `list()`: that lists every branch in the tenant and is
   * itself a TENANT-target read (gated by `ORGANISATION_PERMISSIONS.
   * BRANCH_READ` held at TENANT scope), so a branch-scoped actor holding that
   * permission only at Branch 1 gets 403 from it — correctly, but leaving no
   * route at all through which they can discover their OWN accessible
   * branches. This is that route's query, expressed directly from the
   * caller's resolved `grants` (never from a JWT claim, never from
   * `EmployeeBranch` — those narrow, they do not grant per `identity/authz/
   * scope-authorization.service.ts`).
   *
   * The lattice, mirrored from `identity/authz/scope.ts` `coversTarget`
   * without importing it (that file is a private Identity path; Organisation
   * is only permitted `identity/context/tenant-context`, which is where
   * `ScopedGrant` itself lives — see `module-boundaries.spec.ts`):
   *   - a TENANT-scoped grant sees every branch in the tenant (active or
   *     not — visibility is an authorization question, not an operability
   *     one; `status` is returned so the frontend can grey out an inactive
   *     branch rather than have it silently vanish);
   *   - a BRAND-scoped grant sees every branch under that brand;
   *   - a BRANCH-scoped grant sees exactly that branch.
   * The result is the UNION across every held grant — never an intersection,
   * never a single "best" grant — because FR-SEC-003 lets one actor hold
   * several independent scoped assignments at once.
   *
   * Zero grants (e.g. a membership with no scoped role assignments at all)
   * returns an empty list — never "every branch", which would be exactly the
   * unrestricted-by-omission failure R-8 forbids.
   */
  async listAccessible(
    tenantId: string,
    grants: readonly ScopedGrant[],
  ): Promise<BranchSummary[]> {
    if (grants.some((g) => g.scope.type === 'tenant')) {
      return this.list(tenantId);
    }
    const brandIds = [
      ...new Set(
        grants
          .filter((g) => g.scope.type === 'brand')
          .map((g) => (g.scope as { brandId: string }).brandId),
      ),
    ];
    const branchIds = [
      ...new Set(
        grants
          .filter((g) => g.scope.type === 'branch')
          .map((g) => (g.scope as { branchId: string }).branchId),
      ),
    ];
    if (brandIds.length === 0 && branchIds.length === 0) {
      return [];
    }
    const branches = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.branch.findMany({
        where: {
          OR: [
            ...(brandIds.length > 0 ? [{ brandId: { in: brandIds } }] : []),
            ...(branchIds.length > 0 ? [{ id: { in: branchIds } }] : []),
          ],
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return branches.map(toBranchSummary);
  }

  async findOne(tenantId: string, branchId: string): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.branch.findUnique({ where: { id: branchId } }),
    );
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
    return toBranchSummary(branch);
  }

  async update(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: UpdateBranchInput,
  ): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.branch.findUnique({
          where: { id: branchId },
        });
        if (!existing) {
          throw new NotFoundException('Branch not found.');
        }
        const updated = await tx.branch.update({
          where: { id: branchId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.timezone !== undefined
              ? { timezone: input.timezone }
              : {}),
            ...(input.baseCurrency !== undefined
              ? { baseCurrency: input.baseCurrency }
              : {}),
            ...(input.countryCode !== undefined
              ? { countryCode: input.countryCode }
              : {}),
            ...(input.address !== undefined
              ? { address: input.address as Prisma.InputJsonValue }
              : {}),
            ...(input.automaticAvailability !== undefined
              ? { automaticAvailability: input.automaticAvailability }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.BRANCH_UPDATED,
          entityType: AUDIT_ENTITY.BRANCH,
          actorType: 'user',
          actorId,
          entityId: branchId,
          before: { name: existing.name, timezone: existing.timezone },
          metadata: { name: updated.name, timezone: updated.timezone },
        });
        return updated;
      },
    );
    return toBranchSummary(branch);
  }

  /** ADR 0008 D-03: explicit status change, audited; not a generic PATCH field. */
  async setStatus(
    tenantId: string,
    actorId: string,
    branchId: string,
    status: BranchStatus,
  ): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.branch.findUnique({
          where: { id: branchId },
        });
        if (!existing) {
          throw new NotFoundException('Branch not found.');
        }
        if (status === 'active' && existing.status !== 'active') {
          await this.assertMayBecomeMultiBranch(tx);
        }
        const updated = await tx.branch.update({
          where: { id: branchId },
          data: { status },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.BRANCH_STATUS_CHANGED,
          entityType: AUDIT_ENTITY.BRANCH,
          actorType: 'user',
          actorId,
          entityId: branchId,
          before: { status: existing.status },
          metadata: { status: updated.status },
        });
        return updated;
      },
    );
    return toBranchSummary(branch);
  }

  /**
   * Reassign a branch to another brand **within the same tenant**
   * (FR-PLT-004 [S], ADR 0008 D-13). A dedicated operation rather than a PATCH
   * field, so the audit entry names the action rather than burying it in a diff.
   *
   * `code` is never touched — FR-POS-002 embeds it in offline-generated order
   * numbers, so changing it would make historical order numbers ambiguous.
   * A cross-tenant target brand is rejected by the composite FK, not by an
   * application check.
   */
  async reassignBrand(
    tenantId: string,
    actorId: string,
    branchId: string,
    brandId: string,
  ): Promise<BranchSummary> {
    try {
      const branch = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.branch.findUnique({
            where: { id: branchId },
          });
          if (!existing) {
            throw new NotFoundException('Branch not found.');
          }
          const updated = await tx.branch.update({
            where: { id: branchId },
            data: { brandId },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_BRAND_REASSIGNED,
            entityType: AUDIT_ENTITY.BRANCH,
            actorType: 'user',
            actorId,
            entityId: branchId,
            before: { brandId: existing.brandId },
            metadata: { brandId: updated.brandId, code: updated.code },
          });
          return updated;
        },
      );
      return toBranchSummary(branch);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, BRAND_NOT_FOUND);
    }
  }

  /**
   * Resolve a branch id within the acting tenant, for services that own
   * branch-scoped children. Returns 404 for a foreign/missing branch so child
   * endpoints cannot be used to probe branch existence across tenants.
   */
  async assertBranchInTenant(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<void> {
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
  }
}
