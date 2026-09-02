import {
  SchemaObject,
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { SYNC_OPERATION_STATUS } from './protocol/protocol.constants';

/**
 * OpenAPI response schema for `POST /v1/sync/batch`.
 *
 * Declared explicitly because the result types are plain interfaces, erased at
 * compile time, so the `@nestjs/swagger` CLI plugin cannot infer them — the same
 * reason `common/openapi/schema-helpers.ts` exists. `test/openapi.e2e-spec.ts`
 * requires every documented 2xx response to carry a concrete schema, which is
 * the right rule: an untyped body is a contract the client team cannot build
 * against.
 */
const OPERATION_STATUSES = Object.values(SYNC_OPERATION_STATUS);

const operationResultSchema: SchemaObject = {
  type: 'object',
  required: ['opId', 'status', 'definitive'],
  properties: {
    opId: uuidSchema(
      'The client-generated operation id, echoed back UNCHANGED — FR-OFF-015: ' +
        'the server never reassigns an identifier.',
    ),
    status: {
      type: 'string',
      enum: OPERATION_STATUSES,
      description:
        'accepted | duplicate | conflict | rejected are DEFINITIVE — the ' +
        'client may remove the operation from its outbox. deferred is NOT ' +
        'definitive: the causal parent has not been applied, so retain the ' +
        'operation and resend it once the parent is accepted (FR-OFF-022 / ' +
        'FR-OFF-024).',
      example: 'accepted',
    },
    definitive: {
      type: 'boolean',
      description:
        'True exactly when the client may delete this operation from its ' +
        'outbox. Restated as a field so a client never has to hard-code the ' +
        'status vocabulary to decide.',
      example: true,
    },
    reasonCode: nullable({
      type: 'string',
      description:
        'Machine-readable reason. Always present on rejected, conflict and ' +
        'deferred, so a client can decide between dead-lettering, fixing and ' +
        'resending, or waiting for a causal parent.',
      example: 'causal_parent_missing',
    }),
    reasonDetail: nullable({
      type: 'string',
      description: 'Human-readable explanation.',
    }),
    conflictId: nullable(
      uuidSchema(
        'The sync.conflict_records row raised for this operation, when status is conflict.',
      ),
    ),
    detail: nullable({
      type: 'object',
      description: 'Handler-supplied result detail, echoed to the client.',
    }),
  },
};

const countsSchema: SchemaObject = {
  type: 'object',
  required: OPERATION_STATUSES,
  properties: Object.fromEntries(
    OPERATION_STATUSES.map((s) => [s, { type: 'integer', example: 0 }]),
  ),
  description: 'Per-status totals for this batch.',
};

export const syncBatchResultSchema: SchemaObject = {
  type: 'object',
  required: [
    'batchId',
    'receivedAt',
    'protocolVersion',
    'replayed',
    'counts',
    'clockSkewMs',
    'clockSkewExceededThreshold',
    'results',
  ],
  properties: {
    batchId: uuidSchema('The batch id the client supplied, echoed unchanged.'),
    receivedAt: isoDateTimeSchema("The server's own receipt instant."),
    protocolVersion: { type: 'integer', example: 1 },
    replayed: {
      type: 'boolean',
      description:
        'True when this batch had already been completed and the stored ' +
        'response was replayed verbatim. Nothing was re-applied (FR-OFF-025).',
      example: false,
    },
    counts: countsSchema,
    clockSkewMs: {
      type: 'integer',
      description:
        'Largest observed |device HLC physical clock − server receipt|, signed: ' +
        'positive means the device runs AHEAD. Reported, never silently ' +
        'corrected (FR-OFF-042).',
      example: 1200,
    },
    clockSkewExceededThreshold: {
      type: 'boolean',
      description:
        'True when the skew exceeded the configured threshold (default 5 ' +
        'minutes). The skew is recorded and an alert raised; the operations ' +
        'are still accepted and their original timestamps preserved.',
      example: false,
    },
    results: {
      type: 'array',
      description: 'One result per submitted operation, in submission order.',
      items: operationResultSchema,
    },
  },
};
