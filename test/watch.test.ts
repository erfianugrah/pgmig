/**
 * Unit tests for src/steps/watch.ts against fake source/target clients.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { log } from "../src/log.ts";

// engine.test.ts replaces watch.ts process-wide via mock.module; the query suffix gives this
// file its own registry entry so it always exercises the real implementation (held in a
// variable because tsc cannot resolve a query-suffixed specifier).
const realModule = "../src/steps/watch.ts?real";
const { watch } = (await import(realModule)) as typeof import("../src/steps/watch.ts");

const cfg = () => {
  const c = ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: { tables: ["public.t"], publication: "p", slot: "s", subscription: "sub" },
    reconcile: { tables: [{ name: "public.t" }] },
    watchdog: { pollIntervalSec: 1 },
  });
  // Deadline = now: a watch that does not finish on its first poll fails fast.
  c.watchdog.syncTimeoutMin = 0;
  return c;
};

// biome-ignore lint/suspicious/noExplicitAny: minimal postgres.js shape for watch's calls
function fakeDb(template: (sql: string, values: unknown[]) => unknown[]): any {
  // biome-ignore lint/suspicious/noExplicitAny: minimal postgres.js shape for watch's calls
  const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(template(strings.join(" ? "), values));
  fn.unsafe = () => Promise.resolve([]);
  return fn as Db;
}

describe("watch: sync state scoped to our subscription", () => {
  test("another subscription's copying tables do not hold up our ready subscription", async () => {
    const source = fakeDb((sql) =>
      sql.includes("pg_replication_slots")
        ? [{ retained_bytes: 0, active: true, wal_status: "reserved" }]
        : [],
    );
    const target = fakeDb((sql, values) => {
      if (!sql.includes("pg_subscription_rel")) return [];
      const scoped = sql.includes("pg_subscription s") && values.includes("sub");
      // Ours: 2 tables ready. An unrelated subscription on the same target: 3 still copying.
      return scoped
        ? [{ srsubstate: "r", n: 2 }]
        : [
            { srsubstate: "r", n: 2 },
            { srsubstate: "d", n: 3 },
          ];
    });
    await expect(watch(source, target, cfg())).resolves.toBeUndefined();
  });
});

// supabase-lab replica-routing RR12d: with the source's network restrictions blocking the
// target, the subscriber's worker kept a pid while the source had no walsender for the slot
// and new rows never arrived. A pid alone must not read as "connected".
describe("watch: worker pid without a source walsender", () => {
  const warnings: string[] = [];
  const spy = spyOn(log, "warn").mockImplementation((msg: string) => {
    warnings.push(msg);
  });
  afterEach(() => {
    warnings.length = 0;
  });

  const run = async (slotActive: boolean) => {
    const source = fakeDb((sql) =>
      sql.includes("pg_replication_slots")
        ? [{ retained_bytes: 0, active: slotActive, wal_status: "reserved" }]
        : [],
    );
    const target = fakeDb((sql) => {
      if (sql.includes("pg_subscription_rel")) return [{ srsubstate: "d", n: 1 }];
      if (sql.includes("AS workers")) return [{ workers: 1 }];
      return [];
    });
    const c = cfg();
    c.watchdog.syncTimeoutMin = 2.5 / 60; // three polls one second apart, then the deadline
    await expect(watch(source, target, c)).rejects.toThrow("sync did not complete");
  };

  test("warns when the worker has a pid but the source slot stays inactive", async () => {
    await run(false);
    expect(warnings.some((w) => w.includes("no active walsender"))).toBe(true);
  });

  test("stays quiet when the source slot is active", async () => {
    await run(true);
    expect(warnings.some((w) => w.includes("no active walsender"))).toBe(false);
    spy.mockRestore();
  });
});
