import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so any bounded-context module can inject PrismaService without
 * re-importing. Identity is the only context that owns writes to the
 * `identity` schema; other contexts must go through application contracts.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
