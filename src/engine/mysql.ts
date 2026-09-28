/**
 * Minimal MySQL client seam for the DebeziumEngine's source-side queries — the cross-engine
 * reconcile aggregate scan and the cutover write-stop gate (`SHOW MASTER STATUS`). The native-PG
 * path never needs this; only the heterogeneous engine queries a MySQL source directly.
 *
 * pgmig's `connect()` builds Postgres clients only (postgres.js), so a `mysql://` SOURCE_DB_URL
 * cannot be queried through the `source: Db` the ReplicationEngine interface passes — the engine
 * opens its own MySQL connection here instead. Kept behind a tiny interface so callers can be
 * tested with an in-memory fake (no live MySQL in the unit suite).
 */

import mysql from "mysql2/promise";

export interface MySqlConn {
  /** Run a read query, returning the result rows as plain objects. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  end(): Promise<void>;
}

/** Open a MySQL connection from a `mysql://user:pass@host:port/db` URL. */
export async function connectMySql(url: string): Promise<MySqlConn> {
  const conn = await mysql.createConnection({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const [rows] = await conn.query(sql);
      return rows as T[];
    },
    end: () => conn.end(),
  };
}
