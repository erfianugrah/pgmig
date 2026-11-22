import type { Db } from "../../src/db.ts";

/**
 * Build a mock Db that matches SQL via regex and returns canned rows.
 * First matching regex wins; returns [] when nothing matches.
 */
export function mockDb(responses: Array<{ match: RegExp; rows: unknown[] }>): Db {
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
export const TBL_RE = /table_schema.*table_name.*table_type.*BASE TABLE/s;
export const PK_RE = /pg_index.*pg_attribute.*indisprimary/s;
export const COLS_RE = /information_schema.columns.*is_generated/s;
export const AGG_RE = /abs\(hashtextextended/; // aggregate scan and drill both carry this
export const EXT_RE = /SELECT extname, extversion FROM pg_extension/;
export const MD5_RE = /rolcanlogin.*md5/;
