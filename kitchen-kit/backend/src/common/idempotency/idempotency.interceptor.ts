import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable, from, of, tap } from 'rxjs';
import { AuthenticatedPrincipal } from '../../modules/identity/auth/auth.types';
import { IDEMPOTENT } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';

type AuthedRequest = Request & { principal?: AuthenticatedPrincipal };

const HEADER = 'idempotency-key';
const REPLAY_HEADER = 'Idempotent-Replay';
const MAX_KEY_LENGTH = 80;

/**
 * Applies the reusable idempotency store to any route marked {@link Idempotent}.
 *
 * Flow, matching SRS §26.5:
 *   - no key on a mandatory route            -> 400 (FR-API-020)
 *   - first use                              -> reserve, run, store response
 *   - same key + same fingerprint, completed -> stored response + Idempotent-Replay: true (FR-API-022)
 *   - same key + different fingerprint       -> 409 (FR-API-023)
 *   - same key still in flight               -> 409 (no duplicate work)
 *   - handler throws                         -> reservation released, so a retry can proceed
 *
 * The tenant comes from the authenticated principal, never from the body, so a
 * key can never be replayed across a tenant boundary.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const response = http.getResponse<Response>();

    const raw = request.headers[HEADER];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || key.trim().length === 0) {
      throw new BadRequestException(
        'Idempotency-Key header is required for this operation.',
      );
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
      );
    }

    const tenantId = request.principal?.tenantId;
    if (!tenantId) {
      // No tenant context means no isolation boundary for the key; fail closed
      // rather than sharing a key space.
      throw new BadRequestException(
        'A tenant context is required for an idempotent operation.',
      );
    }

    // Use the resolved request path (real segment values, e.g.
    // `/orders/2026-08-24/ord_123/fire`), not `request.route.path` (the
    // registered Express pattern, e.g. `/orders/:businessDay/:id/fire`).
    // The pattern is shared by every resource matching the route, so it
    // collapses distinct resources into one idempotency identity; the
    // resolved path is what actually varies per resource.
    const routePath: string = request.path;
    const endpoint = `${request.method} ${routePath}`;
    const fingerprint = this.idempotency.fingerprint(
      request.method,
      routePath,
      request.body,
    );

    return from(
      (async () => {
        const outcome = await this.idempotency.reserve(
          tenantId,
          key,
          endpoint,
          fingerprint,
        );

        if (outcome.kind === 'replay') {
          response.setHeader(REPLAY_HEADER, 'true');
          response.status(outcome.response.status);
          return { replayed: true, body: outcome.response.body };
        }
        return { replayed: false as const };
      })(),
    ).pipe(
      // `switchMap` via a nested observable keeps the handler lazy: it must not
      // run at all on a replay.
      (source) =>
        new Observable((subscriber) => {
          const sub = source.subscribe({
            next: (reservation) => {
              const r = reservation as
                { replayed: true; body: unknown } | { replayed: false };
              if (r.replayed) {
                subscriber.next(r.body);
                subscriber.complete();
                return;
              }
              next
                .handle()
                .pipe(
                  tap({
                    next: (body) => {
                      // Fire-and-forget, but never UNHANDLED: an unattached
                      // rejection here (a closing pool, a lost connection)
                      // would take the whole process down instead of losing
                      // one replay record.
                      void this.idempotency
                        .complete(tenantId, key, {
                          status: response.statusCode,
                          body: body ?? null,
                        })
                        .catch(() => undefined);
                    },
                    error: () => {
                      void this.idempotency
                        .release(tenantId, key)
                        .catch(() => undefined);
                    },
                  }),
                )
                .subscribe({
                  next: (v) => subscriber.next(v),
                  error: (e) => subscriber.error(e),
                  complete: () => subscriber.complete(),
                });
            },
            error: (e) => subscriber.error(e),
          });
          return () => sub.unsubscribe();
        }),
    );
  }

  /** Kept for symmetry with future non-HTTP callers. */
  static replayHeader(): string {
    return REPLAY_HEADER;
  }
}

export { of };
