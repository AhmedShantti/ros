import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import * as yaml from 'js-yaml';
import { AppModule } from '../app.module';
import { finalizeOpenApiDocument } from '../common/openapi/oas31.util';
import { buildSwaggerConfig } from '../swagger.config';

/**
 * Standalone OpenAPI document generator.
 *
 * Must be run against the `nest build` output (`dist/`), not `ts-node`
 * against `src/` directly: `@nestjs/swagger`'s CLI plugin (configured in
 * `nest-cli.json`) synthesizes `@ApiProperty()` metadata for DTO classes at
 * compile time, inside Nest's own compilation pass. A raw `ts-node` run
 * bypasses that pass entirely, silently producing empty/incomplete request
 * schemas. See `package.json`'s `openapi:generate` script for the correct
 * invocation (`nest build && node dist/scripts/generate-openapi.js`).
 *
 * Output is written deterministically: object keys are sorted recursively
 * before serialization, so re-running against an unchanged API surface
 * produces byte-identical files (no timestamps, no non-deterministic key
 * order) — verified by `test/openapi.e2e-spec.ts`.
 */

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

async function main(): Promise<void> {
  const { version: apiVersion } = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string };

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const document = sortKeysDeep(
    finalizeOpenApiDocument(
      SwaggerModule.createDocument(app, buildSwaggerConfig(apiVersion), {
        deepScanRoutes: true,
      }),
    ),
  );

  const outDir = join(__dirname, '..', '..', 'docs', 'api');
  const jsonPath = join(outDir, 'openapi.json');
  const yamlPath = join(outDir, 'openapi.yaml');

  writeFileSync(jsonPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
  writeFileSync(
    yamlPath,
    yaml.dump(document, { sortKeys: true, lineWidth: -1, noRefs: true }),
    'utf8',
  );

  await app.close();

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${yamlPath}`);
}

main().catch((err) => {
  console.error('OpenAPI generation failed:', err);
  process.exitCode = 1;
});
