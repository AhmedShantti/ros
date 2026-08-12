import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'Service is up.' })
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'ros-identity' };
  }
}
