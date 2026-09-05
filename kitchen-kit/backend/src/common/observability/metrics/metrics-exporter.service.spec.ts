import { ConfigService } from '@nestjs/config';
import { AddressInfo } from 'node:net';
import { MetricsExporterService } from './metrics-exporter.service';
import { MetricsService } from './metrics.service';

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

describe('MetricsExporterService — safe-by-default internal exposure', () => {
  it('does NOT start any listener when METRICS_PORT is unset (test/dev-safe default)', async () => {
    const metrics = new MetricsService();
    const exporter = new MetricsExporterService(metrics, configWith({}));
    exporter.onApplicationBootstrap();
    // No server means onModuleDestroy resolves trivially with nothing to close.
    await expect(exporter.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('binds to loopback by default and serves the Prometheus text format when configured', async () => {
    const metrics = new MetricsService();
    metrics.recordRequest(
      { method: 'GET', route: '/x', handler: 'X#y', statusClass: '2xx' },
      0.01,
    );
    const exporter = new MetricsExporterService(
      metrics,
      configWith({ METRICS_PORT: 0 }), // ephemeral port — no collision risk
    );
    exporter.onApplicationBootstrap();
    try {
      // Let the server finish binding.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const server = (
        exporter as unknown as { server?: import('node:http').Server }
      ).server;
      expect(server).toBeDefined();
      const port = (server!.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('http_requests_total');
    } finally {
      await exporter.onModuleDestroy();
    }
  });

  it('rejects a non-GET method', async () => {
    const metrics = new MetricsService();
    const exporter = new MetricsExporterService(
      metrics,
      configWith({ METRICS_PORT: 0 }),
    );
    exporter.onApplicationBootstrap();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const server = (
        exporter as unknown as { server?: import('node:http').Server }
      ).server;
      const port = (server!.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        method: 'POST',
      });
      expect(res.status).toBe(405);
    } finally {
      await exporter.onModuleDestroy();
    }
  });

  it('shuts down cleanly (onModuleDestroy closes the listening socket)', async () => {
    const metrics = new MetricsService();
    const exporter = new MetricsExporterService(
      metrics,
      configWith({ METRICS_PORT: 0 }),
    );
    exporter.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await exporter.onModuleDestroy();
    const server = (
      exporter as unknown as { server?: import('node:http').Server }
    ).server;
    expect(server?.listening).toBe(false);
  });
});
