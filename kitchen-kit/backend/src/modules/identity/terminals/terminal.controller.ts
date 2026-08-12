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
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../authz/guards/permission.guard';
import { IDENTITY_PERMISSIONS } from '../authz/permissions.constants';
import { CurrentTenantContext } from '../context/current-tenant-context.decorator';
import type { TenantContext } from '../context/tenant-context';
import { TenantContextGuard } from '../context/tenant-context.guard';
import { AddFingerprintDto } from './dto/add-fingerprint.dto';
import { BindTerminalDto } from './dto/bind-terminal.dto';
import { RegisterTerminalDto } from './dto/register-terminal.dto';
import { SetTerminalStatusDto } from './dto/set-terminal-status.dto';
import { TerminalSessionService } from './terminal-session.service';
import { TerminalsService } from './terminals.service';

// JwtAuthGuard (401) → TenantContextGuard (403) → PermissionGuard (403).
@ApiTags('terminals')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('auth')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalsService,
    private readonly terminalSessions: TerminalSessionService,
    private readonly audit: AuditService,
  ) {}

  @Post('terminals')
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  async register(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: RegisterTerminalDto,
  ) {
    const terminal = await this.terminals.register(ctx.tenantId, dto);
    await this.audit.emit({
      tenantId: ctx.tenantId,
      action: AUDIT_ACTION.TERMINAL_REGISTERED,
      entityType: AUDIT_ENTITY.TERMINAL,
      actorType: 'user',
      actorId: ctx.userId,
      entityId: terminal.id,
      terminalId: terminal.id,
      metadata: {
        terminalType: terminal.terminalType,
        branchId: terminal.branchId,
      },
    });
    return terminal;
  }

  @Get('terminals')
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_READ)
  list(@CurrentTenantContext() ctx: TenantContext) {
    return this.terminals.listForTenant(ctx.tenantId);
  }

  @Post('terminals/:terminalId/status')
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  setStatus(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('terminalId') terminalId: string,
    @Body() dto: SetTerminalStatusDto,
  ) {
    return this.terminals.setStatus(ctx.tenantId, terminalId, dto.status);
  }

  @Post('terminals/:terminalId/fingerprints')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  async addFingerprint(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('terminalId') terminalId: string,
    @Body() dto: AddFingerprintDto,
  ): Promise<void> {
    await this.terminals.addFingerprint(ctx.tenantId, terminalId, dto);
  }

  /** Bind the caller's current session to a terminal (POS session). */
  @Post('terminal')
  @HttpCode(HttpStatus.OK)
  bind(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: BindTerminalDto,
  ) {
    return this.terminalSessions.bind(ctx, dto.terminalId);
  }

  /** Current terminal binding on the request. */
  @Get('terminal')
  currentTerminal(@CurrentTenantContext() ctx: TenantContext): {
    terminalId: string | null;
  } {
    return { terminalId: ctx.terminalId ?? null };
  }
}
