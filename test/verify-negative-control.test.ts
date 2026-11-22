import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_TABLES_SQL } from "../src/upgrade/kb.ts";
import { diffTableSets, upgradeVerify } from "../src/upgrade/verify.ts";
import { AGG_RE, COLS_RE, EXT_RE, MD5_RE, mockDb, PK_RE, TBL_RE } from "./support/card24-mockdb.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE = "./test/support/card24-rowlevel.fixture.ts";

/**
 * Run the row-level fixture in a fresh bun process. CARD24_STUB_RECONCILE=pass
 * swaps reconcile for the always-match stub (the mutation under test).
 */
async function runFixture(stub: "" | "pass"): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, "test", FIXTURE], {
    cwd: REPO_ROOT,
    env: { ...process.env, CARD24_STUB_RECONCILE: stub },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}\n${err}` };
}

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
      { match: TBL_RE, rows: [{ name: "public.users" }] }, // orders missing
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      // reconcile runs with common=["public.users"] even after detecting the missing table;
      // target mock returns empty aggregate -> empty tMap -> mismatched bucket -> false.
    ]);
    const ok = await upgradeVerify(src, tgt, { outDir });
    expect(ok).toBe(false);
  });

  // The row-level controls ('one row changed', 'one row missing') live in
  // test/support/card24-rowlevel.fixture.ts and run in a child process: the
  // engine.test.ts mock.module stub would otherwise replace reconcile here.
  test("card24r3: row-level negative controls run in an isolated process and FAIL verify", async () => {
    const r = await runFixture("");
    expect(r.out).toContain("(pass) card24: one row changed on target -> verify FAILS");
    expect(r.out).toContain("(pass) card24: one row missing on target -> verify FAILS");
    expect(r.out).toContain("(pass) card24: missing table on target -> verify FAILS");
    expect(r.out).not.toContain("(fail)");
    expect(r.code).toBe(0);
  });

  test("card24redo: stubbed reconcile comparison (ok = ok && true) makes the row-level controls FAIL", async () => {
    const r = await runFixture("pass");
    // verify reports PASS for a changed row under the stub ...
    expect(r.out).toContain("(pass) card24redo: stubbed comparison lets a changed row PASS");
    // ... so the row-level controls must catch it.
    expect(r.out).toContain("(fail) card24: one row changed on target -> verify FAILS");
    expect(r.out).toContain("(fail) card24: one row missing on target -> verify FAILS");
    // missing table does not depend on the comparison: still passes.
    expect(r.out).toContain("(pass) card24: missing table on target -> verify FAILS");
    expect(r.code).not.toBe(0);
  });
});

describe("card24redo regression: verify negative controls reach comparison", () => {
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-card24redo-"));

  test("card24redo: TBL_RE with s flag matches multi-line USER_TABLES_SQL", () => {
    // Regression: without the s flag, . does not match \n and the mock
    // returns empty arrays, so the controls never reach the comparison.
    expect(TBL_RE.test(USER_TABLES_SQL)).toBe(true);
  });

  test("card24redo: missing table fails even when reconcile would pass (stubbed comparison)", async () => {
    // Source has two tables, target is missing orders.  Provide matching
    // aggregates for public.users on both sides so reconcile would pass
    // if it ran - but verify must still FAIL because orders is missing.
    const src = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }, { name: "public.orders" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
      { match: EXT_RE, rows: [] },
    ]);
    const tgt = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
      { match: EXT_RE, rows: [] },
      { match: MD5_RE, rows: [] },
    ]);
    const ok = await upgradeVerify(src, tgt, { outDir });
    expect(ok).toBe(false);
  });
});
