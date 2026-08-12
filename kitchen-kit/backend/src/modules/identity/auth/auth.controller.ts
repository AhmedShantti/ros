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
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthThrottlerGuard } from '../../../common/throttler/auth-throttler.guard';
import { AuthService } from './auth.service';
import type { AuthenticatedPrincipal } from './auth.types';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Access token, refresh token, and user.' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('refresh')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'A rotated access + refresh token pair.' })
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
  @ApiOkResponse({ description: 'The authenticated user (no credentials).' })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.auth.me(principal.userId);
  }
}
