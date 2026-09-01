import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { KdsAuthorizedRequest, KdsStation } from './kds-station.guard';

/** Extracts the station `KdsStationGuard` resolved. Only valid on routes guarded by it. */
export const CurrentKdsStation = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): KdsStation => {
    const request = ctx.switchToHttp().getRequest<KdsAuthorizedRequest>();
    return request.kdsStation as KdsStation;
  },
);
