/**
 * Unit tests for src/steps/cutover.ts against fake source/target clients.
 * The drain loop and the initial-sync gate are the last checks before the
 * irreversible DROP SUBSCRIPTION, so each test asserts the DROP did or did not run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";

// engine.test.ts replaces cutover.ts process-wide via mock.module; the query suffix gives this
// file its own registry entry so it always exercises the real implementation (held in a
// variable because tsc cannot resolve a query-suffixed specifier).
const realModule = "../src/steps/cutover.ts?real";
const { cutover } = (await import(realModule)) as typeof import("../src/steps/cutover.ts");

const cfg = () =>
  ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: { tables: ["public.t"], publication: "p", slot: "s", subscription: "sub" },
    reconcile: { tables: [{ name: "public.t" }] },
    watchdog: {},
  });

/** A fake postgres.js Db: tagged-template routed by SQL text, `.unsafe` recorded. */
function fakeDb(template: (sql: string, values: unknown[]) => unknown[]) {
  const unsafeCalls: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal postgres.js shape for cutover's calls
  const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(template(strings.join(" ? "), values));
  fn.unsafe = (sql: string) => {
    unsafeCalls.push(sql);
    return Promise.resolve([]);
  };
  return { db: fn as Db, unsafeCalls };
}

/** Source with stable WAL (writes stopped), no owned sequences, and the given slot rows. */
const fakeSource = (slotRows: unknown[]) =>
  fakeDb((sql) => {
    if (sql.includes("confirmed_flush_lsn")) return slotRows;
    if (sql.includes("AS lsn")) return [{ lsn: "0/1000" }];
    return [];
  });

/** Target whose pg_subscription_rel (scoped to the configured subscription) has these states. */
const fakeTarget = (states: Record<string, number>) =>
  fakeDb((sql, values) => {
    if (sql.includes("pg_subscription_rel")) {
      if (!sql.includes("pg_subscription s") || !values.includes("sub")) return [];
      return Object.entries(states).map(([srsubstate, n]) => ({ srsubstate, n }));
    }
    return [];
  });

const dropped = (unsafeCalls: string[]) => unsafeCalls.some((s) => s.startsWith("DROP"));

describe("cutover: lag drain", () => {
  test("missing replication slot -> throws naming the slot, subscription not dropped", async () => {
    const src = fakeSource([]);
    const tgt = fakeTarget({ r: 2 });
    await expect(cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0 })).rejects.toThrow(
      /replication slot "s" not found/,
    );
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });

  test("NULL lag (confirmed_flush_lsn unset) is not drained -> times out, not dropped", async () => {
    const src = fakeSource([{ lag_bytes: null }]);
    const tgt = fakeTarget({ r: 2 });
    await expect(cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0 })).rejects.toThrow(
      /lag did not drain in time/,
    );
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });

  test("lag 0 + all tables ready -> drops the subscription", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = fakeTarget({ r: 2 });
    await cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0 });
    expect(dropped(tgt.unsafeCalls)).toBe(true);
  });
});

describe("cutover: auth rows inside the write stop (--with-auth-data)", () => {
  const authTables = ["auth.identities", "auth.refresh_tokens", "auth.users"];
  /** Target with every table 'r' and the given auth tables (schema_migrations already filtered by SQL). */
  const authTarget = (tables: string[]) =>
    fakeDb((sql, values) => {
      if (sql.includes("pg_subscription_rel"))
        return values.includes("sub") ? [{ srsubstate: "r", n: 1 }] : [];
      if (sql.includes("nspname = 'auth'")) return tables.map((t) => ({ t }));
      return [];
    });
  const dirs: string[] = [];
  const outDir = () => {
    const d = mkdtempSync(join(tmpdir(), "pgmig-cutover-auth-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("dump then restore run after the drain and before DROP SUBSCRIPTION", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = authTarget(authTables);
    const dir = outDir();
    const steps: { label: string; cmd: string[]; droppedYet: boolean }[] = [];
    await cutover(src.db, tgt.db, cfg(), {
      maxLagWaitSec: 0,
      authData: {
        sourceUrl: "postgresql://u:p@src:5432/postgres",
        targetUrl: "postgresql://u:p@tgt:5432/postgres",
        outDir: dir,
        spawn: async (st) => {
          steps.push({ ...st, droppedYet: dropped(tgt.unsafeCalls) });
        },
      },
    });
    expect(steps.map((s) => s.label)).toEqual(["dump auth data", "restore auth data"]);
    expect(steps.every((s) => !s.droppedYet)).toBe(true);
    expect(dropped(tgt.unsafeCalls)).toBe(true);
    const [dump, restore] = steps;
    expect(dump?.cmd).toContain("--exclude-table-data=auth.schema_migrations");
    expect(dump?.cmd).toContain("postgresql://u:p@src:5432/postgres");
    // one transaction: replica role first (no FK cascade, no FK check), clear, then load
    expect(restore?.cmd).toEqual([
      "psql",
      "--single-transaction",
      "--variable",
      "ON_ERROR_STOP=1",
      "--command",
      "SET session_replication_role = replica",
      "-f",
      `${dir}/cutover-auth-clear.sql`,
      "-f",
      `${dir}/cutover-auth-data.sql`,
      "-d",
      "postgresql://u:p@tgt:5432/postgres",
    ]);
    expect(readFileSync(`${dir}/cutover-auth-clear.sql`, "utf8")).toBe(
      "DELETE FROM auth.identities;\nDELETE FROM auth.refresh_tokens;\nDELETE FROM auth.users;\n",
    );
  });

  test("a failed restore throws and leaves the subscription in place", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = authTarget(authTables);
    const p = cutover(src.db, tgt.db, cfg(), {
      maxLagWaitSec: 0,
      authData: {
        sourceUrl: "postgresql://src",
        targetUrl: "postgresql://tgt",
        outDir: outDir(),
        spawn: async (st) => {
          if (st.label.startsWith("restore")) throw new Error("restore auth data failed (exit 3)");
        },
      },
    });
    await expect(p).rejects.toThrow(/auth copy failed.*subscription is still in place/);
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });

  test("a target without auth tables is refused before anything is dumped", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = authTarget([]);
    let spawned = 0;
    const p = cutover(src.db, tgt.db, cfg(), {
      maxLagWaitSec: 0,
      authData: {
        sourceUrl: "postgresql://src",
        targetUrl: "postgresql://tgt",
        outDir: outDir(),
        spawn: async () => {
          spawned++;
        },
      },
    });
    await expect(p).rejects.toThrow(/no auth tables/);
    expect(spawned).toBe(0);
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });
});

describe("cutover: initial-sync gate", () => {
  test("tables not all 'r' -> throws with counts by state, never drains or drops", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = fakeTarget({ r: 3, d: 1, s: 1 });
    const p = cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0 });
    await expect(p).rejects.toThrow(/2 of 5 table\(s\) not ready \(d=1, s=1;.*watch/);
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });

  test("no pg_subscription_rel rows for the subscription -> throws, not dropped", async () => {
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = fakeTarget({});
    await expect(cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0 })).rejects.toThrow(
      /subscription "sub" has no tables/,
    );
    expect(dropped(tgt.unsafeCalls)).toBe(false);
  });
});
