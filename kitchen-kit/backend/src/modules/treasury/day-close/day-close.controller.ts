import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import { CurrentPrincipal } from '../../identity/auth/decorators/current-principal.decorator';
import { AllowPosSession } from '../../identity/auth/decorators/pos-session.decorator';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../../identity/auth/auth.types';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import {
  CurrentAuthorization,
  CurrentTenantContext,
} from '../../identity/context/current-tenant-context.decorator';
import type {
  RequestAuthorization,
  TenantContext,
} from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { DayCloseParamsDto, PostDayCloseDto } from './day-close.dto';
import { DayCloseService } from './day-close.service';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';

/**
 * DayClose — Migration 35 (Internal-MVP `FR-FIN-020/021/023/024`).
 *
 *   POST /branches/{branchId}/day-closes/{businessDay}   cash.day.close
 *   GET  /branches/{branchId}/day-closes/{businessDay}   report.view.financial (DC-R3)
 *
 * `POST` allows BOTH a POS/PIN session (`@AllowPosSession` — a cash-
 * accountability ceremony performed where the drawers are) AND a dashboard
 * session (the decorator only widens; it never restricts). `GET` is
 * dashboard-only — no `@AllowPosSession` at method level, so
 * `JwtAuthGuard`'s existing PIN-session refusal applies by default (a
 * historical financial read is not a POS action).
 *
 * `report.view.financial` is used here WITHOUT importing
 * `reporting/reporting.permissions` — the code is declared as a plain
 * string literal on `TREASURY_PERMISSIONS` (see that file's docblock),
 * exactly mirroring `SETTINGS_BRANCH_MANAGE`'s own precedent, so this file
 * introduces no new `treasury->reporting` module edge.
 */
@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('branches')
export class DayCloseController {
  constructor(private readonly dayClose: DayCloseService) {}

  @Post(':branchId/day-closes/:businessDay')
  @HttpCode(HttpStatus.OK)
  @AllowPosSession()
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.CASH_DAY_CLOSE)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiOperation({
    summary:
      'Close a business day, or — on the branch’s first ever DayClose ' +
      'request — activate the branch’s DayClose epoch.',
    description:
      'The FIRST request for a branch ACTIVATES it: commits a durable, ' +
      'audited, idempotent `outcome: "ACTIVATED"` and never throws. A ' +
      'later request, once `activationBusinessDay < businessDay < ' +
      'currentBusinessDay`, performs a real close and returns ' +
      '`outcome: "CLOSED"` with the full Z snapshot. Internal-MVP: ' +
      'FR-FIN-022/026 remain PARTIAL — see the response’s own `scope` block.',
  })
  @ApiOkResponse({
    description:
      'ACTIVATED (no day sealed) or CLOSED (with the Z snapshot). Never 409 for a successful activation.',
  })
  @ApiBadRequestResponse({
    description: 'Future business days are not supported.',
  })
  @ApiNotFoundResponse({ description: 'Branch unknown or in another tenant.' })
  @ApiConflictResponse({
    description:
      'The current business day cannot yet be closed; the target day is ' +
      'outside the DayClose activation epoch; the day is already closed; ' +
      'open orders or open/closing cash sessions block the close; or a ' +
      'transient Z-number allocation collision could not be resolved after ' +
      'several attempts.',
  })
  async post(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() _dto: PostDayCloseDto,
    @Param() params: DayCloseParamsDto,
  ) {
    return this.dayClose.post(
      authorization.context.tenantId,
      authorization.context.userId,
      { employeeId: principal.employeeId, terminalId: principal.terminalId },
      authorization.permissions,
      {
        branchId: params.branchId,
        businessDay: parseBusinessDay(params.businessDay),
      },
    );
  }

  @Get(':branchId/day-closes/:businessDay')
  @RequirePermission(TREASURY_PERMISSIONS.REPORT_VIEW_FINANCIAL)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Retrieve a historical DayClose / Z (persisted records only).',
    description:
      'Returns the persisted immutable snapshot, byte-stable forever — ' +
      'never recomputed, never manufactured for a pre-activation date. ' +
      'Requires `report.view.financial` (DC-R3); NOT `cash.day.close` ' +
      '(a write authority) and NOT `report.view.sales`.',
  })
  @ApiOkResponse({ description: 'The persisted Z snapshot.' })
  @ApiNotFoundResponse({
    description:
      'Branch unknown/foreign, or no DayClose exists for that business day.',
  })
  async get(
    @CurrentTenantContext() context: TenantContext,
    @Param() params: DayCloseParamsDto,
  ) {
    return this.dayClose.getHistorical(
      context.tenantId,
      params.branchId,
      parseBusinessDay(params.businessDay),
    );
  }
}

/** Mirrors `reporting.controller.ts`'s own private `parseBusinessDay` — a
 *  calendar-date STRING shape check only, never a business-day derivation. */
function parseBusinessDay(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  return date;
}
