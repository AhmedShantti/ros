import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { AuthorizationTarget, branchFromParam } from '../../identity/contract';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';
import { CreateDrawerDto } from './dto/create-drawer.dto';
import { DrawersService } from './drawers.service';
import { drawerSchema, toDrawerView } from './drawer.view';

/**
 * Drawer administration — DEMO-OPS-HOTFIX-3.
 *
 * A DASHBOARD/back-office route (no `@AllowPosSession`, mirroring
 * `CashClosePolicyController` exactly): provisioning the physical cash
 * containers a branch owns is a `settings.branch.manage` act, not a cashier
 * operation. A Cashier selects among ALREADY-provisioned drawers through the
 * SEPARATE `GET /cash-sessions/drawers` on `TreasuryController` (POS-session
 * only, gated on `cash.session.open` — the permission they already hold to
 * open a shift, never this one), so this controller cannot be reached by a
 * PIN-issued session at all (FR-SEC-021).
 *
 * ROUTE FAMILY: `/branches/{branchId}/drawers` — the same `/branches/...`
 * resource family `CashClosePolicyController` already established for
 * branch-scoped Treasury configuration, not nested under `/cash-sessions`
 * (a cash-session OPERATION resource, not administration).
 *
 * No PATCH/DELETE: deactivating or rebinding a drawer is not this ticket's
 * ask, and inventing that surface now would be scope creep beyond the
 * reported blocker (a Cashier's shift-open 404ing for want of ANY real
 * drawer to reference).
 */
@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('branches')
export class DrawersController {
  constructor(private readonly drawers: DrawersService) {}

  @Post(':branchId/drawers')
  @AuthorizationTarget(branchFromParam('branchId'))
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The newly created drawer.',
    schema: drawerSchema,
  })
  @ApiNotFoundResponse({
    description: 'Branch not found, or the referenced terminal not found.',
  })
  @ApiConflictResponse({
    description:
      "The referenced terminal is not registered to this branch, or the Idempotency-Key was already used with a different request body / is still in flight.",
  })
  async createDrawer(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateDrawerDto,
  ) {
    const drawer = await this.drawers.create(context.tenantId, context.userId, {
      branchId,
      name: dto.name,
      terminalId: dto.terminalId ?? null,
    });
    return toDrawerView(drawer);
  }

  @Get(':branchId/drawers')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE)
  @ApiOkResponse({
    description: 'All drawers in the branch.',
    schema: { type: 'array', items: drawerSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  async listDrawers(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    const rows = await this.drawers.listForBranch(context.tenantId, branchId);
    return rows.map(toDrawerView);
  }
}
