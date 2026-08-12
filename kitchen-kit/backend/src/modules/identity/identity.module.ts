import { Module } from '@nestjs/common';
import { CredentialsService } from './credentials/credentials.service';
import { UsersRepository } from './users/users.repository';
import { UsersService } from './users/users.service';

/**
 * Identity bounded context. Owns users, credentials, and (from later phases)
 * sessions, tenants/memberships, roles/permissions, terminals. Other contexts
 * consume it through exported services, never by reaching into its tables.
 */
@Module({
  providers: [UsersService, UsersRepository, CredentialsService],
  exports: [UsersService, CredentialsService],
})
export class IdentityModule {}
