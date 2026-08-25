import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

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
   * of FR-POS-035), Completion, refund, and KDS bump/recall remain
   * unimplemented and must still be absent.
   *
   * P1F-1 — explicit partial CASH / manual-external-card Payment capture is
   * now real too, so it joins Fire as an EXPECTED, single, exact route.
   * Completion, refund, KDS bump/recall, and any integrated-terminal or
   * PaymentAttempt route remain unimplemented non-goals and must still be
   * absent — the forbidden-pattern check below no longer includes
   * `/payments?\b/`, since that would now also match the real, accepted
   * Payment route; it is replaced with precise integrated-terminal/
   * PaymentAttempt patterns instead.
   */
  it('documents explicit Fire and Payment (and only those routes), and does not document Completion, refund, integrated-terminal, PaymentAttempt, or KDS bump/recall endpoints', () => {
    const paths = Object.keys(doc.paths);
    const fireMatches = paths.filter((p) => /\/fire\b/i.test(p));
    expect(fireMatches).toEqual(['/orders/{businessDay}/{id}/fire']);

    const paymentMatches = paths.filter((p) => /\/payments?\b/i.test(p));
    expect(paymentMatches).toEqual(['/orders/{businessDay}/{id}/payments']);

    const forbidden = [
      /\/complete\b/i,
      /\/refunds?\b/i,
      /\bbump\b/i,
      /\brecall\b/i,
      /payment[-_]?attempts?/i,
      /terminals?\/(session|authoriz|capture)/i,
    ];
    for (const p of paths) {
      for (const pattern of forbidden) {
        expect(p).not.toMatch(pattern);
      }
    }
  });

  it('does not expose the Kitchen module (no controller exists there)', () => {
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
});
