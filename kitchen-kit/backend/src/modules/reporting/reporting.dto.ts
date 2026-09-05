import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../common/ids';

/**
 * `GET /reports/branches/:branchId/daily-trading/:businessDay` path params.
 * `businessDay` is a locator (partition-key-shaped), not a claim about the
 * report's content — the real calendar-date/future-day checks happen after
 * this shape check, inside the report's own RepeatableRead transaction.
 */
export class DailyTradingReportParamsDto {
  @Matches(UUID_PATTERN) branchId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDay!: string;
}

/**
 * Deliberately ZERO declared properties (design gate §9). Combined with the
 * global `ValidationPipe`'s `whitelist: true, forbidNonWhitelisted: true`
 * (`src/main.ts`), binding this as `@Query()` makes ANY query parameter —
 * known or not, since none is declared — a 400. This is the smallest
 * repository-compatible mechanism that actually PROVES arbitrary query
 * parameters are refused, rather than merely documenting the intent.
 */
export class DailyTradingReportQueryDto {}

/** `GET /reports/branches/:branchId/overview` path params (RPT-DEMO-1). */
export class OperationalOverviewParamsDto {
  @Matches(UUID_PATTERN) branchId!: string;
}

/**
 * `businessDay` is REQUIRED — a locator (partition-key-shaped), not a claim
 * about the report's content, exactly like `daily-trading`'s path param.
 * `whitelist: true, forbidNonWhitelisted: true` (global `ValidationPipe`)
 * makes any OTHER query parameter a 400, since only `businessDay` is
 * declared here.
 */
export class OperationalOverviewQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDay!: string;
}
