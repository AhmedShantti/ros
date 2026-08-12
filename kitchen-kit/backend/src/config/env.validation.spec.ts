import 'reflect-metadata'; // class-transformer/validator need it; loaded at app bootstrap but not in an isolated unit test.
import { NodeEnv, validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://ros_migrator:pw@localhost:5544/ros',
  APP_DATABASE_URL: 'postgresql://ros_app:pw@localhost:5544/ros',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
};

describe('validateEnv', () => {
  it('accepts a valid configuration and applies safe defaults', () => {
    const env = validateEnv({ ...base });
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.AUTH_THROTTLE_TTL).toBe(60_000);
    expect(env.AUTH_THROTTLE_LIMIT).toBe(10); // production-safe default
    expect(env.JWT_ISSUER).toBe('ros-identity');
    expect(env.JWT_AUDIENCE).toBe('ros-identity-api');
  });

  it('coerces and accepts explicit throttle values', () => {
    const env = validateEnv({
      ...base,
      AUTH_THROTTLE_TTL: '30000',
      AUTH_THROTTLE_LIMIT: '5',
    });
    expect(env.AUTH_THROTTLE_TTL).toBe(30_000);
    expect(env.AUTH_THROTTLE_LIMIT).toBe(5);
  });

  it('fails fast on an invalid throttle limit (non-numeric)', () => {
    expect(() =>
      validateEnv({ ...base, AUTH_THROTTLE_LIMIT: 'not-a-number' }),
    ).toThrow(/AUTH_THROTTLE_LIMIT/);
  });

  it('fails fast on an out-of-range throttle limit (zero)', () => {
    expect(() => validateEnv({ ...base, AUTH_THROTTLE_LIMIT: '0' })).toThrow(
      /AUTH_THROTTLE_LIMIT/,
    );
  });

  it('fails fast on a too-short JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'CHANGE_ME_LONG_RANDOM_SECRET_CHANGE_ME_NOW',
      }),
    ).toThrow(/Production configuration rejected/);
  });

  it('rejects the migrator role as the runtime connection in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://ros_migrator:pw@db:5432/ros',
      }),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it('accepts a hardened production configuration', () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'Zt9' + 'x'.repeat(60),
      AUTH_THROTTLE_LIMIT: '8',
    });
    expect(env.NODE_ENV).toBe(NodeEnv.Production);
    expect(env.AUTH_THROTTLE_LIMIT).toBe(8);
  });
});
