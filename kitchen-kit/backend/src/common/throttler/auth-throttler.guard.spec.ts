import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AuthThrottlerGuard } from './auth-throttler.guard';

describe('AuthThrottlerGuard.getTracker', () => {
  const guard = new AuthThrottlerGuard(
    { throttlers: [{ ttl: 1000, limit: 1 }] },
    {} as ThrottlerStorage,
    {} as Reflector,
  );
  const track = (req: Record<string, unknown>): Promise<string> =>
    (
      guard as unknown as {
        getTracker(r: Record<string, unknown>): Promise<string>;
      }
    ).getTracker(req);

  it('keys by IP + account when an email is present', async () => {
    await expect(
      track({ ip: '1.2.3.4', body: { email: 'User@Example.com' } }),
    ).resolves.toBe('1.2.3.4:user@example.com');
  });

  it('keys by IP alone when there is no email', async () => {
    await expect(track({ ip: '1.2.3.4', body: {} })).resolves.toBe('1.2.3.4');
    await expect(track({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4');
  });

  it('falls back to req.ips then "unknown"', async () => {
    await expect(
      track({ ips: ['9.9.9.9'], body: { email: 'x@y.z' } }),
    ).resolves.toBe('9.9.9.9:x@y.z');
    await expect(track({})).resolves.toBe('unknown');
  });
});
