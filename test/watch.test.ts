/**
 * Unit tests for src/steps/watch.ts against fake source/target clients.
 */
import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";

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
