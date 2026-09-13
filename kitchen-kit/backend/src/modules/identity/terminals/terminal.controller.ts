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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
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
import {
  AuthorizationTarget,
  branchFromBody,
  fromParam,
  IDENTITY_TERMINAL_TARGET_RESOLVER,
  resourceTarget,
  tenantTarget,
} from '../contract';

// Shape verified against `toTerminalSummary` in `terminal.view.ts` — device
// fingerprint material is never included.
const terminalSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    name: { type: 'string' },
    terminalType: { type: 'string', enum: ['pos', 'kds', 'kiosk', 'handheld'] },
    status: { type: 'string', enum: ['active', 'disabled', 'revoked'] },
    lastSeenAt: nullable(isoDateTimeSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

// JwtAuthGuard (401) → TenantContextGuard (403) → PermissionGuard (403).
//
// ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13) ────────────────────
// Register/list/set-status/fingerprint remain plain TERMINAL ADMINISTRATION
// (classification C, "legacy terminal-management/admin surface" in the P0
// report's impact inventory) — no longer read by any POS/KDS/Sales/
// Treasury/Governance runtime path.
//
// `bind`/`currentTerminal` (`POST`/`GET /auth/terminal`) are RETAINED, but
// their purpose narrows to exactly ONE remaining consumer: the Sync/offline
// device channel's own session-binding mechanism (`SyncTerminalGuard`,
// `sync/auth/sync-terminal.guard.ts`) — a genuinely independent subsystem
// this task does not redesign (P0 report §4/§17). POS and KDS mint their
// OWN branch-scoped session directly at PIN login
// (`AuthService.loginWithPin`) and never call `bind`; the resulting `trm`
// claim is never read by any POS/KDS runtime path (see
// `AuthenticatedPrincipal.terminalId`'s docblock).
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
  @AuthorizationTarget(branchFromBody('branchId'))
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  @ApiOperation({ summary: 'Register a terminal.' })
  @ApiCreatedResponse({
    description: 'The newly registered terminal.',
    schema: terminalSchema,
  })
  @ApiConflictResponse({
    description: 'A terminal with this name already exists in the branch.',
  })
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
  @AuthorizationTarget(
    tenantTarget(
      'Lists every terminal registered to the tenant; the route takes no branch filter.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_READ)
  @ApiOperation({ summary: 'List terminals registered to the tenant.' })
  @ApiOkResponse({
    description: 'Terminals, oldest first.',
    schema: { type: 'array', items: terminalSchema },
  })
  list(@CurrentTenantContext() ctx: TenantContext) {
    return this.terminals.listForTenant(ctx.tenantId);
  }

  @Post('terminals/:terminalId/status')
  @AuthorizationTarget(
    resourceTarget(
      IDENTITY_TERMINAL_TARGET_RESOLVER,
      { terminalId: fromParam('terminalId') },
      'identity.terminals.branch_id is NOT NULL; a terminal always belongs to one branch.',
      'Terminal not found.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  @ApiOperation({ summary: "Set a terminal's status." })
  @ApiOkResponse({
    description: 'The updated terminal.',
    schema: terminalSchema,
  })
  @ApiNotFoundResponse({
    description:
      'Terminal not found (cross-tenant terminals are invisible under RLS).',
  })
  setStatus(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('terminalId') terminalId: string,
    @Body() dto: SetTerminalStatusDto,
  ) {
    return this.terminals.setStatus(ctx.tenantId, terminalId, dto.status);
  }

  @Post('terminals/:terminalId/fingerprints')
  @AuthorizationTarget(
    resourceTarget(
      IDENTITY_TERMINAL_TARGET_RESOLVER,
      { terminalId: fromParam('terminalId') },
      'identity.terminals.branch_id is NOT NULL; a terminal always belongs to one branch.',
      'Terminal not found.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  @ApiOperation({
    summary:
      'Register a device fingerprint on a terminal (idempotent: same fingerprint on the same terminal is a no-op).',
  })
  @ApiNoContentResponse({
    description: 'Fingerprint registered (or already present).',
  })
  @ApiNotFoundResponse({ description: 'Terminal not found.' })
  async addFingerprint(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('terminalId') terminalId: string,
    @Body() dto: AddFingerprintDto,
  ): Promise<void> {
    await this.terminals.addFingerprint(ctx.tenantId, terminalId, dto);
  }

  /**
   * Bind the caller's current session to a terminal — the Sync/offline
   * device channel's own session-binding mechanism ONLY (see this
   * controller's own docblock). POS/KDS never call this.
   */
  @Post('terminal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bind the caller's current session to a terminal." })
  @ApiOkResponse({
    description: 'The session is now bound; a terminal-scoped access token.',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        tokenType: { type: 'string', enum: ['Bearer'] },
        expiresIn: {
          type: 'integer',
          description: 'Access token lifetime in seconds.',
        },
        terminal: terminalSchema,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Terminal not found.' })
  @ApiForbiddenResponse({ description: 'Terminal is not active.' })
  bind(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: BindTerminalDto,
  ) {
    return this.terminalSessions.bind(ctx, dto.terminalId);
  }

  /** Current terminal binding on the request (Sync/offline device channel). */
  @Get('terminal')
  @ApiOperation({ summary: 'Current terminal binding on the request.' })
  @ApiOkResponse({
    description: 'Current terminal binding. Null before a terminal is bound.',
    schema: {
      type: 'object',
      properties: { terminalId: nullable(uuidSchema()) },
    },
  })
  currentTerminal(@CurrentTenantContext() ctx: TenantContext): {
    terminalId: string | null;
  } {
    return { terminalId: ctx.terminalId ?? null };
  }
}
