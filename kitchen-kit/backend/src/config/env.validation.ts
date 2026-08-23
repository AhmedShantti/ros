import { Type, plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Startup contract for required environment variables. Validated once at boot;
 * a missing or malformed value aborts startup instead of failing later at runtime.
 * Secret VALUES are never logged — only the names of the offending variables.
 */
export class EnvironmentVariables {
  // Migration/owner connection (Prisma CLI + migrations).
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // Runtime application connection (non-superuser; RLS-constrained). Used by
  // PrismaService from Phase 8 onwards; required in the contract from the start.
  @IsString()
  @IsNotEmpty()
  APP_DATABASE_URL!: string;

  // Long random secret (openssl rand -base64 64). Kept out of source control.
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_TTL!: string;

  // Pinned issuer/audience — signed into and required when verifying the access
  // JWT (Phase 14). Defaults are safe, stable identifiers, not secrets.
  @IsString()
  @IsNotEmpty()
  JWT_ISSUER: string = 'ros-identity';

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE: string = 'ros-identity-api';

  // Rate limiting for sensitive auth endpoints. Validated so an invalid value
  // fails fast at boot. Defaults are PRODUCTION-SAFE (strict); development/test
  // opt into a looser limit explicitly (see .env / test/setup-e2e.ts).
  @IsInt()
  @Min(1000)
  @Max(3_600_000)
  AUTH_THROTTLE_TTL: number = 60_000;

  @IsInt()
  @Min(1)
  @Max(100_000)
  AUTH_THROTTLE_LIMIT: number = 10;

  /**
   * FR-SEC-022: "lockout after a CONFIGURABLE number of failures". The SRS does
   * not state a number, so this is an IMPLEMENTATION-level default following the
   * repository's existing explicit-default convention (as `AUTH_THROTTLE_LIMIT`
   * does) — it is documented here rather than hidden in a service, and it is NOT
   * a requirement-level value.
   */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  PIN_MAX_FAILED_ATTEMPTS: number = 5;

  /** How long a PIN stays locked once the threshold is reached. */
  @IsInt()
  @Min(1000)
  @Type(() => Number)
  PIN_LOCKOUT_MS: number = 900_000;

  // Express `trust proxy` setting. Unset/`false` trusts NO forwarding header
  // (safe default). Set to a hop count (e.g. `1`), `true`, or a subnet string
  // only when running behind a known, trusted reverse proxy. See docs/auth.
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  /**
   * FR-LOC-022 / FR-LOC-024 — directory holding signed Country Pack bundles
   * (`*.pack.json`). OPTIONAL and unset by default: an unconfigured deployment
   * activates no pack, and because the signature verifier is deny-all until a
   * concrete signing scheme is ratified, the system refuses to price a sale
   * rather than pricing one under an unverified pack.
   */
  @IsOptional()
  @IsString()
  COUNTRY_PACK_DIR?: string;

  /**
   * FR-LOC-022 - path to the trusted release-key manifest (PUBLIC keys only).
   * OPTIONAL and unset by default: with no manifest nothing is trusted, every
   * pack signature is rejected, and the system refuses to price a sale rather
   * than pricing one under an unverified rate.
   */
  @IsOptional()
  @IsString()
  COUNTRY_PACK_TRUST_MANIFEST?: string;

  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;
}

// Values that unambiguously indicate an un-replaced placeholder / dev secret.
const PLACEHOLDER =
  /change[_-]?me|placeholder|example|your[_-]|dev[_-]secret|test[_-]secret|secret[_-]?here/i;

/**
 * Reject insecure/default configuration in production. Runs after structural
 * validation. Never logs values — only variable names.
 */
function assertProductionHardened(env: EnvironmentVariables): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;
  const offenders: string[] = [];
  if (PLACEHOLDER.test(env.JWT_ACCESS_SECRET))
    offenders.push('JWT_ACCESS_SECRET');
  if (PLACEHOLDER.test(env.DATABASE_URL)) offenders.push('DATABASE_URL');
  if (PLACEHOLDER.test(env.APP_DATABASE_URL))
    offenders.push('APP_DATABASE_URL');
  // Runtime must connect as the non-superuser app role, never the migrator.
  if (/ros_migrator/.test(env.APP_DATABASE_URL))
    offenders.push(
      'APP_DATABASE_URL (must use the ros_app role, not ros_migrator)',
    );
  if (offenders.length > 0) {
    throw new Error(
      `Production configuration rejected — replace insecure/default values for: ${offenders.join(', ')}`,
    );
  }
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    // Report offending variable NAMES only — never their (secret) values.
    const offenders = errors.map((e) => e.property).join(', ');
    throw new Error(
      `Invalid environment configuration. Check these variables: ${offenders}`,
    );
  }

  assertProductionHardened(validated);

  return validated;
}
