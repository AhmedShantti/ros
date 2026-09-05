import { Injectable, LoggerService } from '@nestjs/common';
import { ObservabilityContextService } from '../context/observability-context';
import { sanitizeMetadata } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SERVICE_NAME = 'ros-backend-api';

/** Stable, search/aggregation-friendly envelope — SRS §27.6 NFR-OBS-001. */
export interface LogEnvelope {
  timestamp: string;
  level: LogLevel;
  service: string;
  event: string;
  message: string;
  tenantId: string | null;
  branchId: string | null;
  correlationId: string | null;
  causationId: string | null;
  [key: string]: unknown;
}

/**
 * Central structured application logger (SRS §27.6 NFR-OBS-001). Every
 * emitted line is exactly one JSON object written to stdout — no raw
 * request/response/header/body dumps, ever (see `redaction.ts`).
 *
 * Implements Nest's {@link LoggerService} so it can be installed via
 * `app.useLogger(...)` in `main.ts`: every existing `new Logger(ClassName)`
 * call site in the codebase (14 as of this slice) then routes through this
 * class automatically, with zero call-site edits. Nest's own framework logs
 * (bootstrap, route explorer, etc.) get the same treatment once installed.
 *
 * Also directly injectable — the request-completion path
 * (`request-context.guard.ts` and its completion write) calls
 * {@link logEvent} on this exact instance rather than a separate channel, so
 * "through the real logger/request logging path" tests exercise this class,
 * not a stand-in.
 */
@Injectable()
export class StructuredLoggerService implements LoggerService {
  constructor(private readonly context: ObservabilityContextService) {}

  /** Primary structured entry point — bounded, allow-listed `meta`. */
  logEvent(
    level: LogLevel,
    event: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.write(level, event, message, meta);
  }

  private write(
    level: LogLevel,
    event: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const store = this.context.get();
    const envelope: LogEnvelope = {
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      event,
      message: message.length > 1000 ? `${message.slice(0, 1000)}…` : message,
      tenantId: store?.tenantId ?? null,
      branchId: store?.branchId ?? null,
      correlationId: store?.correlationId ?? null,
      causationId: store?.causationId ?? null,
      ...sanitizeMetadata(meta),
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  }

  // ── Nest LoggerService interface — routes framework + `new Logger()` calls ──

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('debug', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.fromNest('error', message, optionalParams);
  }

  /**
   * Nest's `LoggerService` methods receive `(message, ...optionalParams)`
   * where the LAST optional param is conventionally the logger `context`
   * (e.g. the class name passed to `new Logger(ClassName.name)`), and any
   * params before it (for `.error`) may be a stack trace string. None of
   * this is structured metadata a caller controls per-field, so it is
   * treated as free text and run through the same scrub as any other
   * message — never as an allow-listed `meta` object.
   */
  private fromNest(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const nestContext =
      optionalParams.length > 0
        ? String(optionalParams[optionalParams.length - 1])
        : undefined;
    const text =
      message instanceof Error
        ? `${message.name}: ${message.message}`
        : String(message);
    this.write(
      level,
      'nest.log',
      text,
      nestContext ? { context: nestContext } : undefined,
    );
  }
}
