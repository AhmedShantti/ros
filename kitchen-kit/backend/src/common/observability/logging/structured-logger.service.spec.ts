import { ObservabilityContextService } from '../context/observability-context';
import { StructuredLoggerService } from './structured-logger.service';

function captureStdout(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  return {
    lines: () => written,
    restore: () => spy.mockRestore(),
  };
}

describe('StructuredLoggerService', () => {
  let context: ObservabilityContextService;
  let logger: StructuredLoggerService;

  beforeEach(() => {
    context = new ObservabilityContextService();
    logger = new StructuredLoggerService(context);
  });

  it('emits exactly one valid JSON line per call, with the stable envelope', () => {
    const cap = captureStdout();
    try {
      logger.logEvent('info', 'test.event', 'a message', { route: '/x' });
    } finally {
      cap.restore();
    }
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'info',
      service: 'ros-backend-api',
      event: 'test.event',
      message: 'a message',
      tenantId: null,
      branchId: null,
      correlationId: null,
      causationId: null,
      route: '/x',
    });
    expect(typeof parsed.timestamp).toBe('string');
    expect(new Date(parsed.timestamp as string).toISOString()).toBe(
      parsed.timestamp,
    );
  });

  it('includes tenantId/branchId/correlationId/causationId from the active context (NFR-OBS-001)', () => {
    const cap = captureStdout();
    let parsed: Record<string, unknown> = {};
    try {
      context.run(
        {
          correlationId: 'corr-1',
          causationId: 'cause-1',
          tenantId: 'tenant-1',
          branchId: 'branch-1',
          route: null,
          handler: null,
          method: 'GET',
          startedAtNs: process.hrtime.bigint(),
          completed: false,
        },
        () => {
          logger.logEvent('info', 'test.event', 'msg');
        },
      );
      parsed = JSON.parse(cap.lines()[0]) as Record<string, unknown>;
    } finally {
      cap.restore();
    }
    expect(parsed).toMatchObject({
      correlationId: 'corr-1',
      causationId: 'cause-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
    });
  });

  it('routes Nest LoggerService .log()/.error()/.warn()/.debug() through the same structured envelope', () => {
    const cap = captureStdout();
    let lines: string[] = [];
    try {
      logger.log('a log message', 'SomeService');
      logger.warn('a warn message', 'SomeService');
      logger.error('an error message', 'stack trace here', 'SomeService');
      logger.debug('a debug message', 'SomeService');
      lines = cap.lines();
    } finally {
      cap.restore();
    }
    expect(lines).toHaveLength(4);
    const parsedLines = lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    expect(parsedLines[0]).toMatchObject({
      level: 'info',
      message: 'a log message',
      context: 'SomeService',
    });
    expect(parsedLines[1]).toMatchObject({
      level: 'warn',
      message: 'a warn message',
      context: 'SomeService',
    });
    expect(parsedLines[2]).toMatchObject({
      level: 'error',
      message: 'an error message',
      context: 'SomeService',
    });
    expect(parsedLines[3]).toMatchObject({
      level: 'debug',
      message: 'a debug message',
      context: 'SomeService',
    });
    for (const parsed of parsedLines) {
      expect(parsed.service).toBe('ros-backend-api');
      expect(parsed.event).toBe('nest.log');
    }
  });

  it('never leaks a secret passed in metadata into the emitted JSON (real logger path sabotage)', () => {
    const cap = captureStdout();
    let raw = '';
    try {
      logger.logEvent('info', 'auth.attempt', 'login attempt', {
        route: '/auth/login',
        password: 'super-secret-password',
        accessToken: 'Bearer eyabc123def456ghi789',
        DATABASE_URL: 'postgres://user:password@host/db',
      });
      raw = cap.lines()[0];
    } finally {
      cap.restore();
    }
    expect(raw).not.toContain('super-secret-password');
    expect(raw).not.toContain('eyabc123def456ghi789');
    expect(raw).not.toContain('postgres://user:password@host/db');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.event).toBe('auth.attempt');
    expect(parsed.route).toBe('/auth/login');
  });

  it('an Error passed as the Nest .error() message is reduced to name/message text, not dumped raw', () => {
    const cap = captureStdout();
    let raw = '';
    try {
      const err = new Error('DB connection failed');
      (err as unknown as Record<string, unknown>).config = {
        password: 'db-secret-value',
      };
      logger.error(err, 'AppBootstrap');
      raw = cap.lines()[0];
    } finally {
      cap.restore();
    }
    expect(raw).not.toContain('db-secret-value');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.message).toContain('DB connection failed');
  });
});
