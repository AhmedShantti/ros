import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../common/ids';

/**
 * `POST|GET /branches/:branchId/day-closes/:businessDay` path params.
 * `businessDay` is a locator shape check only — the real calendar-date/
 * eligibility rules run inside the command's own transaction.
 */
export class DayCloseParamsDto {
  @Matches(UUID_PATTERN) branchId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDay!: string;
}

/**
 * Deliberately ZERO declared properties (the accepted Reporting/§26 API
 * precedent). Combined with the global `ValidationPipe`'s
 * `whitelist: true, forbidNonWhitelisted: true`, an EMPTY body class makes
 * ANY body property a 400 — every input to DayClose POST is server-derived;
 * nothing financially significant is client-supplied.
 */
export class PostDayCloseDto {}
