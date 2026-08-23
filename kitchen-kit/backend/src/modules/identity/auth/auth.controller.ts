import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthThrottlerGuard } from '../../../common/throttler/auth-throttler.guard';
import {
  isoDateTimeSchema,
  nullable,
} from '../../../common/openapi/schema-helpers';
import { AuthService } from './auth.service';
import type { AuthenticatedPrincipal } from './auth.types';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

// SafeUser (`user.view.ts`) — never includes credentials. Shared across
// login/pin/refresh/me, which all return this same shape (me() adds
// mustReset).
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

const authTokensSchema = {
  type: 'object',
  properties: {
    tokenType: { type: 'string', enum: ['Bearer'] },
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: {
      type: 'integer',
      description: 'Access token lifetime in seconds.',
    },
    user: safeUserSchema,
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email + password.' })
  @ApiOkResponse({
    description: 'Access token, refresh token, and user.',
    schema: authTokensSchema,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  /**
   * FR-SEC-020/021/022 — POS PIN authentication.
   *
   * Same throttling as the other sensitive auth endpoints. The issued session is
   * POS-only; it cannot reach dashboard routes (FR-SEC-021).
   */
  @Post('pin')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Authenticate with a terminal-scoped employee PIN (POS).',
  })
  @ApiOkResponse({
    description:
      'Access token, refresh token, and user. The session is POS-only.',
    schema: authTokensSchema,
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid PIN, unknown employee code, or unknown terminal/tenant.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  loginWithPin(@Body() dto: PinLoginDto, @Req() req: Request) {
    return this.auth.loginWithPin(dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('refresh')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a refresh token for a new access + refresh token pair.',
  })
  @ApiOkResponse({
    description: 'A rotated access + refresh token pair.',
    schema: authTokensSchema,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, revoked, or reused refresh token.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session.' })
  @ApiNoContentResponse({ description: 'Current session revoked.' })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  async logout(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<void> {
    await this.auth.logout(principal.userId, principal.sessionId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The authenticated user.' })
  @ApiOkResponse({
    description:
      'The authenticated user (no credentials), plus whether their password must be reset before further use.',
    schema: {
      type: 'object',
      properties: {
        ...safeUserSchema.properties,
        mustReset: { type: 'boolean' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.auth.me(principal.userId);
  }
}
