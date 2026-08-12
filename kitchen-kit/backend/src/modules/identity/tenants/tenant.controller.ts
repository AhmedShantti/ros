import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MembershipsService } from '../memberships/memberships.service';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { TenantSelectionService } from './tenant-selection.service';

@ApiTags('tenants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth')
export class TenantController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly selection: TenantSelectionService,
  ) {}

  @Get('tenants')
  @ApiOkResponse({ description: "The caller's selectable tenants." })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  listTenants(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.memberships.listForUser(principal.userId);
  }

  @Post('tenant')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Tenant selected; tenant-scoped access token.',
  })
  @ApiForbiddenResponse({
    description: 'No active membership for this tenant.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  selectTenant(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: SelectTenantDto,
  ) {
    return this.selection.select(
      principal.userId,
      principal.sessionId,
      dto.tenantId,
    );
  }

  @Get('tenant')
  @ApiOkResponse({ description: 'Current tenant context on the request.' })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  currentTenant(@CurrentPrincipal() principal: AuthenticatedPrincipal): {
    tenantId: string | null;
    membershipId: string | null;
  } {
    return {
      tenantId: principal.tenantId ?? null,
      membershipId: principal.membershipId ?? null,
    };
  }
}
