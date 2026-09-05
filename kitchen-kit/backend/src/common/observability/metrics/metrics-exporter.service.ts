import { createServer, Server } from 'node:http';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';

/**
 * Metrics exposure (SRS §27.6 NFR-OBS-003 "scrapeable"; task §10).
 *
 * No admin/internal-endpoint convention exists yet in this repository (only
 * `HealthController`, a plain public controller). Exposing `/metrics` on the
 * ordinary public Nest application (which serves the documented, versioned
 * business API and Swagger UI) would put an unauthenticated,
 * high-signal-to-an-attacker endpoint on the same public surface — explicitly
 * forbidden by this task's brief. So this runs a SEPARATE, minimal raw HTTP
 * listener:
 *
 *   - not a Nest controller — never appears in the OpenAPI document, never
 *     shares a port/middleware stack with the public API;
 *   - DISABLED BY DEFAULT — starts only when `METRICS_PORT` is explicitly
 *     configured. This is what keeps G1-2's parallel/sequential Jest E2E
 *     suites (which boot many independent `AppModule` instances in the same
 *     process, some concurrently) free of port collisions: test envs never
 *     set `METRICS_PORT`, so no listener is ever created during tests;
 *   - binds to `METRICS_HOST` (default `127.0.0.1`, i.e. loopback-only —
 *     the safe default; only reachable from the same host);
 *   - responds to `GET` on any path with the Prometheus text-exposition
 *     payload; anything else gets 404/405. No auth is layered on top —
 *     loopback binding is the control. A production deployment that needs
 *     scraping from a NETWORK-visible collector must explicitly bind a
 *     non-loopback `METRICS_HOST` AND restrict reachability at the
 *     network/IaC layer (security group, firewall, service mesh policy) —
 *     that network-level restriction is an OPERATIONAL requirement this
 *     slice does not and cannot provide from application code alone.
 *   - closes cleanly on `onModuleDestroy` (matters for the same test-process
 *     reuse concern above, in the rare case a suite does opt in).
 */
@Injectable()
export class MetricsExporterService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MetricsExporterService.name);
  private server: Server | undefined;

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const portNumber = this.config.get<number>('METRICS_PORT');
    if (portNumber === undefined) {
      this.logger.log(
        'Metrics exporter disabled (METRICS_PORT not set) — this is the safe default for tests and any deployment not yet wired for scraping.',
      );
      return;
    }
    const host = this.config.get<string>('METRICS_HOST', '127.0.0.1');

    this.server = createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      this.metrics
        .metricsText()
        .then((body) => {
          res.writeHead(200, { 'content-type': this.metrics.contentType });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('metrics collection failed');
        });
    });

    this.server.listen(portNumber, host, () => {
      const address = this.server?.address();
      const boundPort =
        address && typeof address === 'object' ? address.port : portNumber;
      this.logger.log(`Metrics exporter listening on ${host}:${boundPort}`);
    });
  }

  onModuleDestroy(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}
