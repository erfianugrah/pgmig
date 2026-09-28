import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import {
  type BucketRow,
  classifyRows,
  diffBuckets,
  reconcileLedger,
} from "../src/steps/reconcile.ts";

const mk = (entries: Array<[number, number, string]>): Map<number, BucketRow> =>
  new Map(entries.map(([b, n, h]) => [b, { b, n: BigInt(n), h }]));

describe("diffBuckets", () => {
  test("identical maps -> no mismatches", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    expect(diffBuckets(s, t, 2)).toEqual([]);
  });

  test("detects hash difference in a bucket", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([
      [0, 10, "h0"],
      [1, 5, "DIFFERENT"],
    ]);
    expect(diffBuckets(s, t, 2)).toEqual([1]);
  });

  test("detects a bucket missing entirely on target", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([[0, 10, "h0"]]);
    expect(diffBuckets(s, t, 2)).toEqual([1]);
  });

  test("detects count difference even when hash coincides", () => {
    const s = mk([[0, 10, "h0"]]);
    const t = mk([[0, 11, "h0"]]);
    expect(diffBuckets(s, t, 1)).toEqual([0]);
  });
});

describe("classifyRows", () => {
  test("missing, extra, and hash_diff are each detected", () => {
    const s = new Map([
      ["pk1", "a"],
      ["pk2", "b"],
      ["pk3", "c"],
    ]);
    const t = new Map([
      ["pk1", "a"],
      ["pk2", "CHANGED"],
      ["pk4", "z"],
    ]);
    const out = classifyRows(s, t, 100);
    expect(out).toContainEqual({ pk: "pk2", kind: "hash_diff" });
    expect(out).toContainEqual({ pk: "pk3", kind: "missing_on_target" });
    expect(out).toContainEqual({ pk: "pk4", kind: "extra_on_target" });
    expect(out).toHaveLength(3);
  });

  test("identical maps -> empty", () => {
    const s = new Map([["pk1", "a"]]);
    const t = new Map([["pk1", "a"]]);
    expect(classifyRows(s, t, 100)).toEqual([]);
  });

  test("respects maxExamples cap", () => {
    const s = new Map([
      ["1", "a"],
      ["2", "a"],
      ["3", "a"],
    ]);
    const t = new Map<string, string>();
    expect(classifyRows(s, t, 2)).toHaveLength(2);
  });
});

// M-4: reconcileLedger was unexported and untested. It's now exported.
// Use a mock Db that returns controlled results without a real Postgres connection.
describe("reconcileLedger", () => {
  const dir = join(tmpdir(), `pgmig-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  function makeCfg(ledgerPath: string) {
    return ConfigSchema.parse({
      source: { ref: "a".repeat(20) },
      target: { ref: "b".repeat(20) },
      replication: { tables: ["public.t"], publication: "p", slot: "s", subscription: "sub" },
      reconcile: {
        tables: [{ name: "public.t" }],
        ledgerPath,
        ledgerTable: "public.t",
        ledgerIdColumn: "id",
      },
      watchdog: { maxRetainedWalMb: 1000, pollIntervalSec: 1, syncTimeoutMin: 1 },
    });
  }

  test("empty ledger -> true without querying DB", async () => {
    const path = join(dir, "empty.log");
    writeFileSync(path, "");
    // A DB that throws if queried — should never be reached for an empty ledger.
    const throwDb = {
      unsafe: () => {
        throw new Error("DB queried on empty ledger");
      },
    } as unknown as Db;
    expect(await reconcileLedger(throwDb, makeCfg(path))).toBe(true);
  });

  test("all ids present -> true", async () => {
    const path = join(dir, "all-present.log");
    writeFileSync(path, "id1\nid2\nid3\n");
    // Mock DB returns 0 missing rows.
    const mockDb = { unsafe: async () => [{ n: 0n }] } as unknown as Db;
    expect(await reconcileLedger(mockDb, makeCfg(path))).toBe(true);
  });

  test("missing ids -> false", async () => {
    const path = join(dir, "missing.log");
    writeFileSync(path, "id1\nid2\nid3\n");
    // Mock DB reports 2 missing.
    const mockDb = { unsafe: async () => [{ n: 2n }] } as unknown as Db;
    expect(await reconcileLedger(mockDb, makeCfg(path))).toBe(false);
  });

  test("batching: large ledger is split correctly (verify SQL called with slices)", async () => {
    const ids = Array.from({ length: 25_000 }, (_, i) => `id${i}`);
    const path = join(dir, "large.log");
    writeFileSync(path, `${ids.join("\n")}\n`);
    const calls: number[] = [];
    const mockDb = {
      unsafe: async (_sql: string, params: unknown[]) => {
        calls.push((params[0] as string[]).length);
        return [{ n: 0n }];
      },
    } as unknown as Db;
    expect(await reconcileLedger(mockDb, makeCfg(path))).toBe(true);
    // 25 000 ids in batches of 10 000 -> 3 calls: 10k + 10k + 5k
    expect(calls).toEqual([10_000, 10_000, 5_000]);
  });
});
