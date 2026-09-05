import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { isoDateTimeSchema, nullable } from '../../../common/openapi/schema-helpers';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { RegistrationsService } from './registrations.service';

const safeUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string' },
    phone: nullable({ type: 'string' }),
    preferredLocale: { type: 'string', example: 'ar' },
    status: { type: 'string', enum: ['active', 'disabled', 'locked'] },
    lastLoginAt: nullable(isoDateTimeSchema()),
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
  },
};

const tenantSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    legalName: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended', 'closed'] },
    defaultCurrency: { type: 'string', example: 'EGP' },
    defaultLocale: { type: 'string', example: 'ar' },
  },
};

/**
 * SIGNUP-1 (FR-PLT-020) — public tenant self-service signup.
 *
 * PUBLIC route, rate-limited (FR-SEC-046). Deliberately the plain
 * `ThrottlerGuard` (IP-keyed), NOT the shared `AuthThrottlerGuard` every other
 * sensitive auth endpoint uses: that guard keys by `ip:email` when the body
 * carries an email, which is exactly right for login/forgot-password (the
 * SAME account being hammered from one IP) but wrong here — every signup
 * request legitimately carries a DIFFERENT, attacker-chosen email, so keying
 * on it would let an attacker sidestep the limit simply by varying the email
 * on every request. Strict DTO validation
 * (`ValidationPipe({whitelist:true, forbidNonWhitelisted:true})`, applied
 * globally in `main.ts`) rejects unknown/malformed fields (FR-SEC-047).
 */
@ApiTags('auth')
@Controller('auth')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post('registrations')
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Tenant self-service signup (FR-PLT-020). Creates a first user, a ' +
      'tenant, a working branch, and an Owner role with the full permission ' +
      'catalog, atomically. Returns a tenant-scoped auth result so the ' +
      'caller can enter the dashboard immediately. Supports roleKey "owner" ' +
      'only in this slice.',
  })
  @ApiCreatedResponse({
    description: 'Tenant created; tenant-scoped access token issued.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['created'] },
        email: { type: 'string', format: 'email' },
        auth: {
          type: 'object',
          properties: {
            tokenType: { type: 'string', enum: ['Bearer'] },
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            expiresIn: { type: 'integer' },
            user: safeUserSchema,
          },
        },
        tenant: tenantSummarySchema,
        membership: {
          type: 'object',
          properties: {
            membershipId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['active'] },
          },
        },
      },
    },
  })
  @ApiConflictResponse({ description: 'Email already registered.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  register(@Body() dto: RegisterTenantDto) {
    return this.registrations.register(dto);
  }
}
