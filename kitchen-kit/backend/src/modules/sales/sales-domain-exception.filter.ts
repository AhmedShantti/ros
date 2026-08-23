import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { BusinessDayError } from './orders/business-day';
import { CountryPackUnavailableError } from '../localisation/country-pack/country-pack.registry';
import { TaxClassUnavailableError } from '../localisation/tax/tax-class.service';
import { TaxComputationError } from '../localisation/tax/tax.model';
import { RecipeCostError } from '../production/costing/recipe-cost';
import {
  OrderStateError,
  OrderVersionConflictError,
} from './orders/order-state';

/**
 * Map Sales domain errors onto SRS §26 Problem Details statuses.
 *
 * The domain layer throws PLAIN errors on purpose: `order-state.ts`,
 * `recipe-cost.ts` and the tax calculator are pure and must stay free of HTTP,
 * so a direct service call gets the same refusal a request does. This filter is
 * the single place that decides what each refusal looks like over the wire —
 * without it every business-rule violation surfaced as a 500, which tells a
 * client "we broke" when the truth is "you may not do that".
 *
 *   409  the caller's precondition was stale — someone else got there first
 *   422  the request was well formed but the domain refuses it
 *
 * Messages are the domain's own and are deliberately explicit about WHY: a
 * cashier told "that item has no tax class" can act; one told "unprocessable"
 * cannot. None of them discloses another tenant's data, a key, a path or SQL.
 */
@Catch(
  OrderStateError,
  TaxClassUnavailableError,
  TaxComputationError,
  RecipeCostError,
  CountryPackUnavailableError,
  BusinessDayError,
)
export class SalesDomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SalesDomainExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: Error, host: ArgumentsHost): void {
    // A stale If-Match is a CONCURRENCY conflict, not a business-rule refusal:
    // the caller may well be allowed to do this, just not against that version.
    const status =
      error instanceof OrderVersionConflictError
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;

    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    httpAdapter.reply(
      ctx.getResponse(),
      new HttpException(
        { statusCode: status, message: error.message, error: error.name },
        status,
      ).getResponse(),
      status,
    );
  }
}
