import { CredentialsService } from './credentials.service';

describe('CredentialsService', () => {
  const service = new CredentialsService();

  it('hashes passwords with Argon2id (never plaintext)', async () => {
    const hash = await service.hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('verifies a correct password', async () => {
    const hash = await service.hashPassword('correct horse battery');
    await expect(
      service.verifyPassword(hash, 'correct horse battery'),
    ).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hashPassword('correct horse battery');
    await expect(service.verifyPassword(hash, 'wrong password')).resolves.toBe(
      false,
    );
  });

  it('returns false (not throw) on a malformed hash', async () => {
    await expect(
      service.verifyPassword('not-a-hash', 'whatever'),
    ).resolves.toBe(false);
  });
});
