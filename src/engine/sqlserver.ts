/**
 * Minimal SQL Server client seam for the DebeziumEngine's source-side queries — the cross-engine
 * reconcile aggregate scan, the cutover write-stop gate (CDC max-LSN stability), the live doctor
 * engine-prep playbook, and the T-SQL schema translator's catalog introspection. Mirrors
 * `mysql.ts`: only the heterogeneous engine queries a SQL Server source directly.
 *
 * pgmig's `connect()` builds Postgres clients only (postgres.js), so a `sqlserver://` SOURCE_DB_URL
 * cannot be queried through the `source: Db` the ReplicationEngine interface passes — the engine
 * opens its own SQL Server connection here instead. Kept behind a tiny interface so callers can be
 * tested with an in-memory fake (no live SQL Server in the unit suite).
 */

import sql from "mssql";

export interface SqlServerConn {
  /** Run a read query, returning the result rows as plain objects. */
  query<T = Record<string, unknown>>(text: string): Promise<T[]>;
  end(): Promise<void>;
}

/**
 * Build an mssql config from a `sqlserver://user:pass@host:port/database?encrypt=true` URL.
 * `encrypt=true` turns on TLS (required for Azure SQL); `trustcert=false` disables the
 * self-signed-cert bypass (default true, which is what an on-prem/VM source with a self-signed
 * cert needs). Exported for unit tests — pure, no IO.
 */
export function sqlServerConfigFromUrl(url: string): sql.config {
  const u = new URL(url);
  if (!u.hostname) throw new Error(`SQL Server URL has no host: ${u.protocol}//…`);
  const encrypt = /[?&]encrypt=true\b/i.test(url);
  const trustCert = !/[?&]trustcert=false\b/i.test(url);
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    options: { encrypt, trustServerCertificate: trustCert },
  };
}

/** Open a SQL Server connection from a `sqlserver://user:pass@host:port/db` URL. */
export async function connectSqlServer(url: string): Promise<SqlServerConn> {
  const pool = new sql.ConnectionPool(sqlServerConfigFromUrl(url));
  await pool.connect();
  return {
    async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
      const res = await pool.request().query(text);
      return res.recordset as T[];
    },
    end: async () => {
      await pool.close();
    },
  };
}
