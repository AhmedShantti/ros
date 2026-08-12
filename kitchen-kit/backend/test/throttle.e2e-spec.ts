import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// Matches the AUTH_THROTTLE_LIMIT the e2e run configures in test/setup-e2e.ts
// (the production-safe code default is stricter). Each test app has its OWN
// in-memory throttler store, so this suite cannot affect (or be affected by)
// other suites.
const LIMIT = 50;

describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 once a sensitive endpoint exceeds the limit (IP-keyed refresh)', async () => {
    const bogus = 'a'.repeat(64);
    // The first LIMIT requests pass the guard (401 invalid token)...
    for (let i = 0; i < LIMIT; i++) {
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: bogus })
        .expect(401);
    }
    // ...the next one is rate-limited.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: bogus })
      .expect(429);
  });

  it('keys are independent: an account-keyed login is unaffected by the IP-keyed exhaustion', async () => {
    // The refresh key (IP) is exhausted above; a login uses a different key
    // (IP+email), so it still reaches the handler (generic 401, not 429).
    await request(http)
      .post('/auth/login')
      .send({
        email: `throttle.${Date.now()}@example.com`,
        password: 'nope-pw',
      })
      .expect(401);
  });
});
