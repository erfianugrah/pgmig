// Child-process fixture for the card24 negative controls. NOT auto-discovered
// (no .test. in the name): test/verify-negative-control.test.ts runs it with
// `bun test ./test/support/card24-rowlevel.fixture.ts` in its own process.
// Isolation matters: engine.test.ts replaces reconcile.ts process-wide via
// mock.module, so in the full suite the row-level controls would see a stub.
//
// CARD24_STUB_RECONCILE=pass replaces reconcile with a stub that always
// reports a match (the mutation `ok = ok && true`). Under that stub the
// row-level controls must FAIL, and the card24redo test shows verify wrongly
// reports PASS for a changed row.
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGG_RE, COLS_RE, EXT_RE, MD5_RE, mockDb, PK_RE, TBL_RE } from "./card24-mockdb.ts";

const stubbed = process.env.CARD24_STUB_RECONCILE === "pass";
if (stubbed) {
  const real = await import("../../src/steps/reconcile.ts");
  mock.module("../../src/steps/reconcile.ts", () => ({
    ...real,
    reconcile: async () => true,
  }));
}
const { upgradeVerify } = await import("../../src/upgrade/verify.ts");

const outDir = mkdtempSync(join(tmpdir(), "pgmig-card24r3-"));

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
    { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
    { match: EXT_RE, rows: [] },
    { match: MD5_RE, rows: [] },
  ]);
  expect(await upgradeVerify(src, tgt, { outDir })).toBe(false);
});

test("card24: one row changed on target -> verify FAILS", async () => {
  // Same table on both sides; the target's aggregate hash differs.
  const src = mockDb([
    { match: TBL_RE, rows: [{ name: "public.users" }] },
    { match: PK_RE, rows: [{ attname: "id" }] },
    { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
    { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
    { match: EXT_RE, rows: [] },
  ]);
  const tgt = mockDb([
    { match: TBL_RE, rows: [{ name: "public.users" }] },
    { match: PK_RE, rows: [{ attname: "id" }] },
    { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
    { match: AGG_RE, rows: [{ b: 0, n: "1", h: "xyz789" }] },
    { match: EXT_RE, rows: [] },
    { match: MD5_RE, rows: [] },
  ]);
  expect(await upgradeVerify(src, tgt, { outDir })).toBe(false);
});

test("card24: one row missing on target -> verify FAILS", async () => {
  // Same hash, row count differs.
  const src = mockDb([
    { match: TBL_RE, rows: [{ name: "public.users" }] },
    { match: PK_RE, rows: [{ attname: "id" }] },
    { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
    { match: AGG_RE, rows: [{ b: 0, n: "2", h: "aaa111" }] },
    { match: EXT_RE, rows: [] },
  ]);
  const tgt = mockDb([
    { match: TBL_RE, rows: [{ name: "public.users" }] },
    { match: PK_RE, rows: [{ attname: "id" }] },
    { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
    { match: AGG_RE, rows: [{ b: 0, n: "1", h: "aaa111" }] },
    { match: EXT_RE, rows: [] },
    { match: MD5_RE, rows: [] },
  ]);
  expect(await upgradeVerify(src, tgt, { outDir })).toBe(false);
});

// Runs only under the stub: the same changed-row fixture as above, but the
// comparison always says "match", so verify reports PASS for data that differs.
if (stubbed) {
  test("card24redo: stubbed comparison lets a changed row PASS (the mutation the controls must catch)", async () => {
    const src = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "abc123" }] },
      { match: EXT_RE, rows: [] },
    ]);
    const tgt = mockDb([
      { match: TBL_RE, rows: [{ name: "public.users" }] },
      { match: PK_RE, rows: [{ attname: "id" }] },
      { match: COLS_RE, rows: [{ column_name: "id" }, { column_name: "data" }] },
      { match: AGG_RE, rows: [{ b: 0, n: "1", h: "xyz789" }] },
      { match: EXT_RE, rows: [] },
      { match: MD5_RE, rows: [] },
    ]);
    expect(await upgradeVerify(src, tgt, { outDir })).toBe(true);
  });
}
