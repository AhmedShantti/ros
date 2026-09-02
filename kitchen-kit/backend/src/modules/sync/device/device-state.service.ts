import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import { SYNC_CLOCK_SKEW_THRESHOLD_MS } from '../protocol/protocol.constants';

export interface ClockSkewObservation {
  /** Signed: positive means the device's clock runs AHEAD of the server. */
  readonly clockSkewMs: number;
  readonly exceededThreshold: boolean;
}

/**
 * Per-device sync state and `FR-OFF-042` clock-skew detection.
 *
 * `FR-OFF-042` [M] — "detect device clock skew exceeding a configurable
 * threshold (default 5 minutes) on every sync, SHALL record it, SHALL alert the
 * branch manager, and SHALL preserve the device's original timestamp alongside
 * the server-corrected one."
 *
 * What is implemented here, precisely:
 *   detect   — yes, on every batch, from the largest |device HLC physical −
 *              server receipt| in the batch;
 *   record   — yes, on `sync.device_state`;
 *   alert    — as a hash-chained audit entry. There is NO notification
 *              substrate in this repository (no email, no push, no in-app
 *              inbox), and the brief is explicit: "Do not invent a notification
 *              system." So the alert is raised where alerts can currently be
 *              raised, and `FR-OFF-042` stays PARTIAL until a real delivery
 *              channel exists. The D4-1A report says so rather than claiming
 *              the requirement;
 *   preserve  — yes: `sync_operations.hlc` and `.origin_device_time` hold the
 *              device's own values verbatim next to the server's `received_at`.
 *              Nothing rewrites them.
 *
 * The observed skew is RECORDED, never corrected. Bounding the server's
 * adoption of a skewed clock is `GD-D1-03`, which is DEFERRED, not ratified.
 */
@Injectable()
export class DeviceStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async recordBatch(input: {
    tenantId: string;
    terminalId: string;
    branchId: string;
    batchId: string;
    protocolVersion: number;
    lastCursor: string | null;
    devicePhysicalMs: readonly number[];
    serverNow: Date;
  }): Promise<ClockSkewObservation> {
    const serverMs = input.serverNow.getTime();
    // The largest DEVIATION in either direction, sign preserved — a device that
    // is an hour behind is as broken as one an hour ahead.
    let skew = 0;
    for (const physicalMs of input.devicePhysicalMs) {
      const candidate = physicalMs - serverMs;
      if (Math.abs(candidate) > Math.abs(skew)) skew = candidate;
    }
    const exceeded = Math.abs(skew) > SYNC_CLOCK_SKEW_THRESHOLD_MS;

    await this.prisma.withAuthContext(
      { tenantId: input.tenantId },
      async (tx) => {
        await tx.syncDeviceState.upsert({
          where: {
            tenantId_terminalId: {
              tenantId: input.tenantId,
              terminalId: input.terminalId,
            },
          },
          create: {
            tenantId: input.tenantId,
            terminalId: input.terminalId,
            lastBatchId: input.batchId,
            lastSeenAt: input.serverNow,
            lastCursor: input.lastCursor,
            protocolVersion: input.protocolVersion,
            clockSkewMs: BigInt(skew),
            skewDetectedAt: exceeded ? input.serverNow : null,
            skewAlertedAt: exceeded ? input.serverNow : null,
          },
          update: {
            lastBatchId: input.batchId,
            lastSeenAt: input.serverNow,
            lastCursor: input.lastCursor,
            protocolVersion: input.protocolVersion,
            clockSkewMs: BigInt(skew),
            ...(exceeded
              ? {
                  skewDetectedAt: input.serverNow,
                  skewAlertedAt: input.serverNow,
                }
              : {}),
          },
        });

        if (exceeded) {
          await this.audit.record(tx, {
            tenantId: input.tenantId,
            action: AUDIT_ACTION.SYNC_CLOCK_SKEW_DETECTED,
            entityType: AUDIT_ENTITY.SYNC_DEVICE_STATE,
            entityId: input.terminalId,
            actorType: 'terminal',
            terminalId: input.terminalId,
            reasonCode: 'clock_skew',
            metadata: {
              clockSkewMs: skew,
              thresholdMs: SYNC_CLOCK_SKEW_THRESHOLD_MS,
              batchId: input.batchId,
              branchId: input.branchId,
            },
          });
        }
      },
    );

    return { clockSkewMs: skew, exceededThreshold: exceeded };
  }
}
