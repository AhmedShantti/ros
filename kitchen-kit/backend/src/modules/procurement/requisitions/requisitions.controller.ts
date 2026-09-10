import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { UUID_PATTERN } from '../../../common/ids';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequireAnyPermission,
  RequirePermission,
  TenantContextGuard,
  tenantTarget,
} from '../../identity/contract';
import type { TenantContext } from '../../identity/contract';
import {
  CreateRequisitionDto,
  ListRequisitionsQueryDto,
} from '../procurement.dto';
import { PROCUREMENT_PERMISSIONS } from '../procurement.permissions';
import { toRequisitionView } from '../procurement.views';
import { RequisitionsService } from './requisitions.service';

const requisitionSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    requestingBranchId: uuidSchema(),
    requestedBy: uuidSchema(),
    status: { type: 'string', enum: ['draft', 'submitted', 'converted'] },
    notes: nullable({ type: 'string' }),
    createdAt: isoDateTimeSchema(),
    submittedAt: nullable(isoDateTimeSchema()),
    lines: { type: 'array', items: { type: 'object' } },
  },
};

/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §1 — FR-PRC-015 Purchase Requisition.
 * Back-office/console only (no `@AllowPosSession()`, mission brief §11).
 *
 * Requisition/Purchase-Order data records a real branch attribution but is
 * declared `tenantTarget` here, the same posture Supplier Foundation P1 took
 * for its own tenant-wide master data — a narrower, resource/branch-derived
 * B1-3 target (via a new `ScopeTargetResolver`) is a reasonable future
 * refinement, deliberately not built in this slice (out of the mission
 * brief's core FR-PRC-015..023 scope). RLS still enforces full tenant
 * isolation and `PermissionGuard` still enforces the coarse permission
 * check regardless.
 */
@ApiTags('procurement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('procurement/requisitions')
export class RequisitionsController {
  constructor(private readonly requisitions: RequisitionsService) {}

  @Post()
  @RequirePermission(PROCUREMENT_PERMISSIONS.REQUISITION_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase requisitions are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: requisitionSchema })
  async create(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateRequisitionDto,
  ) {
    return toRequisitionView(
      await this.requisitions.create(ctx.tenantId, ctx.userId, dto),
    );
  }

  @Get()
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.REQUISITION_CREATE,
    PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE,
  )
  @AuthorizationTarget(
    tenantTarget('Purchase requisitions are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: { type: 'array', items: requisitionSchema } })
  async list(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: ListRequisitionsQueryDto,
  ) {
    const rows = await this.requisitions.findAll(ctx.tenantId, ctx.userId, {
      status: query.status,
      requestingBranchId: query.requestingBranchId,
    });
    return rows.map(toRequisitionView);
  }

  @Get(':id')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.REQUISITION_CREATE,
    PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE,
  )
  @AuthorizationTarget(
    tenantTarget('Purchase requisitions are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: requisitionSchema })
  async getById(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException('Requisition not found.');
    }
    const requisition = await this.requisitions.findById(
      ctx.tenantId,
      ctx.userId,
      id,
    );
    if (!requisition) throw new NotFoundException('Requisition not found.');
    return toRequisitionView(requisition);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PROCUREMENT_PERMISSIONS.REQUISITION_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase requisitions are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: requisitionSchema })
  async submit(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return toRequisitionView(
      await this.requisitions.submit(ctx.tenantId, ctx.userId, id),
    );
  }
}
