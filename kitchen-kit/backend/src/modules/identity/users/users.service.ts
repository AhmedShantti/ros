import { ConflictException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { assertPasswordMeetsPolicy } from '../credentials/password-policy';
import { CreateUserDto } from './dto/create-user.dto';
import { SafeUser, toSafeUser } from './user.view';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
  ) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Create a user together with its password credential in a single
   * transaction — a user can never exist without authentication material.
   * Returns a credential-free view.
   */
  async createUser(dto: CreateUserDto): Promise<SafeUser> {
    const email = UsersService.normalizeEmail(dto.email);
    assertPasswordMeetsPolicy(dto.password);

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email already registered.');
    }

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            id: newId(),
            email,
            displayName: dto.displayName,
            phone: dto.phone ?? null,
            preferredLocale: dto.preferredLocale ?? 'ar',
          },
        });
        await this.credentials.createPasswordCredential(
          tx,
          created.id,
          dto.password,
        );
        return created;
      });
      return toSafeUser(user);
    } catch (err) {
      // Unique-violation race: another request registered the same email first.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered.');
      }
      throw err;
    }
  }
}
