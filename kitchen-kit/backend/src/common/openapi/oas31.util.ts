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
 * Apply both OpenAPI-3.1 corrections to a document already built by
 * `SwaggerModule.createDocument`. Call this on both the live `/docs` UI
 * document (`main.ts`) and the standalone generator so the two never
 * disagree.
 */
export function finalizeOpenApiDocument(
  document: OpenAPIObject,
): OpenAPIObject {
  const record = document as unknown as JsonRecord;
  fillErrorResponseSchemas(record);
  return nullableToJsonSchema2020(record) as OpenAPIObject;
}
