import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { ScheduledJobFindingInput } from '../contract/scheduled-job';

/**
 * Writes the durable DETECTION record a scheduled job produced.
 *
 * Called from inside a handler's `commit`, through the substrate's own `tx`, so
 * the finding and the occurrence settle commit or roll back together. A worker
 * whose lease was reclaimed mid-detection therefore leaves NO finding behind,
 * which is what keeps the finding table a truthful record of occurrences that
 * actually completed.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 * `ON CONFLICT (tenant_id, job_type, occurrence_key, finding_code) DO UPDATE`
 * against the table's unique index means attempt 2 of the same occurrence
 * REPLACES its own row rather than inserting a second one. That is the concrete
 * meaning of "retryable without duplicate domain effect" for this job class:
 * the finding is the domain effect, and the effect is keyed by the occurrence.
 * An operator's acknowledgement is deliberately NOT cleared by a re-detection
 * of the same occurrence — re-running attempt 2 of Monday's occurrence must not
 * silently un-acknowledge what somebody already signed off.
 *
 * ── THIS IS NOT A NOTIFICATION ────────────────────────────────────────────
 * Recording a finding notifies nobody. No email, SMS, push or chat channel
 * exists in this repository, and governance decision N-A ratified that none is
 * introduced in this phase. Callers get durable, attributable evidence; the
 * delivery limb of the SRS's "SHALL raise an alert" clauses remains unbuilt and
 * is not claimed anywhere.
 */
@Injectable()
export class ScheduledJobFindingWriter {
  async record(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      jobType: string;
      occurrenceKey: string;
      finding: ScheduledJobFindingInput;
    },
  ): Promise<void> {
    const { tenantId, jobType, occurrenceKey, finding } = input;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO platform.job_findings (
        id, tenant_id, job_type, occurrence_key, severity, finding_code, detail
      ) VALUES (
        ${newId()}::uuid, ${tenantId}::uuid, ${jobType}, ${occurrenceKey},
        ${finding.severity}, ${finding.findingCode},
        ${finding.detail as Prisma.InputJsonValue}::jsonb
      )
      ON CONFLICT (tenant_id, job_type, occurrence_key, finding_code) DO UPDATE
         SET severity    = EXCLUDED.severity,
             detail      = EXCLUDED.detail,
             detected_at = CURRENT_TIMESTAMP`);
  }
}
