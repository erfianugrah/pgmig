import { describe, expect, test } from "bun:test";
import {
  assertDirectReplicationConn,
  isTransient,
  sourceConnUrl,
  withNoStatementTimeout,
} from "../src/db.ts";

// C-2: sourceConnString (libpq keyword=value) was replaced by sourceConnUrl which
// returns the raw URL for CREATE SUBSCRIPTION CONNECTION — no quoting needed
// because Postgres accepts URL format natively and percent-encoding handles special chars.
describe("sourceConnUrl", () => {
  test("prefers SOURCE_REPLICATION_URL when set", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:pw@pooler.host/db",
      TARGET_DB_URL: "postgresql://postgres:pw@target/db",
      SOURCE_REPLICATION_URL: "postgresql://postgres:pw@db.ref.supabase.co/postgres",
    });
    expect(url).toBe("postgresql://postgres:pw@db.ref.supabase.co/postgres");
  });

  test("falls back to SOURCE_DB_URL when SOURCE_REPLICATION_URL is absent", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:pw123@db.aaaa.supabase.co:5432/postgres",
      TARGET_DB_URL: "postgresql://postgres:pw@db.bbbb.supabase.co:5432/postgres",
    });
    expect(url).toBe("postgresql://postgres:pw123@db.aaaa.supabase.co:5432/postgres");
  });

  test("a password with special characters stays percent-encoded (no quoting needed)", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:p%40ss%3Aword@db.x.supabase.co/postgres",
      TARGET_DB_URL: "postgresql://u:p@t/db",
    });
    // Percent-encoded form is safe for SQL string embedding — no raw ' or spaces
    expect(url).toContain("p%40ss%3Aword");
    expect(url).not.toContain("p@ss:word");
  });
});

// The subscription's CONNECTION is dialled by the target's tablesync/apply
// workers, not by pgmig's pools, so the pools' statement_timeout=0 does not reach
// it. On a Supabase source the postgres role is capped by the 2 min global
// statement_timeout, which cancelled a >2 min initial COPY every 120 s in a
// live run (2026-11-09, 4M rows, 16 tablesync restarts, never synced).
describe("withNoStatementTimeout - subscription CONNECTION carries statement_timeout=0", () => {
  test("URL with no query string gets an options parameter", () => {
    expect(
      withNoStatementTimeout("postgresql://postgres:pw@db.ref.supabase.co:5432/postgres"),
    ).toBe(
      "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres?options=-c%20statement_timeout%3D0",
    );
  });

  test("URL with a query string gets the parameter appended", () => {
    expect(
      withNoStatementTimeout("postgresql://u:p@db.x.supabase.co/postgres?sslmode=require"),
    ).toBe(
      "postgresql://u:p@db.x.supabase.co/postgres?sslmode=require&options=-c%20statement_timeout%3D0",
    );
  });

  test("existing options keep their value and gain the timeout", () => {
    expect(
      withNoStatementTimeout(
        "postgresql://u:p@h/db?sslmode=require&options=-c%20search_path%3Dpublic",
      ),
    ).toBe(
      "postgresql://u:p@h/db?sslmode=require&options=-c%20search_path%3Dpublic%20-c%20statement_timeout%3D0",
    );
  });

  test("a URL that already sets statement_timeout is left alone", () => {
    const u = "postgresql://u:p@h/db?options=-c%20statement_timeout%3D600000";
    expect(withNoStatementTimeout(u)).toBe(u);
  });

  test("percent-encoded password survives untouched", () => {
    expect(withNoStatementTimeout("postgresql://postgres:p%40ss%3Aw%3Fd@h/db")).toBe(
      "postgresql://postgres:p%40ss%3Aw%3Fd@h/db?options=-c%20statement_timeout%3D0",
    );
  });

  test("keyword=value conninfo gets a quoted options keyword", () => {
    expect(withNoStatementTimeout("host=db.x.supabase.co dbname=postgres user=postgres")).toBe(
      "host=db.x.supabase.co dbname=postgres user=postgres options='-c statement_timeout=0'",
    );
  });
});

describe("assertDirectReplicationConn - direct-only replication invariant", () => {
  test("throws on a session-pooler CONNECTION (cannot stream WAL)", () => {
    expect(() =>
      assertDirectReplicationConn(
        "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
      ),
    ).toThrow(/pooler cannot stream|Supavisor pooler/i);
  });

  test("throws on a transaction-pooler CONNECTION too", () => {
    expect(() =>
      assertDirectReplicationConn(
        "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres",
      ),
    ).toThrow(/pooler/i);
  });

  test("passes for a direct Supabase host", () => {
    expect(() =>
      assertDirectReplicationConn("postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres"),
    ).not.toThrow();
  });

  test("passes for a plain self-hosted host (not a pooler)", () => {
    expect(() =>
      assertDirectReplicationConn("postgresql://u:p@source-host:5432/postgres"),
    ).not.toThrow();
  });
});

describe("isTransient — only connection-shaped errors are retryable", () => {
  test("connection-error messages are transient", () => {
    expect(isTransient(new Error("write CONNECTION_CLOSED"))).toBe(true);
    expect(isTransient(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransient(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransient(new Error("connect ETIMEDOUT 1.2.3.4:5432"))).toBe(true);
    expect(isTransient(new Error("write EPIPE"))).toBe(true);
  });

  test("connection-exception + admin-shutdown SQLSTATEs are transient", () => {
    expect(isTransient(Object.assign(new Error("server closed"), { code: "08006" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("conn failure"), { code: "08000" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("admin shutdown"), { code: "57P01" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("crash shutdown"), { code: "57P02" }))).toBe(true);
  });

  test("SQL errors are NOT transient (would just fail again)", () => {
    expect(isTransient(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
    expect(isTransient(Object.assign(new Error("unique violation"), { code: "23505" }))).toBe(
      false,
    );
    expect(isTransient(Object.assign(new Error("undefined table"), { code: "42P01" }))).toBe(false);
  });

  test("plain errors / non-errors are NOT transient", () => {
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient("some string")).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});
