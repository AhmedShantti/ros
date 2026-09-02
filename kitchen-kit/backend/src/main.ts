import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { applyApiVersioning } from './common/http/api-versioning';
import { applySyncBodyLimit } from './modules/sync/sync.bootstrap';
import { finalizeOpenApiDocument } from './common/openapi/oas31.util';
import { buildSwaggerConfig } from './swagger.config';

const { version: apiVersion } = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

/**
 * Interpret the TRUST_PROXY env value into an Express `trust proxy` setting.
 * Unset/empty/`false` → false (trust NO X-Forwarded-* header). A bare integer →
 * that many trusted proxy hops. `true` → trust the immediate peer. Anything else
 * (e.g. a subnet / `loopback`) is passed through to Express verbatim.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? '').trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  const config = app.get(ConfigService);

  // Only honor X-Forwarded-* when explicitly configured for the deployment's
  // proxy topology; the default trusts no forwarding header, so a client cannot
  // spoof its source IP (which the auth rate limiter keys on).
  app.set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));

  // URI versioning, VERSION_NEUTRAL by default: every existing route keeps its
  // current path, and only a controller that explicitly declares a version
  // moves under `/v1`. See the helper's docblock.
  applyApiVersioning(app);

  // Path-scoped body limit for the sync routes only; every other route keeps
  // Express's default. Must precede app.init()/listen so it is registered
  // ahead of Nest's global parser. See the helper's docblock.
  applySyncBodyLimit(app);

  // Security headers. CSP is disabled so the Swagger UI at /docs keeps working;
  // enable a tailored CSP when a fixed front-end origin is known.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Allow the front-end dev origin(s) to call this API from the browser.
  // CORS_ORIGIN can be a single URL or a comma-separated list.
  const corsOrigin = config.get<string>('CORS_ORIGIN', '');
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true, // fallback: allow all origins if not set (fine for local dev)
    credentials: true,
  });

  // Reject unknown/invalid input at the edge; strip properties not in the DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  SwaggerModule.setup(
    'docs',
    app,
    finalizeOpenApiDocument(
      SwaggerModule.createDocument(app, buildSwaggerConfig(apiVersion)),
    ),
  );

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`ROS Backend API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
