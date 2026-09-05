/**
 * Postgres connection-string helpers for the e2e database-isolation harness.
 * A Postgres URL parses cleanly as a WHATWG URL (host/port/credentials via
 * the generic authority grammar; the database name is the pathname).
 */

export function databaseNameFromUrl(connectionUrl: string): string {
  return new URL(connectionUrl).pathname.replace(/^\//, '');
}

export function withDatabaseName(
  connectionUrl: string,
  databaseName: string,
): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
