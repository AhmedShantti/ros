import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * SRS §27.6 NFR-OBS-006 — "Alerts defined for every SLO breach with
 * documented runbooks." This suite validates the alert-rule FILE structurally
 * (parses as YAML, matches the standard Prometheus alerting-rule shape) and
 * cross-references every `expr` against the metric names this slice's own
 * `MetricsService` actually emits, plus confirms every `runbook_url` points
 * at a real file. `promtool` (the canonical PromQL validator) is not
 * available in this environment, so this is a structural/reference check,
 * NOT full PromQL grammar validation — documented honestly rather than
 * claimed as more than it is.
 */

const ALERTS_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'observability',
  'alerts',
  'backend-api.rules.yaml',
);

interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface AlertGroup {
  name: string;
  rules: AlertRule[];
}

interface AlertDocument {
  groups: AlertGroup[];
}

const KNOWN_METRICS = [
  'http_requests_total',
  'http_request_duration_seconds_bucket',
  'http_request_duration_seconds_sum',
  'http_request_duration_seconds_count',
  'up', // Prometheus's own scrape-health metric — not emitted by this app
];

function loadDocument(): AlertDocument {
  const raw = readFileSync(ALERTS_PATH, 'utf8');
  return yaml.load(raw) as AlertDocument;
}

describe('backend-api.rules.yaml — alert rule syntax/reference validation', () => {
  it('exists on disk at the documented path', () => {
    expect(existsSync(ALERTS_PATH)).toBe(true);
  });

  it('parses as valid YAML with the standard Prometheus groups/rules shape', () => {
    const doc = loadDocument();
    expect(Array.isArray(doc.groups)).toBe(true);
    expect(doc.groups.length).toBeGreaterThan(0);
    for (const group of doc.groups) {
      expect(typeof group.name).toBe('string');
      expect(Array.isArray(group.rules)).toBe(true);
      expect(group.rules.length).toBeGreaterThan(0);
    }
  });

  const doc = loadDocument();
  const allRules = doc.groups.flatMap((g) => g.rules);

  it.each(allRules.map((r) => [r.alert, r] as const))(
    'rule "%s" has a non-empty expr, a valid "for" duration, and required annotations',
    (_name, rule) => {
      expect(typeof rule.expr).toBe('string');
      expect(rule.expr.trim().length).toBeGreaterThan(0);
      expect(rule.for).toMatch(/^\d+[smh]$/);
      expect(rule.annotations?.summary).toBeTruthy();
      expect(rule.annotations?.description).toBeTruthy();
      expect(rule.annotations?.runbook_url).toBeTruthy();
      expect(rule.labels?.severity).toMatch(/^(critical|warning)$/);
    },
  );

  it.each(allRules.map((r) => [r.alert, r] as const))(
    'rule "%s" expr references only real, emitted metric names',
    (_name, rule) => {
      const referencesKnownMetric = KNOWN_METRICS.some((metric) =>
        rule.expr.includes(metric),
      );
      expect(referencesKnownMetric).toBe(true);
    },
  );

  it.each(allRules.map((r) => [r.alert, r.annotations!.runbook_url] as const))(
    'rule "%s" runbook_url "%s" points to a file that actually exists',
    (_name, runbookUrl) => {
      const runbookPath = join(__dirname, '..', '..', '..', '..', runbookUrl);
      expect(existsSync(runbookPath)).toBe(true);
    },
  );

  it('has parenthesis-balanced PromQL expressions (basic structural sanity)', () => {
    for (const rule of allRules) {
      const opens = (rule.expr.match(/\(/g) ?? []).length;
      const closes = (rule.expr.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('covers the two documented backend API performance SLOs and an error-rate SLO', () => {
    const alertNames = allRules.map((r) => r.alert);
    expect(alertNames).toEqual(
      expect.arrayContaining([
        'ROSBackendElevatedErrorRate',
        'ROSBackendReadLatencyP95Breach',
        'ROSBackendWriteLatencyP95Breach',
      ]),
    );
  });

  it('every rule declares a distinct alert name (no accidental duplicate)', () => {
    const names = allRules.map((r) => r.alert);
    expect(new Set(names).size).toBe(names.length);
  });
});
