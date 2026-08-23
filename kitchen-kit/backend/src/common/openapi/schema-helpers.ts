/**
 * Reusable OpenAPI schema fragments for wire-format conventions that recur
 * across nearly every response in this API but cannot be inferred by the
 * `@nestjs/swagger` CLI plugin, because the response DTOs are plain
 * interfaces (erased at compile time), not classes.
 *
 * Every shape here is taken from an actually-observed serializer, not from
 * the Prisma schema or the SRS: see `src/modules/sales/sales.views.ts` for
 * the canonical example (`toOrderView`/`toOrderLineView`).
 *
 * `@nestjs/swagger` does not publicly export its `SchemaObject` type (only
 * `.`, `./plugin`, and `./package.json` are in its package `exports` map),
 * so this file declares the minimal structurally-compatible shape it needs
 * rather than deep-importing an internal `dist/` path.
 */
export interface SchemaObject {
  type?: string;
  format?: string;
  pattern?: string;
  description?: string;
  example?: unknown;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
}

/** BigInt minor-unit money field, serialized via `.toString()` — a decimal string of integer minor units (e.g. cents), never a JSON number (would lose precision / risk float corruption for large totals). */
export function moneyStringSchema(description?: string): SchemaObject {
  return {
    type: 'string',
    pattern: '^-?\\d+$',
    description:
      description ??
      'Minor-unit money amount as a decimal string (never a JSON number, to avoid IEEE-754 precision loss).',
    example: '1250',
  };
}

/** Prisma `Decimal` quantity field, serialized via `.toString()` — a decimal string, may carry a fractional part. */
export function decimalStringSchema(description?: string): SchemaObject {
  return {
    type: 'string',
    pattern: '^-?\\d+(\\.\\d+)?$',
    description:
      description ??
      'Decimal quantity as a string (preserves exact precision).',
    example: '2.5',
  };
}

/** A `businessDay` partition-key field, serialized via `.toISOString().slice(0, 10)` — a plain `YYYY-MM-DD` date, never a full ISO instant. */
export function businessDaySchema(description?: string): SchemaObject {
  return {
    type: 'string',
    format: 'date',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description:
      description ??
      'Business-day partition key (YYYY-MM-DD), not a timestamp.',
    example: '2026-08-23',
  };
}

/** A `Date`/`Timestamptz` field returned as a JS `Date` from a view function, serialized implicitly by `JSON.stringify`'s `Date.prototype.toJSON()` — a full ISO-8601 instant. */
export function isoDateTimeSchema(description?: string): SchemaObject {
  return {
    type: 'string',
    format: 'date-time',
    description,
    example: '2026-08-23T14:30:00.000Z',
  };
}

/** A UUID identifier field. */
export function uuidSchema(description?: string): SchemaObject {
  return {
    type: 'string',
    format: 'uuid',
    description,
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  };
}

/** A nullable variant of any schema fragment above. */
export function nullable(schema: SchemaObject): SchemaObject {
  return { ...schema, nullable: true };
}
