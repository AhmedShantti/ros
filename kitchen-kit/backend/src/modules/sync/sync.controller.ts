import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AllowPosSession,
  CurrentPrincipal,
  JwtAuthGuard,
  TenantContextGuard,
} from '../identity/contract';
import type { AuthenticatedPrincipal } from '../identity/contract';
import { SyncBatchService } from './batch/sync-batch.service';
import type { SyncAuthorizedRequest } from './auth/sync-terminal.guard';
import { SyncTerminalGuard } from './auth/sync-terminal.guard';
import {
  SYNC_MAX_BATCH_BYTES,
  SYNC_MAX_OPERATIONS_PER_BATCH,
} from './protocol/protocol.constants';
import { SyncBatchDto } from './sync.dto';
import { syncBatchResultSchema } from './sync.schemas';

/**
 * Offline sync protocol — the canonical versioned Sync surface.
 *
 *   POST /v1/sync/batch    upward sync (SRS §21.5.1)
 *
 * `GET /v1/sync/changes` and `GET /v1/sync/status` are named in the canonical
 * catalogue and belong to D4-2 (downward sync / bootstrap); they are absent here
 * rather than stubbed, because a stub that returns nothing is indistinguishable
 * to a client from a server with no data.
 *
 * The `version: '1'` declaration is what puts this controller under `/v1` while
 * every pre-existing route in the application keeps its current path — see
 * `common/http/api-versioning.ts`.
 *
 * ── HTTP SEMANTICS ────────────────────────────────────────────────────────
 * A well-formed, authorised batch ALWAYS returns 200 with an independent result
 * per operation. `FR-OFF-023`: "A single failing operation SHALL NOT fail the
 * batch" — so a rejection or a conflict inside the batch is never an HTTP error.
 * 4xx is reserved for envelope-level faults: malformed body, unknown field,
 * oversized batch, wrong terminal, or a batchId reused with a different body.
 */
@ApiTags('sync')
@ApiBearerAuth()
@Controller({ path: 'sync', version: '1' })
@UseGuards(JwtAuthGuard, TenantContextGuard, SyncTerminalGuard)
@AllowPosSession()
export class SyncController {
  constructor(private readonly batches: SyncBatchService) {}

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload a batch of offline operations',
    description:
      'FR-OFF-020..025. Operations are applied in causal order, each with its ' +
      'own failure isolation, and answered individually as accepted, ' +
      'duplicate, conflict, rejected or deferred. Only the first four are ' +
      'DEFINITIVE: a client may remove an operation from its outbox on those ' +
      'and must retain it on anything else, including deferred, a missing ' +
      'result, and any transport failure. Replaying the same batchId with the ' +
      'same body returns the stored response and re-applies nothing.',
  })
  @ApiOkResponse({
    description:
      'Per-operation results. Always 200 for a well-formed authorised batch, ' +
      'whatever the individual outcomes.',
    schema: syncBatchResultSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Malformed envelope, an unknown field, an unsupported protocolVersion, ' +
      'more than the permitted number of operations, or an oversized batch.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid credentials.' })
  @ApiForbiddenResponse({
    description:
      'No terminal-bound session, the terminal is not active, or deviceId does ' +
      'not match the authenticated terminal.',
  })
  @ApiConflictResponse({
    description:
      'This batchId was already used for a different body (a client defect), ' +
      'or it is currently being processed by a live owner.',
  })
  async uploadBatch(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: SyncAuthorizedRequest,
    @Body() batch: SyncBatchDto,
  ) {
    const terminal = request.syncTerminal;
    if (!terminal) {
      // Unreachable while SyncTerminalGuard is attached; fail closed rather
      // than fall back to a body-supplied value.
      throw new BadRequestException('Terminal context was not established.');
    }
    if (batch.operations.length > SYNC_MAX_OPERATIONS_PER_BATCH) {
      throw new BadRequestException(
        `A batch carries at most ${SYNC_MAX_OPERATIONS_PER_BATCH} operations.`,
      );
    }
    const byteSize = Buffer.byteLength(JSON.stringify(batch), 'utf8');
    if (byteSize > SYNC_MAX_BATCH_BYTES) {
      // Envelope-level: the batch as a whole is refused. An oversized single
      // OPERATION inside a processable envelope is a per-operation rejection
      // instead, so one fat operation cannot cost a terminal its whole batch.
      throw new BadRequestException(
        `This batch is ${byteSize} bytes; the limit is ${SYNC_MAX_BATCH_BYTES}.`,
      );
    }

    return this.batches.process({
      // Tenant from the authenticated principal, branch from the terminal's
      // live server-side state. Neither is ever read from the body.
      tenantId: principal.tenantId as string,
      terminalId: terminal.terminalId,
      branchId: terminal.branchId,
      batch,
    });
  }
}
