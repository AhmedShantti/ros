import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

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

  // Security headers. CSP is disabled so the Swagger UI at /docs keeps working;
  // enable a tailored CSP when a fixed front-end origin is known.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Reject unknown/invalid input at the edge; strip properties not in the DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ROS Identity API')
    .setDescription('Authentication & authorization for the Restaurant OS.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`ROS Identity API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
