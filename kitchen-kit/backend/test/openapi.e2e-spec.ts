import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { classifyPathParamName } from './../src/common/openapi/oas31.util';

/**
 * Mechanical checks that the generated OpenAPI document
 * (`docs/api/openapi.json` / `.yaml`) is a truthful, well-formed, and
 * not-drifted description of the LIVE route surface.
 *
 * These read the ALREADY-GENERATED artifacts, they do not regenerate them —
 * run `npm run openapi:generate` first (`npm run openapi:check` fails CI if
 * the checked-in artifacts are stale relative to the current code).
 *
 * Determinism (byte-identical output across two runs of the generator) is
 * verified separately as a one-time manual proof recorded in
 * `docs/reports/claude/2026-08-23_API1A_openapi31-basepath-error-contract.md`
 * §M, not re-run here on every CI pass — the generator has no
 * nondeterministic inputs (no Date.now(), no Math.random(), keys sorted
 * before serialization), so a per-run check would only ever catch a
 * regression this suite's other assertions already catch structurally.
 * `npm run openapi:check` (regenerate + `git diff --exit-code`) is the
 * standing drift check for the checked-in artifacts themselves.
 */

const JSON_PATH = join(__dirname, '..', 'docs', 'api', 'openapi.json');
const YAML_PATH = join(__dirname, '..', 'docs', 'api', 'openapi.yaml');

// Endpoints the interceptor genuinely requires `Idempotency-Key` on — see
// `src/common/idempotency/idempotent.decorator.ts` usage sites.
const IDEMPOTENT_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'post', path: '/orders' },
  { method: 'post', path: '/orders/{businessDay}/{id}/lines' },
  { method: 'post', path: '/cash-sessions' },
  // KDS-R12 — recall is not naturally idempotent (recall_count increments).
  { method: 'post', path: '/kds/tickets/{ticketId}/recall' },
];

// Endpoints that genuinely require `If-Match` — see `orders.controller.ts`'s
// own `parseIfMatch`.
const IF_MATCH_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'post', path: '/orders/{businessDay}/{id}/lines' },
  { method: 'delete', path: '/orders/{businessDay}/{id}/lines/{lineId}' },
];

// Publicly-reachable routes that legitimately carry no security requirement.
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'POST /auth/login',
  'POST /auth/pin',
  'POST /auth/refresh',
  'POST /auth/password/forgot',
  'POST /auth/password/reset',
]);

interface SchemaNode {
  type?: string | string[];
  format?: string;
  pattern?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
  required?: string[];
  [k: string]: unknown;
}

interface ResponseNode {
  description?: string;
  content?: Record<string, { schema?: SchemaNode }>;
}

type OpenApiDoc = {
  openapi: string;
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        security?: unknown[];
        parameters?: Array<{ in: string; name: string; required?: boolean }>;
        requestBody?: unknown;
        responses?: Record<string, ResponseNode>;
      }
    >
  >;
  components?: {
    schemas?: Record<string, SchemaNode>;
  };
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
}
interface ExpressAppWithRouter {
  _router?: { stack?: ExpressLayer[] };
  router?: { stack?: ExpressLayer[] };
}

function listExpressRoutes(
  app: INestApplication<App>,
): Array<{ method: string; path: string }> {
  const server = app.getHttpAdapter().getInstance() as ExpressAppWithRouter;
  const routes: Array<{ method: string; path: string }> = [];

  const walk = (stack: ExpressLayer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        const methods = Object.keys(layer.route.methods).filter(
          (m) => layer.route?.methods[m],
        );
        for (const m of methods) routes.push({ method: m, path });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(server._router?.stack ?? server.router?.stack ?? []);
  return routes;
}

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication<App>;
  let doc: OpenApiDoc;
  let rawJson: string;
  let rawYaml: string;

  beforeAll(async () => {
    if (!existsSync(JSON_PATH) || !existsSync(YAML_PATH)) {
      throw new Error(
        `${JSON_PATH} / ${YAML_PATH} do not exist. Run "npm run openapi:generate" first.`,
      );
    }
    rawJson = readFileSync(JSON_PATH, 'utf8');
    rawYaml = readFileSync(YAML_PATH, 'utf8');
    doc = JSON.parse(rawJson) as OpenApiDoc;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('JSON parses and is a well-formed OpenAPI document', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths).toBeDefined();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it('the root openapi value is exactly 3.1.x (SRS NFR-API-001)', () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it('the full document validates against the official OpenAPI 3.1 meta-schema', async () => {
    const { Validator } = await import('@seriousme/openapi-schema-validator');
    const validator = new Validator();
    const res = await validator.validate(JSON_PATH);
    expect(res.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('the validator can fully dereference every $ref (independent of the regex check below)', async () => {
    const { Validator } = await import('@seriousme/openapi-schema-validator');
    const validator = new Validator();
    await validator.validate(JSON_PATH);
    expect(() => validator.resolveRefs()).not.toThrow();
  });

  it('YAML parses to the exact same structure as the JSON', () => {
    const fromYaml = yaml.load(rawYaml);
    expect(fromYaml).toEqual(JSON.parse(rawJson));
  });

  it('every $ref resolves to a component that exists', () => {
    const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = [
      ...rawJson.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]);
    // rawJson is pretty-printed (2-space indent), so also match with a space after the colon.
    const refsSpaced = [
      ...rawJson.matchAll(/"\$ref":\s*"#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]);
    for (const name of [...refs, ...refsSpaced]) {
      expect(schemaNames.has(name)).toBe(true);
    }
  });

  it('has no duplicate operationIds', () => {
    const ids: string[] = [];
    for (const ops of Object.values(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        expect(op.operationId).toBeTruthy();
        ids.push(op.operationId as string);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate parameters per operation, case-insensitive for headers', () => {
    const dupes: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const seen = new Set<string>();
        for (const param of op.parameters ?? []) {
          const key =
            param.in === 'header'
              ? `header:${param.name.toLowerCase()}`
              : `${param.in}:${param.name}`;
          if (seen.has(key))
            dupes.push(`${method.toUpperCase()} ${p} -> ${key}`);
          seen.add(key);
        }
      }
    }
    expect(dupes).toEqual([]);
  });

  it('documents the important live controllers', () => {
    for (const p of [
      '/health',
      '/auth/login',
      '/auth/pin',
      '/orders',
      '/catalogue/items',
      '/inventory/items',
      '/org/branches',
      '/recipes',
      '/cash-sessions',
    ]) {
      expect(doc.paths[p]).toBeDefined();
    }
  });

  /**
   * P1E-6 — explicit Fire is now real and ratified ("Fire Authorization
   * Ratification — 2026-08-24"), so it is EXPECTED to be documented — but
   * only that ONE exact route. Automatic/configurable Fire (the other half
   * of FR-POS-035), Completion, and refund remain unimplemented and must
   * still be absent.
   *
   * P1F-1 — explicit partial CASH / manual-external-card Payment capture is
   * now real too, so it joins Fire as an EXPECTED, single, exact route.
   * Completion, refund, and any integrated-terminal or PaymentAttempt route
   * remain unimplemented non-goals and must still be absent — the
   * forbidden-pattern check below no longer includes `/payments?\b/`, since
   * that would now also match the real, accepted Payment route; it is
   * replaced with precise integrated-terminal/PaymentAttempt patterns
   * instead.
   *
   * KDS operator lifecycle (KDS-R11/KDS-R12, ratified 2026-08-30) makes
   * bump/bump-all/recall real and ratified too — `bump`/`recall` are
   * REMOVED from `forbidden` and asserted as the exact six-route KDS
   * surface instead. `/serve` (FR-KDS-013 `[S]`, deferred) and any
   * cancellation/analytics/sort-configuration route remain absent.
   */
  it('documents explicit Fire, Payment, Receipt, and the KDS operator lifecycle (and only those routes), and does not document Completion, refund, integrated-terminal, PaymentAttempt, serve, or cancellation endpoints', () => {
    const paths = Object.keys(doc.paths);
    const fireMatches = paths.filter((p) => /\/fire\b/i.test(p));
    expect(fireMatches).toEqual(['/orders/{businessDay}/{id}/fire']);

    const paymentMatches = paths.filter((p) => /\/payments?\b/i.test(p));
    expect(paymentMatches).toEqual(['/orders/{businessDay}/{id}/payments']);

    // RCPT-R1 — exactly ONE exact receipt route, the same "exactly one exact
    // route" discipline Fire/Payment/KDS already follow. No
    // /receipt/email, /receipt/print, /receipt/reprint or /fiscal-receipt.
    const receiptMatches = paths.filter((p) => /\/receipts?\b/i.test(p));
    expect(receiptMatches).toEqual(['/orders/{businessDay}/{id}/receipt']);

    const kdsMatches = paths.filter((p) => p.startsWith('/kds')).sort();
    expect(kdsMatches).toEqual(
      [
        '/kds/stations/{stationId}/queue',
        '/kds/stations/{stationId}/tickets/view',
        '/kds/tickets/{ticketId}/bump-all',
        '/kds/tickets/{ticketId}/lines/{lineId}/bump',
        '/kds/tickets/{ticketId}/lines/{lineId}/start',
        '/kds/tickets/{ticketId}/recall',
      ].sort(),
    );

    const forbidden = [
      /\/complete\b/i,
      /\/refunds?\b/i,
      /\/serve\b/i,
      /\/cancel/i,
      /payment[-_]?attempts?/i,
      /terminals?\/(session|authoriz|capture)/i,
      // RCPT-R1 — the receipt is a GET-only DATA/VIEW capability (design
      // gate §14/§C): no delivery channel, no reprint-marking route, no
      // fiscal variant.
      /receipts?\/(email|print|reprint)/i,
      /fiscal[-_]?receipts?/i,
    ];
    for (const p of paths) {
      for (const pattern of forbidden) {
        expect(p).not.toMatch(pattern);
      }
    }
  });

  it('does not expose a /kitchen surface — Kitchen routes live under /kds only', () => {
    for (const p of Object.keys(doc.paths)) {
      expect(p.toLowerCase().startsWith('/kitchen')).toBe(false);
    }
  });

  it('every non-public operation carries security metadata', () => {
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const key = `${method.toUpperCase()} ${p}`;
        if (PUBLIC_ROUTES.has(key)) continue;
        expect(op.security && op.security.length > 0).toBe(true);
      }
    }
  });

  it.each(IDEMPOTENT_ROUTES)(
    'documents Idempotency-Key as required on $method $path',
    ({ method, path }) => {
      const op = doc.paths[path]?.[method];
      expect(op).toBeDefined();
      const header = op?.parameters?.find(
        (p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key',
      );
      expect(header).toBeDefined();
      expect(header?.required).toBe(true);
    },
  );

  it.each(IF_MATCH_ROUTES)(
    'documents If-Match as required on $method $path',
    ({ method, path }) => {
      const op = doc.paths[path]?.[method];
      expect(op).toBeDefined();
      const header = op?.parameters?.find(
        (p) => p.in === 'header' && p.name.toLowerCase() === 'if-match',
      );
      expect(header).toBeDefined();
      expect(header?.required).toBe(true);
    },
  );

  it('CreateOrderDto keeps its real required fields', () => {
    const schema = doc.components?.schemas?.['CreateOrderDto'];
    expect(schema).toBeDefined();
    for (const field of ['orderType', 'channel', 'originDeviceTime']) {
      expect(schema?.required).toContain(field);
    }
  });

  it('PinLoginDto keeps its real required fields', () => {
    const schema = doc.components?.schemas?.['PinLoginDto'];
    expect(schema).toBeDefined();
    for (const field of ['tenantId', 'terminalId', 'employeeCode', 'pin']) {
      expect(schema?.required).toContain(field);
    }
  });

  function responseSchema(
    path: string,
    method: string,
    status: string,
  ): SchemaNode | undefined {
    return doc.paths[path]?.[method]?.responses?.[status]?.content?.[
      'application/json'
    ]?.schema;
  }

  it('money-string schema (BigInt minor units) remains a decimal-string pattern, not a number', () => {
    const schema = responseSchema('/orders', 'post', '201');
    const grandTotal = schema?.properties?.grandTotal;
    expect(grandTotal).toBeDefined();
    expect(grandTotal?.type).toBe('string');
    expect(grandTotal?.pattern).toBe('^-?\\d+$');
  });

  it('Decimal-string schema (Prisma Decimal) remains a decimal-string pattern, not a number', () => {
    const schema = responseSchema(
      '/orders/{businessDay}/{id}/lines',
      'post',
      '201',
    );
    const quantity = schema?.properties?.line?.properties?.quantity;
    expect(quantity).toBeDefined();
    expect(quantity?.type).toBe('string');
    expect(quantity?.pattern).toBe('^-?\\d+(\\.\\d+)?$');
  });

  /**
   * RCPT-R1 / Receipt design gate §Q.4 — three pre-existing Order contract
   * defects, found while designing the Receipt schema and corrected as
   * adjacent work in this same PR: `countryPackVersion` is a `VarChar(24)`
   * column (a string) but was documented `integer`; `priceRule` is a
   * nullable `VarChar(160)` (a nullable string) but was documented an
   * opaque object; `lines[].taxClassId` is `NOT NULL` (D-09) but was
   * documented nullable. Zero runtime wire change — documentation only.
   */
  it('countryPackVersion is documented as a string, not an integer (was a pre-existing defect)', () => {
    const schema = responseSchema('/orders', 'post', '201');
    const countryPackVersion = schema?.properties?.countryPackVersion;
    expect(countryPackVersion).toBeDefined();
    expect(countryPackVersion?.type).toBe('string');
  });

  it('lines[].priceRule is documented as a nullable string, not an opaque object (was a pre-existing defect)', () => {
    const schema = responseSchema(
      '/orders/{businessDay}/{id}/lines',
      'post',
      '201',
    );
    const priceRule = schema?.properties?.line?.properties?.priceRule;
    expect(priceRule).toBeDefined();
    expect(priceRule?.type).toEqual(['string', 'null']);
  });

  it('lines[].taxClassId is documented as a non-nullable uuid, not nullable (was a pre-existing defect)', () => {
    const schema = responseSchema(
      '/orders/{businessDay}/{id}/lines',
      'post',
      '201',
    );
    const taxClassId = schema?.properties?.line?.properties?.taxClassId;
    expect(taxClassId).toBeDefined();
    expect(taxClassId?.type).toBe('string');
    expect(taxClassId?.format).toBe('uuid');
  });

  it('businessDay remains a YYYY-MM-DD date string, not a full timestamp', () => {
    const schema = responseSchema('/orders', 'post', '201');
    const businessDay = schema?.properties?.businessDay;
    expect(businessDay).toBeDefined();
    expect(businessDay?.format).toBe('date');
    expect(businessDay?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
  });

  it('no schema anywhere in the document still uses the OpenAPI-3.0-only "nullable" keyword', () => {
    expect(rawJson).not.toMatch(/"nullable"\s*:/);
  });

  it('a nullable primitive field retains its runtime nullability as a JSON Schema 2020-12 type union', () => {
    const schema = responseSchema('/orders', 'post', '201');
    const tableId = schema?.properties?.tableId;
    expect(tableId?.type).toEqual(['string', 'null']);
  });

  it('a nullable enum field lists null in its enum values under the type union', () => {
    const schema = responseSchema(
      '/catalogue/modifier-groups/{groupId}/modifiers',
      'post',
      '201',
    );
    const kind = schema?.properties?.kind;
    expect(kind?.type).toEqual(['string', 'null']);
    expect(kind?.enum).toContain(null);
  });

  it('representative 400 error body is documented against the shared ErrorResponse schema', () => {
    const target = responseSchema('/orders', 'post', '400');
    expect(target).toBeDefined();
    expect(target?.$ref).toBe('#/components/schemas/ErrorResponse');
    const errorSchema = doc.components?.schemas?.['ErrorResponse'];
    expect(errorSchema?.required).toContain('statusCode');
    expect(errorSchema?.required).toContain('message');
  });

  it('representative 401 and 403 error bodies are documented against the shared ErrorResponse schema', () => {
    expect(responseSchema('/auth/me', 'get', '401')?.$ref).toBe(
      '#/components/schemas/ErrorResponse',
    );
    expect(responseSchema('/orders', 'post', '403')?.$ref).toBe(
      '#/components/schemas/ErrorResponse',
    );
  });

  it('representative 409 and 422 error bodies are documented against the shared ErrorResponse schema', () => {
    expect(
      responseSchema('/orders/{businessDay}/{id}/lines', 'post', '409')?.$ref,
    ).toBe('#/components/schemas/ErrorResponse');
    expect(
      responseSchema('/orders/{businessDay}/{id}/lines', 'post', '422')?.$ref,
    ).toBe('#/components/schemas/ErrorResponse');
  });

  it('the servers array documents the real, verified base — not a fabricated /v1', () => {
    expect(doc.servers?.length).toBeGreaterThan(0);
    expect(doc.servers?.[0].url).toBe('/');
  });

  it('no live registered route is missing from the document (drift detection)', () => {
    const live = listExpressRoutes(app);
    const missing: string[] = [];
    for (const { method, path } of live) {
      if (!HTTP_METHODS.includes(method)) continue;
      // The Nest-internal 404/OPTIONS catch-alls and asset routes aren't real API surface.
      if (path === '/*' || path === '/') continue;
      const op = doc.paths[path]?.[method];
      if (!op) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('no documented operation is missing its live route (drift detection)', () => {
    const live = new Set(
      listExpressRoutes(app).map((r) => `${r.method} ${r.path}`),
    );
    const orphaned: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        if (!live.has(`${method} ${p}`))
          orphaned.push(`${method.toUpperCase()} ${p}`);
      }
    }
    expect(orphaned).toEqual([]);
  });

  /**
   * Full API-contract schema-completeness sweep (API schema audit,
   * 2026-09-01) — derives the operation inventory FROM THE DOCUMENT itself
   * (`doc.paths`), not a hardcoded route list, so a future route added
   * without a real schema fails here automatically.
   *
   * Exactly the routes below genuinely return no body at runtime (every
   * handler's return type is `Promise<void>`, verified against source —
   * see the audit report's bodyless-allowlist table). Every other
   * documented 2xx JSON-implying response must carry a concrete
   * `application/json` schema.
   */
  const BODYLESS_ALLOWLIST = new Set([
    'POST /auth/logout 204',
    'POST /auth/memberships/{membershipId}/roles 204',
    'DELETE /auth/memberships/{membershipId}/roles/{roleId} 204',
    'POST /auth/password/change 204',
    'POST /auth/password/reset 204',
    'POST /auth/roles/{roleId}/permissions 204',
    'POST /auth/terminals/{terminalId}/fingerprints 204',
    'POST /catalogue/items/{itemId}/modifier-groups 204',
    'POST /catalogue/items/{itemId}/placements 204',
    'DELETE /catalogue/items/{itemId}/placements/{categoryId} 204',
    'POST /catalogue/menus/{menuId}/branches 204',
    'DELETE /catalogue/menus/{menuId}/branches/{branchId} 204',
  ]);

  function isEmptySchema(schema: SchemaNode | undefined): boolean {
    return !schema || Object.keys(schema).length === 0;
  }

  /**
   * Applied ONLY to a top-level operation response/request schema — never
   * recursed into nested properties. A bare `{type:'object'}` is NEVER
   * acceptable here, description or not: an earlier version of this check
   * exempted `{type:'object', description:'...'}`, mirroring the
   * repository's real, deliberate convention for genuinely opaque NESTED
   * JSON columns (localized-name/address/theme blobs — see
   * `schema-helpers.ts` consumers across catalogue/organisation/inventory/
   * kitchen) — but applied at the TOP level that exemption is a loophole: a
   * future entire response could ship as `{type:'object', description:
   * '...'}` and pass on prose alone. This check never walks into nested
   * properties (so the repository's real nested opaque-JSON fields are
   * untouched and not re-flagged — they were never subject to this rule to
   * begin with), and the current, audited API surface has ZERO genuinely
   * opaque TOP-LEVEL responses — `TOP_LEVEL_OPAQUE_ALLOWLIST` stays empty
   * unless one is deliberately added with a named, reviewed reason.
   */
  const TOP_LEVEL_OPAQUE_ALLOWLIST = new Set<string>([]);

  function isUnderspecifiedObject(schema: SchemaNode, key?: string): boolean {
    if (schema.$ref) return false;
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type !== 'object') return false;
    if (schema.properties) return false;
    if ('oneOf' in schema || 'allOf' in schema || 'anyOf' in schema)
      return false;
    if ('additionalProperties' in schema) return false;
    if (key && TOP_LEVEL_OPAQUE_ALLOWLIST.has(key)) return false;
    return true;
  }

  function isUntypedArraySchema(schema: SchemaNode): boolean {
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type !== 'array') return false;
    return isEmptySchema(schema.items);
  }

  it('every documented 2xx response is either the verified bodyless allowlist or carries a concrete JSON schema', () => {
    const violations: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        for (const [status, response] of Object.entries(op.responses ?? {})) {
          if (!status.startsWith('2')) continue;
          const key = `${method.toUpperCase()} ${p} ${status}`;
          const content = response.content;
          if (BODYLESS_ALLOWLIST.has(key)) {
            continue;
          }
          if (!content || !content['application/json']) {
            violations.push(`${key}: no application/json content`);
            continue;
          }
          const schema = content['application/json'].schema;
          if (isEmptySchema(schema)) {
            violations.push(`${key}: empty schema`);
            continue;
          }
          if (schema && isUnderspecifiedObject(schema, key)) {
            violations.push(`${key}: untyped object with no properties`);
          }
          if (schema && isUntypedArraySchema(schema)) {
            violations.push(`${key}: array with no typed items`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every allowlisted bodyless route is genuinely 204 and carries no content', () => {
    for (const key of BODYLESS_ALLOWLIST) {
      const [method, p, status] = key.split(' ');
      expect(status).toBe('204');
      const response =
        doc.paths[p]?.[method.toLowerCase()]?.responses?.[status];
      expect(response).toBeDefined();
      expect(response?.content).toBeUndefined();
    }
  });

  it('every write operation (POST/PUT/PATCH) that declares a requestBody gives it a concrete application/json schema', () => {
    const violations: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!['post', 'put', 'patch'].includes(method)) continue;
        const rb = op.requestBody as
          { content?: Record<string, { schema?: SchemaNode }> } | undefined;
        if (!rb) continue;
        const key = `${method.toUpperCase()} ${p}`;
        const aj = rb.content?.['application/json'];
        if (!aj) {
          violations.push(`${key}: requestBody has no application/json`);
          continue;
        }
        if (isEmptySchema(aj.schema)) {
          violations.push(`${key}: empty request schema`);
          continue;
        }
        if (aj.schema && isUnderspecifiedObject(aj.schema, key)) {
          violations.push(`${key}: untyped request object`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every operation carries a concrete schema for its documented 400/401/403/404/409/422 error responses', () => {
    const ERROR_STATUSES = ['400', '401', '403', '404', '409', '422'];
    const violations: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.includes(method)) continue;
        for (const status of ERROR_STATUSES) {
          const response = op.responses?.[status];
          if (!response) continue;
          const schema = response.content?.['application/json']?.schema;
          const key = `${method.toUpperCase()} ${p} ${status}`;
          if (isEmptySchema(schema)) {
            violations.push(`${key}: empty error schema`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * DayClose POST union contract (API final acceptance correction,
   * 2026-09-01) — `POST /branches/{branchId}/day-closes/{businessDay}`'s
   * 200 response is a REAL discriminated union (`DayClosePostResult` in
   * `day-close.service.ts`), not one object with optional fields. These
   * tests assert the OpenAPI schema is a genuine `oneOf` of two concrete,
   * mutually-exclusive branches, and that representative example payloads
   * validate/reject exactly as the union's structure demands.
   */
  describe('DayClose POST — discriminated union contract', () => {
    const DAY_CLOSE_POST_SCHEMA_PATH =
      '/branches/{branchId}/day-closes/{businessDay}';

    function dayCloseSchema(): SchemaNode {
      const schema = responseSchema(DAY_CLOSE_POST_SCHEMA_PATH, 'post', '200');
      if (!schema) throw new Error('DayClose POST 200 schema missing');
      return schema;
    }

    it('the 200 schema is a oneOf with exactly 2 concrete variants', () => {
      const schema = dayCloseSchema();
      expect(Array.isArray(schema.oneOf)).toBe(true);
      const variants = schema.oneOf as SchemaNode[];
      expect(variants).toHaveLength(2);
      for (const variant of variants) {
        expect(variant.type).toBe('object');
        expect(Object.keys(variant.properties ?? {}).length).toBeGreaterThan(0);
      }
    });

    function variantByOutcome(outcome: 'ACTIVATED' | 'CLOSED'): SchemaNode {
      const variants = dayCloseSchema().oneOf as SchemaNode[];
      const variant = variants.find(
        (v) => v.properties?.outcome?.const === outcome,
      );
      if (!variant) throw new Error(`no variant with outcome const ${outcome}`);
      return variant;
    }

    it('the ACTIVATED variant requires outcome + activation fields, and forbids dayClose', () => {
      const variant = variantByOutcome('ACTIVATED');
      expect(variant.required).toEqual(
        expect.arrayContaining([
          'outcome',
          'branchId',
          'businessDay',
          'activationBusinessDay',
          'firstEligibleBusinessDay',
        ]),
      );
      expect(variant.properties?.outcome?.const).toBe('ACTIVATED');
      expect(variant.properties?.dayClose).toBeUndefined();
      expect(variant.additionalProperties).toBe(false);
    });

    it('the CLOSED variant requires outcome + the closed payload (dayClose)', () => {
      const variant = variantByOutcome('CLOSED');
      expect(variant.required).toEqual(
        expect.arrayContaining([
          'outcome',
          'branchId',
          'businessDay',
          'activationBusinessDay',
          'firstEligibleBusinessDay',
          'dayClose',
        ]),
      );
      expect(variant.properties?.outcome?.const).toBe('CLOSED');
      expect(variant.properties?.dayClose).toBeDefined();
      expect(variant.additionalProperties).toBe(false);
    });

    /**
     * A tiny, purpose-built structural validator for exactly the JSON
     * Schema subset the two DayClose variants use (`type`, `const`,
     * `required`, `properties`, `additionalProperties`) — not a general
     * JSON Schema engine. Deliberately self-contained rather than pulling
     * in an undeclared transitive `ajv` (present in `node_modules` only as
     * a dependency of `@seriousme/openapi-schema-validator`, not a direct
     * project dependency) for a two-flat-object union this small.
     */
    function satisfiesFlatObjectSchema(
      value: Record<string, unknown>,
      schema: SchemaNode,
    ): boolean {
      for (const req of schema.required ?? []) {
        if (!(req in value)) return false;
      }
      const properties = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) return false;
        }
      }
      const outcomeConst = properties.outcome?.const;
      if (outcomeConst !== undefined && value.outcome !== outcomeConst) {
        return false;
      }
      return true;
    }

    function matchesUnion(value: Record<string, unknown>): boolean {
      const variants = dayCloseSchema().oneOf as SchemaNode[];
      const matches = variants.filter((v) =>
        satisfiesFlatObjectSchema(value, v),
      );
      return matches.length === 1;
    }

    it('a valid ACTIVATED payload matches exactly one union branch', () => {
      expect(
        matchesUnion({
          outcome: 'ACTIVATED',
          branchId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          businessDay: '2026-09-01',
          activationBusinessDay: '2026-09-01',
          firstEligibleBusinessDay: '2026-09-02',
        }),
      ).toBe(true);
    });

    it('a valid CLOSED payload matches exactly one union branch', () => {
      expect(
        matchesUnion({
          outcome: 'CLOSED',
          branchId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          businessDay: '2026-09-01',
          activationBusinessDay: '2026-08-30',
          firstEligibleBusinessDay: '2026-08-31',
          dayClose: { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
        }),
      ).toBe(true);
    });

    it('ACTIVATED fields plus outcome CLOSED (missing dayClose) is rejected by both branches', () => {
      expect(
        matchesUnion({
          outcome: 'CLOSED',
          branchId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          businessDay: '2026-09-01',
          activationBusinessDay: '2026-09-01',
          firstEligibleBusinessDay: '2026-09-02',
        }),
      ).toBe(false);
    });

    it('CLOSED payload (with dayClose) plus outcome ACTIVATED is rejected by both branches', () => {
      expect(
        matchesUnion({
          outcome: 'ACTIVATED',
          branchId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          businessDay: '2026-09-01',
          activationBusinessDay: '2026-08-30',
          firstEligibleBusinessDay: '2026-08-31',
          dayClose: { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
        }),
      ).toBe(false);
    });

    it('an unknown outcome value is rejected by both branches', () => {
      expect(
        matchesUnion({
          outcome: 'PENDING',
          branchId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          businessDay: '2026-09-01',
          activationBusinessDay: '2026-09-01',
          firstEligibleBusinessDay: '2026-09-02',
        }),
      ).toBe(false);
    });
  });

  /**
   * Exhaustive path-parameter format test (API final acceptance
   * correction, 2026-09-01) — derives EVERY path parameter from `doc.paths`
   * globally (not the 106 instances the audit happened to find affected),
   * and checks each against `classifyPathParamName` — the SAME pure
   * mapping `src/common/openapi/oas31.util.ts`'s `enrichPathParameterSchemas`
   * uses to write the document, imported directly rather than duplicated,
   * so the post-processor and this test cannot silently drift apart.
   */
  describe('path parameters — exhaustive format/type contract', () => {
    it('every {placeholder} in every path has exactly one matching in:path parameter, none optional', () => {
      const violations: string[] = [];
      for (const [p, ops] of Object.entries(doc.paths)) {
        const placeholders = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        for (const [method, op] of Object.entries(ops)) {
          if (!HTTP_METHODS.includes(method)) continue;
          const pathParams = (op.parameters ?? []).filter(
            (param) => param.in === 'path',
          );
          for (const name of placeholders) {
            const matches = pathParams.filter((param) => param.name === name);
            if (matches.length !== 1) {
              violations.push(
                `${method.toUpperCase()} ${p}: {${name}} has ${matches.length} matching parameter definitions (expected 1)`,
              );
              continue;
            }
            if (matches[0].required !== true) {
              violations.push(
                `${method.toUpperCase()} ${p}: {${name}} is not required`,
              );
            }
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it('every path parameter classified uuid/businessDay/version carries the exact expected type+format', () => {
      const violations: string[] = [];
      for (const [p, ops] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(ops)) {
          if (!HTTP_METHODS.includes(method)) continue;
          for (const param of op.parameters ?? []) {
            if (param.in !== 'path') continue;
            const kind = classifyPathParamName(param.name);
            if (!kind) continue;
            const key = `${method.toUpperCase()} ${p} {${param.name}}`;
            const schema = (param as unknown as { schema?: SchemaNode }).schema;
            if (!schema) {
              violations.push(`${key}: no schema`);
              continue;
            }
            if (kind === 'uuid') {
              if (schema.type !== 'string' || schema.format !== 'uuid') {
                violations.push(
                  `${key}: expected {type:'string',format:'uuid'}, got ${JSON.stringify(
                    { type: schema.type, format: schema.format },
                  )}`,
                );
              }
            } else if (kind === 'businessDay') {
              if (schema.type !== 'string' || schema.format !== 'date') {
                violations.push(
                  `${key}: expected {type:'string',format:'date'}, got ${JSON.stringify(
                    { type: schema.type, format: schema.format },
                  )}`,
                );
              }
            } else if (kind === 'version') {
              if (schema.type !== 'integer') {
                violations.push(
                  `${key}: expected {type:'integer'}, got ${JSON.stringify({
                    type: schema.type,
                  })}`,
                );
              }
            }
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
