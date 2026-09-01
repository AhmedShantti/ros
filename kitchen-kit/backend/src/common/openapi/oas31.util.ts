/**
 * OpenAPI 3.1 document finalization.
 *
 * `@nestjs/swagger@11` can natively emit an `openapi: "3.1.0"` document
 * (`DocumentBuilder.setOpenAPIVersion`), but it does not rewrite the
 * `nullable: true` keyword its own CLI plugin and `@ApiProperty({nullable})`
 * synthesize — that keyword is OpenAPI-3.0-only. OpenAPI 3.1's Schema Object
 * is JSON Schema Draft 2020-12, where nullability is expressed through
 * `type` (e.g. `["string", "null"]`) or, for a `$ref`, an `anyOf`. This file
 * performs that one structural correction on the document `SwaggerModule`
 * already built from real controller/DTO metadata — it does not hand-author
 * any schema content.
 *
 * It also fills in the one genuinely-missing piece of error-response
 * documentation: every `@Api*Response` decorator for a 400/401/403/404/409/
 * 422/429 status in this codebase was written as `{ description }` only, no
 * body schema (verified in
 * `docs/reports/claude/2026-08-23_API1A_openapi31-basepath-error-contract.md`
 * §G — every one of those statuses is produced by a plain Nest
 * `HttpException` or the single global `SalesDomainExceptionFilter`, and
 * both produce the exact same envelope: `{statusCode, message, error?}`,
 * with `message` sometimes a string and sometimes (ValidationPipe) a
 * string array, and `error` sometimes absent (a bare
 * `new UnauthorizedException()` with no message omits it) and sometimes
 * present. This reusable `ErrorResponse` component schema documents that
 * REAL, verified, slightly-irregular shape truthfully rather than
 * fabricating an RFC 7807 body the runtime does not produce.
 */

import type { OpenAPIObject } from '@nestjs/swagger';

const ERROR_STATUS_CODES = new Set([
  '400',
  '401',
  '403',
  '404',
  '409',
  '422',
  '429',
]);

export const ERROR_RESPONSE_SCHEMA_NAME = 'ErrorResponse';

const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  description:
    "Nest's default HttpException envelope, also used verbatim by the single global SalesDomainExceptionFilter (statusCode/message differ, error is the class's HTTP reason phrase or domain error name). error is sometimes absent — a bare `new UnauthorizedException()` with no message omits it.",
  required: ['statusCode', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    message: {
      description:
        'A single message, or one entry per failed validation constraint (ValidationPipe).',
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    error: {
      type: 'string',
      description:
        'HTTP reason phrase or domain error class name. Not always present.',
    },
  },
};

/**
 * Path parameters `@nestjs/swagger`'s CLI plugin infers directly from the
 * `@Param()`-bound TypeScript parameter type — always the bare `string` (or,
 * for a `ParseIntPipe`-backed param, `number`) Express hands the framework,
 * which carries no notion of the identifier's real wire shape. Response
 * bodies for the exact same identifiers already carry an accurate `format`
 * via `uuidSchema()`/`businessDaySchema()`
 * (`src/common/openapi/schema-helpers.ts`); this closes the same gap for
 * path parameters.
 *
 * The name lists below are the exhaustive, manually-verified set of every
 * path parameter name that actually occurs in the current route surface
 * (see the API schema audit report) — not a blind `endsWith('Id')`
 * heuristic. Every name in `UUID_PATH_PARAM_NAMES` is a ULID-as-UUID
 * identifier, the same convention `uuidSchema()` already documents for
 * response bodies (a ULID-as-UUID carries no RFC-4122 version nibble,
 * which is exactly why request-body DTOs validate it with `@Matches` rather
 * than `@IsUUID()` — see e.g. `kitchen.dto.ts` — but the OpenAPI `format`
 * keyword is a non-enforced annotation, and applying it here only makes
 * path parameters consistent with the identical convention already shipped
 * for response bodies, not a new judgement call).
 */
const UUID_PATH_PARAM_NAMES = new Set([
  'branchId',
  'brandId',
  'categoryId',
  'centralKitchenId',
  'groupId',
  'id',
  'itemId',
  'lineId',
  'membershipId',
  'menuId',
  'modifierId',
  'priceListId',
  'recipeId',
  'roleId',
  'ruleId',
  'sessionId',
  'stationId',
  'tableId',
  'terminalId',
  'ticketId',
  'variantId',
  'warehouseId',
]);

const UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{type: 'string', nullable: true}` -> `{type: ['string', 'null']}`, structurally, recursively. */
function nullableToJsonSchema2020(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(nullableToJsonSchema2020);
  if (!isRecord(node)) return node;

  const isNullable = node.nullable === true;
  const isRef = typeof node.$ref === 'string';

  if (isNullable && isRef) {
    const { nullable: _nullable, $ref, ...rest } = node;
    void _nullable;
    const transformedRest = nullableToJsonSchema2020(rest);
    return {
      anyOf: [{ $ref }, { type: 'null' }],
      ...(isRecord(transformedRest) ? transformedRest : {}),
    };
  }

  const out: JsonRecord = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'nullable') continue;
    out[k] = nullableToJsonSchema2020(v);
  }

  if (isNullable) {
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null'];
    } else if (Array.isArray(out.type)) {
      const existingTypes = out.type as unknown[];
      if (!existingTypes.includes('null'))
        out.type = [...existingTypes, 'null'];
    } else {
      out.type = 'null';
    }
    if (Array.isArray(out.enum)) {
      const existingEnum = out.enum as unknown[];
      if (!existingEnum.includes(null)) out.enum = [...existingEnum, null];
    }
  }
  return out;
}

/**
 * Fill every documented 400/401/403/404/409/422/429 response that has no
 * body content with a `$ref` to the shared `ErrorResponse` component — see
 * the file doc comment for why this is truthful, not fabricated, for every
 * response it touches (verified per-status-code in the API-1A report).
 * Responses that already carry `content` (i.e. an explicit, route-specific
 * schema someone deliberately wrote) are left untouched.
 */
function fillErrorResponseSchemas(document: JsonRecord): void {
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  schemas[ERROR_RESPONSE_SCHEMA_NAME] = ERROR_RESPONSE_SCHEMA;
  components.schemas = schemas;
  document.components = components;

  const paths = isRecord(document.paths) ? document.paths : {};
  for (const ops of Object.values(paths)) {
    if (!isRecord(ops)) continue;
    for (const op of Object.values(ops)) {
      if (!isRecord(op) || !isRecord(op.responses)) continue;
      for (const [status, response] of Object.entries(op.responses)) {
        if (!ERROR_STATUS_CODES.has(status) || !isRecord(response)) continue;
        if (response.content) continue;
        response.content = {
          'application/json': {
            schema: {
              $ref: `#/components/schemas/${ERROR_RESPONSE_SCHEMA_NAME}`,
            },
          },
        };
      }
    }
  }
}

/**
 * `businessDay` path parameters already carry the correct `^\d{4}-\d{2}-\d{2}$`
 * `pattern` (from each route's own path-params DTO, e.g.
 * `DayCloseParamsDto`) — only the `format: date` annotation is missing.
 * `version` (Production recipe version, `ParseIntPipe`-backed) is inferred
 * by the CLI plugin as the looser `number`; `integer` is the accurate
 * primitive for a value Express/Nest never hands back with a fractional
 * part.
 */
function enrichPathParameterSchemas(document: JsonRecord): void {
  const paths = isRecord(document.paths) ? document.paths : {};
  for (const ops of Object.values(paths)) {
    if (!isRecord(ops)) continue;
    for (const op of Object.values(ops)) {
      if (!isRecord(op) || !Array.isArray(op.parameters)) continue;
      for (const param of op.parameters) {
        if (!isRecord(param) || param.in !== 'path') continue;
        const name = param.name;
        const schema = isRecord(param.schema) ? param.schema : undefined;
        if (!schema || schema.format) continue;

        if (typeof name === 'string' && UUID_PATH_PARAM_NAMES.has(name)) {
          if (schema.type === 'string') {
            schema.format = 'uuid';
            schema.example = UUID_EXAMPLE;
          }
        } else if (name === 'businessDay' && schema.type === 'string') {
          schema.format = 'date';
        } else if (name === 'version' && schema.type === 'number') {
          schema.type = 'integer';
        }
      }
    }
  }
}

/**
 * Apply all OpenAPI-3.1 corrections to a document already built by
 * `SwaggerModule.createDocument`. Call this on both the live `/docs` UI
 * document (`main.ts`) and the standalone generator so the two never
 * disagree.
 */
export function finalizeOpenApiDocument(
  document: OpenAPIObject,
): OpenAPIObject {
  const record = document as unknown as JsonRecord;
  fillErrorResponseSchemas(record);
  enrichPathParameterSchemas(record);
  return nullableToJsonSchema2020(record) as OpenAPIObject;
}
