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
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { nullable } from '../../../common/openapi/schema-helpers';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MembershipsService } from '../memberships/memberships.service';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { TenantSelectionService } from './tenant-selection.service';

// Shapes verified against `tenant.view.ts` (`TenantSummary`) and
// `membership.view.ts` (`MembershipSummary`/`MembershipView`/
// `SelectTenantResult`) — the actual factory functions, not the Prisma schema.
const tenantSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    legalName: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended', 'closed'] },
    defaultCurrency: { type: 'string', example: 'AED' },
    defaultLocale: { type: 'string', example: 'ar' },
  },
};

const membershipSummarySchema = {
  type: 'object',
  properties: {
    membershipId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
  },
};

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
  @ApiOperation({ summary: "The caller's selectable tenants." })
  @ApiOkResponse({
    description: "The caller's selectable tenants.",
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...membershipSummarySchema.properties,
          tenant: tenantSummarySchema,
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
  listTenants(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.memberships.listForUser(principal.userId);
  }

  @Post('tenant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Select a tenant, obtaining a tenant-scoped access token.',
  })
  @ApiOkResponse({
    description: 'Tenant selected; tenant-scoped access token.',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        tokenType: { type: 'string', enum: ['Bearer'] },
        expiresIn: {
          type: 'integer',
          description: 'Access token lifetime in seconds.',
        },
        tenant: tenantSummarySchema,
        membership: membershipSummarySchema,
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'No active membership for this tenant, or the tenant is not active.',
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
  @ApiOperation({ summary: 'Current tenant context on the request.' })
  @ApiOkResponse({
    description:
      'Current tenant context on the request. Both fields are null before a tenant is selected.',
    schema: {
      type: 'object',
      properties: {
        tenantId: nullable({ type: 'string', format: 'uuid' }),
        membershipId: nullable({ type: 'string', format: 'uuid' }),
      },
    },
  })
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
