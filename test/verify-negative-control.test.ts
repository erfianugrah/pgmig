import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db.ts";
import { diffTableSets, upgradeVerify } from "../src/upgrade/verify.ts";

/**
 * Build a mock Db that matches SQL via regex and returns canned rows.
 * First matching regex wins; returns [] when nothing matches.
 */
function mockDb(responses: Array<{ match: RegExp; rows: unknown[] }>): Db {
  const find = (sql: string): unknown[] => {
    for (const r of responses) {
      if (r.match.test(sql)) return r.rows;
    }
    return [];
  };

  const fn = function (
    this: unknown,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> {
    const sql = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""),
      "",
    );
    return Promise.resolve(find(sql));
  } as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    unsafe<T>(sql: string, params?: unknown[]): Promise<T>;
  };
  fn.unsafe = <T>(sql: string, _params?: unknown[]): Promise<T> => Promise.resolve(find(sql) as T);
  return fn as Db;
}

// SQL fingerprints used by upgradeVerify / reconcile.
const TBL_RE = /table_schema.*table_name.*table_type.*BASE TABLE/;
const PK_RE = /pg_index.*pg_attribute.*indisprimary/;
const COLS_RE = /information_schema.columns.*is_generated/;
const AGG_RE = /abs\(hashtextextended/; // aggregate scan and drill both carry this
const EXT_RE = /SELECT extname, extversion FROM pg_extension/;
const MD5_RE = /rolcanlogin.*md5/;

describe("diffTableSets pure-function negative controls (card24)", () => {
  test("card24: missing table on target -> missingOnTarget populated", () => {
    const diff = diffTableSets(["public.users", "public.orders"], ["public.users"]);
    expect(diff.missingOnTarget).toEqual(["public.orders"]);
    expect(diff.extraOnTarget).toEqual([]);
    expect(diff.common).toEqual(["public.users"]);
  });

  test("card24: extra table on target only -> extraOnTarget populated", () => {
    const diff = diffTableSets(["public.users"], ["public.users", "public.extra"]);
    expect(diff.missingOnTarget).toEqual([]);
    expect(diff.extraOnTarget).toEqual(["public.extra"]);
    expect(diff.common).toEqual(["public.users"]);
  });

  test("card24: identical table sets -> both missing/extra empty, common full", () => {
    const diff = diffTableSets(
      ["public.users", "public.orders"],
      ["public.users", "public.orders"],
    );
    expect(diff.missingOnTarget).toEqual([]);
    expect(diff.extraOnTarget).toEqual([]);
    expect(diff.common).toEqual(["public.orders", "public.users"]);
  });

  test("card24: includeManaged keeps Supabase-managed schemas in the diff", () => {
    // auth.users is in SUPABASE_MANAGED_SCHEMAS and would be filtered out by default.
    const diff = diffTableSets(["public.users", "auth.users"], ["public.users"], {
      includeManaged: true,
    });
    expect(diff.missingOnTarget).toEqual(["auth.users"]);
    expect(diff.common).toEqual(["public.users"]);
  });
});

describe("upgradeVerify negative controls (card24)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-card24-"));

  test("card24: missing table on target -> verify FAILS", async () => {
    const src = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }, { name: "public.orders" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
      { match: EXT_RE, rows: [] },
    ]);
    const tgt = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      // reconcile runs with common=["public.users"] even after detecting the missing table;
      // target mock returns empty aggregate -> empty tMap -> mismatched bucket -> false.
    ]);
    const ok = await upgradeVerify(src, tgt, { outDir });
    expect(ok).toBe(false);
  });

  test("card24: one row changed on target -> verify FAILS", async () => {
    // Source and target have the same table but the aggregate-hash differs.
    const src = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
      { match: EXT_RE, rows: [] },
    ]);
    const tgt = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "xyz789" }] },
      { match: EXT_RE, rows: [] },
      { match: MD5_RE, rows: [] },
    ]);
    const ok = await upgradeVerify(src, tgt, { outDir });
    expect(ok).toBe(false);
  });

  test("card24: one row missing on target -> verify FAILS", async () => {
    // Same hash but row count differs.
    const src = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "2", h: "aaa111" }] },
      { match: EXT_RE, rows: [] },
    ]);
    const tgt = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "aaa111" }] },
      { match: EXT_RE, rows: [] },
      { match: MD5_RE, rows: [] },
    ]);
    const ok = await upgradeVerify(src, tgt, { outDir });
    expect(ok).toBe(false);
  });
});
