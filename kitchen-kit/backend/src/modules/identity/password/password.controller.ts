import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthThrottlerGuard } from '../../../common/throttler/auth-throttler.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordService } from './password.service';

@ApiTags('password')
@Controller('auth/password')
export class PasswordController {
  constructor(private readonly passwords: PasswordService) {}

  /** Authenticated password change (proves the current password). */
  @Post('change')
  @UseGuards(JwtAuthGuard, AuthThrottlerGuard)
  @ApiBearerAuth()
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Password changed; other sessions revoked.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing token or wrong current password.',
  })
  async change(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.passwords.changePassword(
      principal.userId,
      principal.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /** Forgot-password request. Always a generic 202 (no account enumeration). */
  @Post('forgot')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    description: 'If the account exists, a reset token has been issued.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  async forgot(@Body() dto: ForgotPasswordDto): Promise<{ status: string }> {
    await this.passwords.requestReset(dto.email);
    return { status: 'accepted' };
  }

  /** Complete a password reset with a single-use token. */
  @Post('reset')
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Password reset; all sessions revoked.',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, or already-used reset token.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  async reset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.passwords.resetPassword(dto.token, dto.newPassword);
  }
}
