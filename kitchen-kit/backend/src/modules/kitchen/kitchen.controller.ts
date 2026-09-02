import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import {
  AllowPosSession,
  CurrentPrincipal,
  JwtAuthGuard,
  RequirePermission,
  PermissionGuard,
  CurrentTenantContext,
  TenantContextGuard,
} from '../identity/contract';
import type {
  AuthenticatedPrincipal,
  TenantContext,
} from '../identity/contract';
import { CurrentKdsStation } from './auth/current-kds-station.decorator';
import { KdsStationGuard } from './auth/kds-station.guard';
import type { KdsStation } from './auth/kds-station.guard';
import { AcknowledgeViewedDto, StationQueueQueryDto } from './kitchen.dto';
import { KDS_PERMISSIONS } from './kitchen.permissions';
import { KdsOperationsService } from './tickets/kds-operations.service';
import { TicketReaderService } from './tickets/ticket-reader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KDS_BRANCH_CONFIG_QUERY } from '../organisation/contract';
import type { KdsBranchConfigQuery } from '../organisation/contract';
import {
  AuthorizationTarget,
  fromParam,
  resourceTarget,
} from '../identity/contract';
import { ORG_STATION_TARGET_RESOLVER } from '../organisation/contract';
import { KDS_TICKET_TARGET_RESOLVER } from './contract';

/**
 * KDS operator lifecycle — Kitchen's FIRST controller (KDS-R11/KDS-R12,
 * ratified 2026-08-30). Route surface, exactly the design gate §21 table:
 *
 *   GET  /kds/stations/{stationId}/queue                 station queue (read-only)
 *   POST /kds/stations/{stationId}/tickets/view           first-viewed acknowledgement
 *   POST /kds/tickets/{ticketId}/lines/{lineId}/start      optional item start
 *   POST /kds/tickets/{ticketId}/lines/{lineId}/bump       bump item
 *   POST /kds/tickets/{ticketId}/bump-all                  bump all
 *   POST /kds/tickets/{ticketId}/recall                    recall
 *
 * Deliberately ABSENT: `/serve` (FR-KDS-013 `[S]`, deferred), any cancellation
 * route (cancellation arrives by event, never by a KDS command), any
 * analytics route, any per-station sort-configuration route.
 *
 * Response shapes below are verified against `ticket-reader.types.ts`
 * (`TicketCardDto`/`TicketCardLineDto`/`TicketCardModifierDto`/
 * `StationQueueDto`) and `kds-operations.service.ts`'s own per-method return
 * types — not against the Prisma schema or the SRS.
 *
 * Guard chain: `JwtAuthGuard` (401) -> `TenantContextGuard` (403) ->
 * `PermissionGuard` (`kds.operate`, 403) -> `KdsStationGuard` (terminal +
 * exactly-one-station, 403 — acceptance correction §3.3/§4). `@AllowPosSession`
 * opts every route in for PIN-issued sessions, exactly as Sales/Treasury do.
 */
const ticketCardModifierSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    nameSnapshot: {
      type: 'object',
      description: 'Opaque localized-name object, as stored at Fire time.',
    },
    kind: { type: 'string', enum: ['addition', 'removal', 'substitution'] },
    quantity: { type: 'integer' },
  },
};

const ticketCardLineSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    orderLineId: uuidSchema(),
    itemNameSnapshot: {
      type: 'object',
      description: 'Opaque localized-name object, as stored at Fire time.',
    },
    quantity: {
      type: 'string',
      pattern: '^-?\\d+(\\.\\d+)?$',
      description: 'DECIMAL(12,3) rendered as a string, never a JS number.',
      example: '2',
    },
    course: nullable({ type: 'integer' }),
    sequence: { type: 'integer' },
    preparationNotes: nullable({ type: 'string' }),
    status: { type: 'string' },
    firstViewedAt: nullable(isoDateTimeSchema()),
    startedAt: nullable(isoDateTimeSchema()),
    readyAt: nullable(isoDateTimeSchema()),
    bumpedAt: nullable(isoDateTimeSchema()),
    recalledAt: nullable(isoDateTimeSchema()),
    cancelledAt: nullable(isoDateTimeSchema()),
    modifiers: { type: 'array', items: ticketCardModifierSchema },
  },
};

const ticketCardSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    stationId: uuidSchema(),
    orderId: uuidSchema(),
    businessDay: {
      type: 'string',
      format: 'date',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Business-day partition key (YYYY-MM-DD), not a timestamp.',
      example: '2026-08-23',
    },
    orderNumber: { type: 'string' },
    orderType: { type: 'string' },
    serviceReference: nullable({ type: 'string' }),
    routedAt: isoDateTimeSchema(),
    elapsedSeconds: {
      type: 'integer',
      description: 'Server-computed at response time — never a client value.',
    },
    targetReadyAt: nullable(isoDateTimeSchema()),
    status: { type: 'string' },
    firstViewedAt: nullable(isoDateTimeSchema()),
    startedAt: nullable(isoDateTimeSchema()),
    readyAt: nullable(isoDateTimeSchema()),
    bumpedAt: nullable(isoDateTimeSchema()),
    recalledAt: nullable(isoDateTimeSchema()),
    recallCount: { type: 'integer' },
    lines: { type: 'array', items: ticketCardLineSchema },
  },
};

const stationQueueSchema = {
  type: 'object',
  properties: {
    tickets: { type: 'array', items: ticketCardSchema },
    recallWindowSeconds: { type: 'integer' },
    cancelledLineVisibilitySeconds: nullable({ type: 'integer' }),
  },
};

const acknowledgeViewedResultSchema = {
  type: 'object',
  properties: {
    acknowledged: {
      type: 'integer',
      description: 'Count of newly-acknowledged tickets on this station.',
    },
  },
};

const ticketAndLineResultSchema = {
  type: 'object',
  properties: {
    ticket: ticketCardSchema,
    line: ticketCardLineSchema,
  },
};

const bumpAllResultSchema = {
  type: 'object',
  properties: {
    ticket: ticketCardSchema,
    bumpedLineIds: { type: 'array', items: uuidSchema() },
  },
};

const recallResultSchema = {
  type: 'object',
  properties: {
    ticket: ticketCardSchema,
  },
};

@ApiTags('kitchen')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard, KdsStationGuard)
@RequirePermission(KDS_PERMISSIONS.OPERATE)
@AllowPosSession()
@Controller('kds')
export class KitchenController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: TicketReaderService,
    private readonly operations: KdsOperationsService,
    @Inject(KDS_BRANCH_CONFIG_QUERY)
    private readonly kdsBranchConfig: KdsBranchConfigQuery,
  ) {}

  /**
   * Station queue — design gate §10. Read-only: MUST NOT mutate
   * `first_viewed_at`. FIFO only; any other `sort` value is a 400 (the
   * global `ValidationPipe`'s `@IsIn(['fifo'])` on `StationQueueQueryDto`
   * rejects it before this handler runs).
   */
  @Get('stations/:stationId/queue')
  @AuthorizationTarget(
    resourceTarget(
      ORG_STATION_TARGET_RESOLVER,
      { stationId: fromParam('stationId') },
      'The station row carries the branch; KdsStationGuard separately proves the terminal is bound to exactly this station.',
      'Station not found.',
    ),
  )
  @ApiOperation({ summary: 'Read a KDS station queue (FIFO, read-only).' })
  @ApiOkResponse({
    description: 'The station queue and branch KDS config facts.',
    schema: stationQueueSchema,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description:
      'No kds.operate, non-KDS/inactive terminal, no or ambiguous station binding, or wrong station.',
  })
  async getStationQueue(
    @Param('stationId') stationId: string,
    @Query() _query: StationQueueQueryDto,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    this.assertStation(stationId, kdsStation);
    return this.prisma.withAuthContext(
      { tenantId: context.tenantId },
      async (tx) => {
        const [tickets, branchConfig] = await Promise.all([
          this.reader.listStationQueue(tx, {
            tenantId: context.tenantId,
            branchId: kdsStation.branchId,
            stationId,
            sort: 'fifo',
          }),
          this.kdsBranchConfig.find(tx, {
            tenantId: context.tenantId,
            branchId: kdsStation.branchId,
          }),
        ]);
        return {
          tickets,
          recallWindowSeconds: branchConfig.recallWindowSeconds,
          cancelledLineVisibilitySeconds:
            branchConfig.cancelledLineVisibilitySeconds,
        };
      },
    );
  }

  /** First-viewed acknowledgement — design gate §9. */
  @Post('stations/:stationId/tickets/view')
  @AuthorizationTarget(
    resourceTarget(
      ORG_STATION_TARGET_RESOLVER,
      { stationId: fromParam('stationId') },
      'The station row carries the branch; KdsStationGuard separately proves the terminal is bound to exactly this station.',
      'Station not found.',
    ),
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge tickets as first-viewed on this station.',
  })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description:
      'Accepted but not required — the acknowledgement is naturally database-idempotent (write-once).',
  })
  @ApiOkResponse({
    description: 'Count of newly-acknowledged tickets.',
    schema: acknowledgeViewedResultSchema,
  })
  @ApiForbiddenResponse({
    description: 'Wrong station, or no employee identity.',
  })
  async acknowledgeViewed(
    @Param('stationId') stationId: string,
    @Body() dto: AcknowledgeViewedDto,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    this.assertStation(stationId, kdsStation);
    const employeeId = this.requireEmployee(principal);
    return this.operations.acknowledgeViewed({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      employeeId,
      stationId,
      ticketIds: dto.ticketIds,
    });
  }

  /** Optional item start — design gate §10. */
  @Post('tickets/:ticketId/lines/:lineId/start')
  @AuthorizationTarget(
    resourceTarget(
      KDS_TICKET_TARGET_RESOLVER,
      { ticketId: fromParam('ticketId') },
      "kitchen.tickets.branch_id, proven to be the order's branch by a partition-safe composite FK.",
      'Ticket not found.',
    ),
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a ticket line started.' })
  @ApiOkResponse({
    description: 'The updated ticket and line.',
    schema: ticketAndLineResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Ticket or line not found.' })
  @ApiForbiddenResponse({
    description: 'Wrong station, or no employee identity.',
  })
  @ApiUnprocessableEntityResponse({ description: 'The line is cancelled.' })
  async startLine(
    @Param('ticketId') ticketId: string,
    @Param('lineId') lineId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    const employeeId = this.requireEmployee(principal);
    return this.operations.startLine({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      employeeId,
      stationId: kdsStation.stationId,
      ticketId,
      lineId,
    });
  }

  /** Bump item — design gate §11. */
  @Post('tickets/:ticketId/lines/:lineId/bump')
  @AuthorizationTarget(
    resourceTarget(
      KDS_TICKET_TARGET_RESOLVER,
      { ticketId: fromParam('ticketId') },
      "kitchen.tickets.branch_id, proven to be the order's branch by a partition-safe composite FK.",
      'Ticket not found.',
    ),
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a ticket line ready (bump item).' })
  @ApiOkResponse({
    description: 'The updated ticket and line.',
    schema: ticketAndLineResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Ticket or line not found.' })
  @ApiForbiddenResponse({
    description: 'Wrong station, or no employee identity.',
  })
  @ApiUnprocessableEntityResponse({ description: 'The line is cancelled.' })
  @ApiConflictResponse({
    description: 'Serialization retries exhausted — reload and retry.',
  })
  async bumpLine(
    @Param('ticketId') ticketId: string,
    @Param('lineId') lineId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    const employeeId = this.requireEmployee(principal);
    return this.operations.bumpLine({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      employeeId,
      stationId: kdsStation.stationId,
      ticketId,
      lineId,
    });
  }

  /** Bump all — design gate §11. */
  @Post('tickets/:ticketId/bump-all')
  @AuthorizationTarget(
    resourceTarget(
      KDS_TICKET_TARGET_RESOLVER,
      { ticketId: fromParam('ticketId') },
      "kitchen.tickets.branch_id, proven to be the order's branch by a partition-safe composite FK.",
      'Ticket not found.',
    ),
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark every eligible line on a ticket ready (bump all).',
  })
  @ApiOkResponse({
    description: 'The updated ticket and the ids of lines this action bumped.',
    schema: bumpAllResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Ticket not found.' })
  @ApiForbiddenResponse({
    description: 'Wrong station, or no employee identity.',
  })
  @ApiConflictResponse({
    description: 'Serialization retries exhausted — reload and retry.',
  })
  async bumpAll(
    @Param('ticketId') ticketId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    const employeeId = this.requireEmployee(principal);
    return this.operations.bumpAll({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      employeeId,
      stationId: kdsStation.stationId,
      ticketId,
    });
  }

  /** Recall — design gate §14, KDS-R12. Idempotency-Key REQUIRED. */
  @Post('tickets/:ticketId/recall')
  @AuthorizationTarget(
    resourceTarget(
      KDS_TICKET_TARGET_RESOLVER,
      { ticketId: fromParam('ticketId') },
      "kitchen.tickets.branch_id, proven to be the order's branch by a partition-safe composite FK.",
      'Ticket not found.',
    ),
  )
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Recall a bumped ticket back to active work.' })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'REQUIRED — recall increments recall_count and is not naturally idempotent.',
  })
  @ApiOkResponse({
    description: 'The recalled ticket.',
    schema: recallResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Ticket not found.' })
  @ApiForbiddenResponse({
    description: 'Wrong station, or no employee identity.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'The ticket is not bumped, or the recall window has expired.',
  })
  @ApiConflictResponse({
    description:
      'Idempotency-Key fingerprint mismatch, concurrent modification, or exhausted serialization retries.',
  })
  async recall(
    @Param('ticketId') ticketId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @CurrentTenantContext() context: TenantContext,
    @CurrentKdsStation() kdsStation: KdsStation,
  ) {
    const employeeId = this.requireEmployee(principal);
    return this.operations.recall({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      employeeId,
      stationId: kdsStation.stationId,
      ticketId,
    });
  }

  /**
   * A path `:stationId` not equal to the terminal-derived one is already
   * refused by `KdsStationGuard` — this is a defense-in-depth restatement
   * for the one route where a mismatch would otherwise silently read the
   * WRONG queue rather than throw (design gate §6: "Supplied stationId MUST
   * equal the single terminal-derived stationId").
   */
  private assertStation(pathStationId: string, kdsStation: KdsStation): void {
    if (pathStationId !== kdsStation.stationId) {
      throw new ForbiddenException(
        'This terminal is not the display for the requested station.',
      );
    }
  }

  /**
   * FR-KDS-041 "by employee" attribution requires a trusted employee
   * identity, never a client-supplied one — the same rule
   * `OrdersController.requirePosIdentity` already enforces for Payment.
   */
  private requireEmployee(principal: AuthenticatedPrincipal): string {
    if (!principal.employeeId) {
      throw new ForbiddenException(
        'This operation requires an employee identity on the session.',
      );
    }
    return principal.employeeId;
  }
}
