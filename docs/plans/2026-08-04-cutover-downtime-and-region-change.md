# Cutover downtime window, region-change recipe, and 100+ GiB rehearsal Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

> **Status:** OPEN. Written 2026-08-04 (commit b0fe726); **revised 2026-10-13 against ee76ef2**,
> which rewrote `src/steps/cutover.ts` (initial-sync gate, missing-slot error, NULL-lag
> handling) and added `test/cutover.test.ts`. The code tasks (1-7) were re-dry-run against
> ee76ef2; Part C (Tasks 7-12) adds the 100+ GiB rehearsal, whose live Tasks 8-12 cannot be
> dry-run. Tracking cards:
> work-pgmig#1 (Part A), work-pgmig#2 (Part B), work-pgmig#3 (Part C).

**Goal:** give pgmig a measured downtime number per cutover, persisted across runs and readable
from `status`; turn "change my project's region" into a named, sequenced recipe whose
unsolvable part (project ref + API keys) is stated instead of implied; and measure copy time,
WAL retention and both downtime mechanisms on a 100+ GiB single-table fixture.

**Architecture:** one new pure module `src/steps/downtime.ts` owns the window arithmetic and an
append-only NDJSON history under the existing `ledger/` out-dir; `cutover` writes one record at
the moment it drops the subscription; the `status` CLI action reads the history and prints a
summary. A second small module `src/steps/region.ts` compares the source and target project
regions through the Management API and prints the identity artifacts a region move never
carries; `docs/REGION-CHANGE.md` sequences the existing commands around it. Part C adds two
env knobs and the freeze mark to `test/scale.harness.ts`, then runs the scale harness and
`upgrade lab --seed-gib` at 100+ GiB and records the numbers.

**Tech Stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`), commander CLI, zod config,
biome lint/format, `bun:test` unit tests, Docker (Part C only). No new dependencies.

---

## Ground rules for whoever executes this

- Run every `bun` command with `--no-env-file`. The repo's `.env` holds sops-encrypted
  database URLs; nothing in Parts A and B needs them, and Bun auto-loads `.env` otherwise.
- Never point Parts A and B at a real database. The unit tiers use fakes; the integration
  tiers self-skip without `TEST_SOURCE_DB_URL` / `TEST_TARGET_DB_URL`.
- Part C runs Docker workloads for hours and needs hundreds of GiB of free disk. Do not start
  it before Tasks 1-3 and 7 are merged, and read Task 8's preconditions first.
- Commit steps assume the human operator commits. If a hook blocks agent commits, stage the
  listed files and hand the message over instead.

## Verified against the repo on 2026-10-13 (ee76ef2)

| Fact | Proof |
|---|---|
| Sensors are `bun run typecheck` (tsc --noEmit), `bun run lint` (biome check .), `bun test` | `package.json` scripts |
| Baseline: typecheck exit 0; lint `Checked 101 files ... No fixes applied`; tests `504 pass / 20 skip / 0 fail`, `Ran 524 tests across 36 files` | ran all three with `--no-env-file` in a scratch copy on 2026-10-13 |
| There is NO run history today. `ledger/` is a gitignored artifact dir; `logs/` is the durable log sink | `.gitignore` lines `ledger/` and `logs/` |
| `cutover()` takes `opts: { sequences?: string[]; maxLagWaitSec?: number }` and returns `Promise<void>` | `src/steps/cutover.ts:18-23` |
| `cutover` now runs, in order: opening warn (`:25`), initial-sync gate on `pg_subscription_rel` (`:30-58`), WAL-quiescence check (`:60-83`), drain loop (`:85-120`), sequence resync (`:122-158`), DISABLE / `SET (slot_name = NONE)` / DROP and the final warns (`:160-172`) | `src/steps/cutover.ts` at ee76ef2 |
| The drain loop's exit branch is `if (lag !== null && lag <= 0) {` (NULL lag = unknown, keep waiting); a missing slot row throws `replication slot "<slot>" not found on the source` | `src/steps/cutover.ts:96-117` |
| `test/cutover.test.ts` drives the real `cutover()` with fake `Db`s and imports it as `"../src/steps/cutover.ts?real"` through a variable, because `test/engine.test.ts` `mock.module()`s `cutover.ts` process-wide. Any new cutover test MUST use that same import | `test/cutover.test.ts:10-15`, `test/engine.test.ts:32-35` |
| The existing passing-cutover test (`lag 0 + all tables ready -> drops the subscription`) passes no `outDir`; once cutover writes history it would append to `./ledger/` of whatever directory `bun test` runs in. Task 2 gives it a temp dir | `test/cutover.test.ts:78-83` |
| The engine seam's `CutoverOpts` carries `outDir?: string` (`src/engine/types.ts:23`); `NativePgEngine.cutover` forwards the whole opts object; `run` passes `{ maxLagWaitSec, outDir }` | `src/engine/native-pg.ts`, `src/steps/run.ts:131-135` |
| `status()` is a pure DB read returning `StatusSnapshot`; the CLI action prints it or emits it as one JSON object | `src/steps/status.ts`; `src/cli.ts:150-163` |
| `provision` does NOT create projects; project creation with a region exists only on `MgmtApi.createProject`, used by `sandbox up` (`--src-region` / `--tgt-region`) | `src/cli.ts:370-390`, `src/cli.ts:594-602` |
| `MgmtApi.getProject(ref)` GETs `${API_BASE}/projects/${ref}` and returns the raw object, documented as carrying `status` and `region` | `src/mgmt.ts:101-106` |
| `region` is immutable per the in-repo scope doc; JWT secret + API keys are never carried | `docs/MIGRATION-SCOPE.md:107` and `:63` |
| The scale harness hardcodes `syncTimeoutMin: 60` and `maxLagWaitSec: 120`, and calls `cutover` with no write-stop mark | `test/scale.harness.ts:83,209,219` |
| `upgrade lab --seed-gib` seeds `public.documents` of `src/rehearsal/schema.sql` (has a STORED tsvector column) to size, forces the pgdg flavor, dumps it to `<work-dir>/seed-dump.sql` on the HOST, replays it, snapshots with `cp -a`, and writes `<work-dir>/upgrade-lab-report.json` | `src/upgrade/lab.ts:345-385,438-441,620-700` |
| Test import order is `bun:test`, then `node:*`, then relative | `test/config.test.ts`, `test/cutover.test.ts` |

Every CLI flag this plan mentions in a NEW form is created by this plan. Task 3 and Task 5 add
them, and each ends with a `--help` invocation that prints the flag back.

## What changed since the 2026-08-04 draft (and was fixed in this revision)

1. Task 2's drain-stamp step targeted `if (lag <= 0) {`; ee76ef2 changed it to
   `if (lag !== null && lag <= 0) {`. Fixed.
2. Task 2 claimed "No existing unit test drives `cutover()`". `test/cutover.test.ts` now does,
   and its passing test would have written `ledger/downtime-history.ndjson` into the working
   directory. Task 2 is now a TDD task that extends that file with the `?real` import pattern
   and gives every DROP-reaching test a temp `outDir`.
3. Task 2 had no test of its own. It now has four, including one that fails if the drain mark
   is deleted and one that fails if the record write can fail a successful cutover.
4. `cd /path/to/pgmig` placeholders replaced with repo-root commands; all `bun` commands carry
   `--no-env-file`.
5. Baseline counts updated (504 pass / 20 skip / 524 tests / 36 files; lint 101 files).
6. Task 6 did not touch `README.md`, which is the single entry point and documents every
   `cutover` / `status` flag. It now updates the README command reference too, and the link
   check is the repo's own dirname-relative loop (the old one missed README-relative links).
7. Per-task commit steps restored (the 2026-08-04 "no commits this session" constraint was
   session-scoped).
8. Part C (Tasks 7-12, card work-pgmig#3) is new.

## Dry-run status

2026-10-13, against ee76ef2: Tasks 1-7 applied verbatim (code blocks extracted from this file by
script, exact-match replace) to a tar copy of the repo outside git, `node_modules` symlinked
back, no `.env`. Baseline -> after Task 7: tests `504 pass / 20 skip / 0 fail` (524 tests, 36
files) -> `542 pass / 20 skip / 0 fail` (562 tests, 38 files); typecheck exit 0 -> exit 0; lint
`Checked 101 files` -> `Checked 105 files`, `No fixes applied` both times. Full detail, the
defects found, and what stays unverifiable are at the end of Self-review.

## Why not just extend an existing artifact

- **Why not add the window to the `reconcile` JSON report.** `reconcile` is read-only and is
  run BEFORE the freeze (RUNBOOK step 9b) as well as after. The window's start is the freeze
  and its end is the subscription drop, both of which are `cutover`'s business.
- **Why not extend `StatusSnapshot`.** `status()` takes two `Db` handles and touches no
  filesystem. Its shape is the contract for `status --json`, which the RUNBOOK positions as a
  scheduled watcher. Adding a disk read inside it means a poll loop starts failing when
  `ledger/` is absent, the normal state on a fresh checkout. The CLI action composes the two
  reads instead.
- **Why a single append-only NDJSON file rather than `ledger/<step>-<ts>.json`.** Those are
  per-run snapshots nothing reads back. The downtime number's value is the trend: rehearsal
  1..N, then production. NDJSON appends without a read-modify-write, so a crashed cutover
  cannot truncate earlier history.
- **Why not a target-region flag on `provision`.** `provision` PATCHes addons on a target that
  already exists, and region is immutable after creation. The honest hook is an assertion:
  read both regions and say whether the move is actually cross-region.
- **Why the upgrade-lab numbers do not go into the NDJSON history.** The history records
  logical-replication cutover windows (freeze -> subscription dropped). `pg_upgrade` downtime is
  a different mechanism with its own per-run report (`prepSec` / `pgUpgradeSec` /
  `analyzeSec`); mixing them would make the history's median meaningless. Part C records the
  cutover window through the history (the scale harness calls the real `cutover`) and the
  upgrade timings through `upgrade-lab-report.json`, and copies both into the RUNBOOK because
  `ledger/` and `.upgrade-lab/` are gitignored.

## File structure

| Path | Responsibility |
|---|---|
| `src/steps/downtime.ts` | CREATE - pure window arithmetic, NDJSON history append/parse/read, summary + renderer |
| `test/downtime.test.ts` | CREATE - unit tests for every function in `downtime.ts` |
| `src/steps/cutover.ts` | MODIFY - stamp the marks, append one history record, log the window |
| `test/cutover.test.ts` | MODIFY - temp `outDir` for DROP-reaching tests, slowable fake, four downtime-record tests |
| `src/engine/types.ts` | MODIFY - add `writeStoppedAt?: number` to `CutoverOpts` |
| `src/cli.ts` | MODIFY - `cutover --write-stopped-at`, `status --out-dir` + downtime summary, new `region-check` command |
| `src/steps/region.ts` | CREATE - region verdict (pure) + Management-API fetch + renderer |
| `test/region.test.ts` | CREATE - unit tests for the verdict, the region reader, and the fetch path |
| `docs/REGION-CHANGE.md` | CREATE - the named recipe, including what it cannot solve |
| `docs/RUNBOOK.md` | MODIFY - link the recipe, freeze timestamp in step 9, command-reference rows; Part C results table |
| `docs/MIGRATION-SCOPE.md` | MODIFY - point row 5 at the recipe |
| `README.md` | MODIFY - command reference for `cutover`, `status`, `region-check` |
| `test/scale.harness.ts` | MODIFY - `SYNC_TIMEOUT_MIN` / `MAX_LAG_WAIT_SEC` env knobs, operator write-stop mark under `WRITE_LOAD` |

---

# Part A - measure and persist cutover downtime (work-pgmig#1)

### Task 1: the downtime module (pure arithmetic + NDJSON history)

**Files:**
- Create: `src/steps/downtime.ts`
- Test: `test/downtime.test.ts`

- [ ] **Step 1: Write the failing test.** Create `test/downtime.test.ts`:

```ts
/**
 * Unit tests for src/steps/downtime.ts - the cutover downtime window.
 * The window is the only number backing pgmig's "near-zero-downtime" claim,
 * so its arithmetic is pure and pinned here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDowntimeRecord,
  type CutoverMarks,
  computeWindow,
  downtimeHistoryPath,
  formatMs,
  parseDowntimeHistory,
  readDowntimeHistory,
  renderDowntimeHistory,
  summarizeDowntimeHistory,
} from "../src/steps/downtime.ts";

const T0 = Date.parse("2026-08-04T09:00:00.000Z");

function marks(over: Partial<CutoverMarks> = {}): CutoverMarks {
  return {
    writeStoppedAt: T0,
    writeStopSource: "operator",
    lagDrainedAt: T0 + 4_000,
    targetWritableAt: T0 + 6_500,
    ...over,
  };
}

describe("computeWindow", () => {
  test("splits the window into drain + finalize and totals them", () => {
    const w = computeWindow(marks());
    expect(w.drainMs).toBe(4_000);
    expect(w.finalizeMs).toBe(2_500);
    expect(w.totalMs).toBe(6_500);
    expect(w.writeStoppedAt).toBe("2026-08-04T09:00:00.000Z");
    expect(w.targetWritableAt).toBe("2026-08-04T09:00:06.500Z");
  });

  test("an operator-supplied write-stop is not a lower bound", () => {
    expect(computeWindow(marks()).lowerBound).toBe(false);
  });

  test("falling back to cutover start marks the window as a lower bound", () => {
    const w = computeWindow(marks({ writeStopSource: "cutover-start" }));
    expect(w.lowerBound).toBe(true);
  });

  test("a zero-length window is legal (all three marks identical)", () => {
    const w = computeWindow({
      writeStoppedAt: T0,
      writeStopSource: "operator",
      lagDrainedAt: T0,
      targetWritableAt: T0,
    });
    expect(w.totalMs).toBe(0);
    expect(w.drainMs).toBe(0);
    expect(w.finalizeMs).toBe(0);
  });

  test("rejects marks that run backwards", () => {
    expect(() => computeWindow(marks({ lagDrainedAt: T0 - 1 }))).toThrow(/not in order/);
    expect(() => computeWindow(marks({ targetWritableAt: T0 + 1 }))).toThrow(/not in order/);
  });

  test("rejects a non-finite mark instead of emitting NaN", () => {
    expect(() => computeWindow(marks({ lagDrainedAt: Number.NaN }))).toThrow(/finite/);
  });
});

describe("formatMs", () => {
  test("sub-second stays in milliseconds", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(850)).toBe("850ms");
  });
  test("seconds get one decimal", () => {
    expect(formatMs(1_500)).toBe("1.5s");
    expect(formatMs(59_940)).toBe("59.9s");
  });
  test("a minute or more gets m + s", () => {
    expect(formatMs(60_000)).toBe("1m 0.0s");
    expect(formatMs(61_500)).toBe("1m 1.5s");
  });
});

describe("parseDowntimeHistory", () => {
  const good = JSON.stringify({
    ...computeWindow(marks()),
    recordedAt: "x",
    targetRef: "r",
    subscription: "s",
  });

  test("reads one record per line", () => {
    expect(parseDowntimeHistory(`${good}\n${good}\n`)).toHaveLength(2);
  });
  test("skips blank lines and unparseable lines instead of throwing", () => {
    expect(parseDowntimeHistory(`\n${good}\n{not json\n\n`)).toHaveLength(1);
  });
  test("skips a JSON line that is not a record (no numeric totalMs)", () => {
    expect(parseDowntimeHistory(`{"totalMs":"6500"}\n[]\nnull\n`)).toHaveLength(0);
  });
  test("empty input is an empty history, not a record", () => {
    expect(parseDowntimeHistory("")).toEqual([]);
  });
});

describe("append + read round trip", () => {
  test("appends NDJSON, creates the dir, and reads back in order", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pgmig-dt-")), "ledger");
    const base = { recordedAt: "2026-08-04T09:00:07.000Z", targetRef: "ref", subscription: "sub" };
    const p1 = appendDowntimeRecord(dir, { ...computeWindow(marks()), ...base });
    appendDowntimeRecord(dir, {
      ...computeWindow(marks({ targetWritableAt: T0 + 9_000 })),
      ...base,
    });
    expect(p1).toBe(downtimeHistoryPath(dir));
    const hist = readDowntimeHistory(dir);
    expect(hist.map((r) => r.totalMs)).toEqual([6_500, 9_000]);
  });

  test("reading a directory with no history yields an empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "pgmig-dt-empty-"));
    expect(readDowntimeHistory(dir)).toEqual([]);
  });

  test("a partially corrupt history file still yields the good records", () => {
    const dir = mkdtempSync(join(tmpdir(), "pgmig-dt-corrupt-"));
    const rec = JSON.stringify({
      ...computeWindow(marks()),
      recordedAt: "x",
      targetRef: "r",
      subscription: "s",
    });
    writeFileSync(downtimeHistoryPath(dir), `${rec}\ntruncated-line`);
    expect(readDowntimeHistory(dir)).toHaveLength(1);
  });
});

describe("summarizeDowntimeHistory", () => {
  const rec = (totalMs: number) => ({
    ...computeWindow(marks({ targetWritableAt: T0 + totalMs })),
    recordedAt: "x",
    targetRef: "r",
    subscription: "s",
  });

  test("no records means no summary", () => {
    expect(summarizeDowntimeHistory([])).toBeNull();
  });

  test("odd count takes the middle value as the median", () => {
    const s = summarizeDowntimeHistory([rec(9_000), rec(5_000), rec(7_000)]);
    expect(s).not.toBeNull();
    expect(s?.count).toBe(3);
    expect(s?.medianTotalMs).toBe(7_000);
    expect(s?.bestTotalMs).toBe(5_000);
    expect(s?.worstTotalMs).toBe(9_000);
    expect(s?.lastTotalMs).toBe(7_000);
  });

  test("even count averages the two middle values", () => {
    const s = summarizeDowntimeHistory([rec(5_000), rec(6_000), rec(8_000), rec(9_000)]);
    expect(s?.medianTotalMs).toBe(7_000);
  });

  test("last is the most recently appended record, not the smallest", () => {
    const s = summarizeDowntimeHistory([rec(5_000), rec(20_000)]);
    expect(s?.lastTotalMs).toBe(20_000);
  });
});

describe("renderDowntimeHistory", () => {
  test("does not throw on an empty history", () => {
    expect(() => renderDowntimeHistory([])).not.toThrow();
  });
  test("does not throw on a history containing a lower-bound record", () => {
    const r = {
      ...computeWindow(marks({ writeStopSource: "cutover-start" })),
      recordedAt: "x",
      targetRef: "r",
      subscription: "s",
    };
    expect(() => renderDowntimeHistory([r])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run (repo root): `bun --no-env-file test test/downtime.test.ts`
Expected: FAIL at module resolution, not at an assertion:
`error: Cannot find module '../src/steps/downtime.ts'`.

- [ ] **Step 3: Implement.** Create `src/steps/downtime.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { log } from "../log.ts";

/**
 * The cutover downtime window - the number that backs the "near-zero-downtime"
 * claim. It is bounded by two events:
 *
 *   START  application writes to the SOURCE stop (the freeze).
 *   END    the TARGET is free to accept writes, i.e. the moment `cutover`
 *          finishes dropping the subscription.
 *
 * pgmig observes the END directly. It does NOT observe the START: the freeze
 * is an application-tier act that happens before the command is invoked (see
 * RUNBOOK step 9a). So the operator passes it, and when they do not, the window
 * falls back to cutover's own start time and is flagged `lowerBound: true` -
 * the real outage was longer by however long the operator took to run it.
 *
 * The tail after END - repointing the app, redeploying, DNS - is outside the
 * tool entirely and is NOT in this number. Say so when you quote it.
 */

/** Where the write-stop timestamp came from. */
export type WriteStopSource = "operator" | "cutover-start";

/** Raw epoch-millisecond marks taken by `cutover`. */
export interface CutoverMarks {
  writeStoppedAt: number;
  writeStopSource: WriteStopSource;
  /** replication lag reached zero */
  lagDrainedAt: number;
  /** subscription dropped; the target is free to take writes */
  targetWritableAt: number;
}

export interface DowntimeWindow {
  writeStoppedAt: string;
  lagDrainedAt: string;
  targetWritableAt: string;
  writeStopSource: WriteStopSource;
  /** writeStoppedAt to lagDrainedAt */
  drainMs: number;
  /** lagDrainedAt to targetWritableAt (sequence resync + subscription drop) */
  finalizeMs: number;
  totalMs: number;
  /** true when the start was inferred from cutover's own start time */
  lowerBound: boolean;
}

/** One line of the history file. */
export interface DowntimeRecord extends DowntimeWindow {
  recordedAt: string;
  targetRef: string;
  subscription: string;
}

export interface DowntimeSummary {
  count: number;
  lastTotalMs: number;
  bestTotalMs: number;
  worstTotalMs: number;
  medianTotalMs: number;
}

const HISTORY_FILE = "downtime-history.ndjson";

/** Pure: where the append-only history lives under an out-dir. */
export function downtimeHistoryPath(outDir: string): string {
  return `${outDir}/${HISTORY_FILE}`;
}

/**
 * Pure: turn three marks into a window. Throws rather than emitting NaN or a
 * negative duration - a downtime number that is silently wrong is worse than
 * no number, because it is the one figure that gets quoted.
 */
export function computeWindow(m: CutoverMarks): DowntimeWindow {
  for (const [name, v] of [
    ["writeStoppedAt", m.writeStoppedAt],
    ["lagDrainedAt", m.lagDrainedAt],
    ["targetWritableAt", m.targetWritableAt],
  ] as const) {
    if (!Number.isFinite(v)) throw new Error(`downtime mark ${name} is not finite (${v})`);
  }
  if (m.lagDrainedAt < m.writeStoppedAt || m.targetWritableAt < m.lagDrainedAt) {
    throw new Error(
      `downtime marks are not in order: writeStoppedAt=${m.writeStoppedAt} ` +
        `lagDrainedAt=${m.lagDrainedAt} targetWritableAt=${m.targetWritableAt}`,
    );
  }
  return {
    writeStoppedAt: new Date(m.writeStoppedAt).toISOString(),
    lagDrainedAt: new Date(m.lagDrainedAt).toISOString(),
    targetWritableAt: new Date(m.targetWritableAt).toISOString(),
    writeStopSource: m.writeStopSource,
    drainMs: m.lagDrainedAt - m.writeStoppedAt,
    finalizeMs: m.targetWritableAt - m.lagDrainedAt,
    totalMs: m.targetWritableAt - m.writeStoppedAt,
    lowerBound: m.writeStopSource === "cutover-start",
  };
}

/** Pure: human duration. Sub-second stays in ms so a fast cutover is not rounded to "0.0s". */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  return `${min}m ${((ms - min * 60_000) / 1_000).toFixed(1)}s`;
}

/**
 * Pure: parse the NDJSON history. Tolerant by construction - a cutover killed
 * mid-append leaves a truncated last line, and that must not make the whole
 * history unreadable.
 */
export function parseDowntimeHistory(text: string): DowntimeRecord[] {
  const out: DowntimeRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    if (typeof (parsed as { totalMs?: unknown }).totalMs !== "number") continue;
    out.push(parsed as DowntimeRecord);
  }
  return out;
}

/** Append one record. Creates the out-dir. Returns the history path. */
export function appendDowntimeRecord(outDir: string, rec: DowntimeRecord): string {
  mkdirSync(outDir, { recursive: true });
  const path = downtimeHistoryPath(outDir);
  appendFileSync(path, `${JSON.stringify(rec)}\n`);
  return path;
}

/** Read the history for an out-dir. A missing file is an empty history, not an error. */
export function readDowntimeHistory(outDir: string): DowntimeRecord[] {
  const path = downtimeHistoryPath(outDir);
  if (!existsSync(path)) return [];
  return parseDowntimeHistory(readFileSync(path, "utf8"));
}

/** Pure: last / best / worst / median across recorded windows. Null when there are none. */
export function summarizeDowntimeHistory(records: DowntimeRecord[]): DowntimeSummary | null {
  const last = records.at(-1);
  if (!last) return null;
  const sorted = records.map((r) => r.totalMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return {
    count: sorted.length,
    lastTotalMs: last.totalMs,
    bestTotalMs: sorted[0] ?? 0,
    worstTotalMs: sorted.at(-1) ?? 0,
    medianTotalMs: sorted.length % 2 === 1 ? hi : (lo + hi) / 2,
  };
}

/** Print the recorded windows. Used by the `status` CLI action. */
export function renderDowntimeHistory(records: DowntimeRecord[]): void {
  const s = summarizeDowntimeHistory(records);
  if (!s) {
    log.detail("downtime: no cutover recorded yet");
    return;
  }
  const last = records.at(-1);
  log.detail(
    `downtime: last ${formatMs(s.lastTotalMs)} | best ${formatMs(s.bestTotalMs)} | ` +
      `median ${formatMs(s.medianTotalMs)} | worst ${formatMs(s.worstTotalMs)} ` +
      `(${s.count} cutover(s))`,
  );
  if (last) {
    log.detail(
      `  last: drain ${formatMs(last.drainMs)} + finalize ${formatMs(last.finalizeMs)}, ` +
        `writes stopped ${last.writeStoppedAt}, target writable ${last.targetWritableAt}`,
    );
    if (last.lowerBound) {
      log.detail(
        "  last window is a LOWER BOUND (write-stop inferred from cutover start) - " +
          "record the real freeze time on the next run",
      );
    }
  }
}
```

- [ ] **Step 4: Run the tests and the sensors.**

Run: `bun --no-env-file test test/downtime.test.ts && bun --no-env-file run typecheck && bun --no-env-file run lint`
Expected: `22 pass`, `0 fail` from the downtime file; `tsc --noEmit` exit 0; biome
`Checked 103 files ... No fixes applied.` The named-import order in the test is biome's
organize-imports order (`type CutoverMarks` before `computeWindow`); retyping it
alphabetically fails `bun run lint`.

- [ ] **Step 5: Commit.**

```bash
git add src/steps/downtime.ts test/downtime.test.ts
git commit -m "feat(downtime): pure cutover downtime window and NDJSON history"
```

---

### Task 2: stamp the marks in `cutover` and write the record

**Files:**
- Modify: `src/engine/types.ts:23` (inside `CutoverOpts`)
- Modify: `src/steps/cutover.ts:4` (imports), `:22` (opts), `:25` (clock), `:113-116` (drain), `:168-171` (record)
- Test: `test/cutover.test.ts` (whole file replaced; the five existing tests keep their assertions)

- [ ] **Step 1: Write the failing tests.** Replace the whole of `test/cutover.test.ts` with the
      content below. Compared with ee76ef2 it (a) adds the `node:*` imports and
      `readDowntimeHistory`, (b) adds `tmpOut()`, (c) lets `fakeDb` / `fakeTarget` slow each
      `.unsafe` call, (d) passes `outDir: tmpOut()` to the one existing test that reaches the
      DROP, so no test writes into `./ledger`, and (e) adds the `cutover: downtime record` block.
      Keep the `?real` import: `test/engine.test.ts` replaces `cutover.ts` process-wide via
      `mock.module`, and a plain import here would test the stub.

```ts
/**
 * Unit tests for src/steps/cutover.ts against fake source/target clients.
 * The drain loop and the initial-sync gate are the last checks before the
 * irreversible DROP SUBSCRIPTION, so each test asserts the DROP did or did not run.
 * The downtime-record tests pin the one line cutover appends to the history file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { readDowntimeHistory } from "../src/steps/downtime.ts";

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

/** A fresh history dir per test, so a cutover that reaches the DROP never writes ./ledger. */
const tmpOut = () => mkdtempSync(join(tmpdir(), "pgmig-cutover-"));

/** A fake postgres.js Db: tagged-template routed by SQL text, `.unsafe` recorded (and slowable). */
function fakeDb(template: (sql: string, values: unknown[]) => unknown[], unsafeDelayMs = 0) {
  const unsafeCalls: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal postgres.js shape for cutover's calls
  const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(template(strings.join(" ? "), values));
  fn.unsafe = async (sql: string) => {
    unsafeCalls.push(sql);
    if (unsafeDelayMs > 0) await new Promise((r) => setTimeout(r, unsafeDelayMs));
    return [];
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

/**
 * Target whose pg_subscription_rel (scoped to the configured subscription) has these states.
 * `unsafeDelayMs` slows each DISABLE / SET / DROP so the finalize phase has a measurable length.
 */
const fakeTarget = (states: Record<string, number>, unsafeDelayMs = 0) =>
  fakeDb((sql, values) => {
    if (sql.includes("pg_subscription_rel")) {
      if (!sql.includes("pg_subscription s") || !values.includes("sub")) return [];
      return Object.entries(states).map(([srsubstate, n]) => ({ srsubstate, n }));
    }
    return [];
  }, unsafeDelayMs);

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
    await cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0, outDir: tmpOut() });
    expect(dropped(tgt.unsafeCalls)).toBe(true);
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

describe("cutover: downtime record", () => {
  test("operator write-stop -> one window appended, drain and finalize both measured", async () => {
    const outDir = tmpOut();
    const src = fakeSource([{ lag_bytes: "0" }]);
    // 50ms per DISABLE / SET / DROP -> finalize >= 150ms, so a missing drain mark shows up.
    const tgt = fakeTarget({ r: 2 }, 50);
    const writeStoppedAt = Date.now() - 5_000;
    await cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0, outDir, writeStoppedAt });
    const hist = readDowntimeHistory(outDir);
    expect(hist).toHaveLength(1);
    const [rec] = hist;
    expect(rec?.writeStopSource).toBe("operator");
    expect(rec?.lowerBound).toBe(false);
    expect(rec?.writeStoppedAt).toBe(new Date(writeStoppedAt).toISOString());
    expect(rec?.targetRef).toBe("b".repeat(20));
    expect(rec?.subscription).toBe("sub");
    expect(rec?.drainMs).toBeGreaterThanOrEqual(5_000);
    expect(rec?.finalizeMs).toBeGreaterThanOrEqual(100);
    expect((rec?.drainMs ?? 0) + (rec?.finalizeMs ?? 0)).toBe(rec?.totalMs ?? -1);
  });

  test("no write-stop mark -> lower-bound window starting at cutover's own start", async () => {
    const outDir = tmpOut();
    const before = Date.now();
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = fakeTarget({ r: 2 });
    await cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0, outDir });
    const [rec] = readDowntimeHistory(outDir);
    expect(rec?.writeStopSource).toBe("cutover-start");
    expect(rec?.lowerBound).toBe(true);
    expect(Date.parse(rec?.writeStoppedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  test("an unrecordable window (write-stop after the drop) still completes the cutover", async () => {
    const outDir = tmpOut();
    const src = fakeSource([{ lag_bytes: "0" }]);
    const tgt = fakeTarget({ r: 2 });
    const p = cutover(src.db, tgt.db, cfg(), {
      maxLagWaitSec: 0,
      outDir,
      writeStoppedAt: Date.now() + 3_600_000,
    });
    await expect(p).resolves.toBeUndefined();
    expect(dropped(tgt.unsafeCalls)).toBe(true);
    expect(readDowntimeHistory(outDir)).toEqual([]);
  });

  test("a refused cutover records nothing", async () => {
    const outDir = tmpOut();
    const src = fakeSource([]);
    const tgt = fakeTarget({ r: 2 });
    await expect(cutover(src.db, tgt.db, cfg(), { maxLagWaitSec: 0, outDir })).rejects.toThrow(
      /not found/,
    );
    expect(readDowntimeHistory(outDir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify the new behaviour is missing.**

Run: `bun --no-env-file test test/cutover.test.ts`
Expected: `7 pass`, `2 fail`. The two failures are
`operator write-stop -> one window appended, ...` (`Expected length: 1` / `Received length: 0`)
and `no write-stop mark -> lower-bound window ...` (`Expected: "cutover-start"` /
`Received: undefined`). The last two downtime tests PASS at this point by design: they are
guards. `an unrecordable window ...` is proven wired by Step 5's mutant 2; `a refused cutover
records nothing` guards against a future edit that moves the record write above the gates
(no mutant of Step 3's code can fail it, because nothing is written before the drop). `bun run typecheck` is also red here (`outDir` / `writeStoppedAt` are not
in cutover's option type yet); Step 3 fixes that.

- [ ] **Step 3: Implement.** Five edits.

(a) In `src/engine/types.ts`, inside `CutoverOpts`. The file has TWO `outDir?: string;` lines
(`ReconcileOpts` at `:12`, `CutoverOpts` at `:23`), so anchor on the comment above the second.
Replace:

```ts
   * reconcile/verify out-dir; defaults to `ledger`. Ignored by the native-PG engine.
   */
  outDir?: string;
}
```

with:

```ts
   * reconcile/verify out-dir; defaults to `ledger`. Ignored by the native-PG engine.
   */
  outDir?: string;
  /**
   * Epoch ms at which application writes to the SOURCE were actually stopped (RUNBOOK 9a).
   * Sets the START of the recorded downtime window. Omit it and the window falls back to
   * cutover's own start time and is recorded as a LOWER BOUND.
   */
  writeStoppedAt?: number;
}
```

(b) In `src/steps/cutover.ts`, insert after `import { log } from "../log.ts";`:

```ts
import { appendDowntimeRecord, type CutoverMarks, computeWindow, formatMs } from "./downtime.ts";
```

One line, in exactly that order - biome keeps it on one line (it fits 100 columns) and sorts
`type CutoverMarks` before `computeWindow`.

Then replace the options parameter:

```ts
  opts: { sequences?: string[]; maxLagWaitSec?: number },
```

with:

```ts
  opts: {
    sequences?: string[];
    maxLagWaitSec?: number;
    outDir?: string;
    writeStoppedAt?: number;
  },
```

(c) Start the clock. Immediately after the opening warn line (the one beginning
`log.warn("Assuming application writes to the SOURCE`), insert:

```ts

  // Downtime clock. The freeze itself happens before this command runs, so the
  // operator-supplied write-stop is the true start; cutoverStartedAt is the
  // lower-bound fallback. lagDrainedAt is filled by the drain loop below.
  const cutoverStartedAt = Date.now();
  let lagDrainedAt = 0;
```

(d) Stamp the drain. In the drain loop, replace:

```ts
    if (lag !== null && lag <= 0) {
      log.ok("lag drained to zero");
      break;
    }
```

with:

```ts
    if (lag !== null && lag <= 0) {
      lagDrainedAt = Date.now();
      log.ok("lag drained to zero");
      break;
    }
```

(e) Close the window and record it. Replace the final block:

```ts
  log.ok(`dropped subscription ${subscription}`);
  log.warn(
    "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
  );
```

with:

```ts
  const targetWritableAt = Date.now();
  log.ok(`dropped subscription ${subscription}`);

  // Record the window. A failure here must never fail a cutover that already
  // succeeded - the subscription is gone and the target is live either way.
  try {
    const marks: CutoverMarks = {
      writeStoppedAt: opts.writeStoppedAt ?? cutoverStartedAt,
      writeStopSource: opts.writeStoppedAt === undefined ? "cutover-start" : "operator",
      lagDrainedAt: lagDrainedAt || targetWritableAt,
      targetWritableAt,
    };
    const w = computeWindow(marks);
    const path = appendDowntimeRecord(opts.outDir ?? "ledger", {
      ...w,
      recordedAt: new Date().toISOString(),
      targetRef: cfg.target.ref,
      subscription,
    });
    log.ok(
      `downtime window ${formatMs(w.totalMs)} ` +
        `(drain ${formatMs(w.drainMs)} + finalize ${formatMs(w.finalizeMs)}) -> ${path}`,
    );
    if (w.lowerBound) {
      log.warn(
        "downtime window is a LOWER BOUND: it starts when cutover started, not when you froze " +
          "writes. Pass the freeze timestamp next time. It also EXCLUDES the app " +
          "repoint/redeploy that follows.",
      );
    }
  } catch (e) {
    log.warn(`downtime window not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }

  log.warn(
    "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
  );
```

The `lagDrainedAt || targetWritableAt` fallback matters: `lagDrainedAt` stays 0 only if the
loop exits without taking the mark, and a 0 there would compute a 56-year window.

- [ ] **Step 4: Run the tests and the sensors.**

Run: `bun --no-env-file test test/cutover.test.ts && bun --no-env-file run typecheck && bun --no-env-file run lint && bun --no-env-file test`
Expected: cutover file `9 pass`, `0 fail`; typecheck exit 0; biome
`Checked 103 files ... No fixes applied.`; full suite `530 pass`, `20 skip`, `0 fail`,
`Ran 550 tests across 37 files`. `test/engine.test.ts` still passes unchanged: it only asserts
the engine forwards whatever opts it is given.

- [ ] **Step 5: Mutation-check the two guards and the drain mark.** Each of these must turn a
      test red; restore the line after each.

1. Delete `lagDrainedAt = Date.now();` from the drain loop -> `operator write-stop -> ...`
   fails on `finalizeMs` (`Expected: >= 100`, `Received: 0`).
2. Replace `} catch (e) {` ... its warn ... `}` with a rethrow (`} catch (e) { throw e; }`) ->
   `an unrecordable window ... still completes the cutover` fails (promise rejected with
   `downtime marks are not in order`).
3. Change `opts.writeStoppedAt === undefined ? "cutover-start" : "operator"` to always
   `"operator"` -> `no write-stop mark -> lower-bound ...` fails.

Run after each: `bun --no-env-file test test/cutover.test.ts` (expect `1 fail`), then restore and
re-run (expect `9 pass`).

- [ ] **Step 6: Commit.**

```bash
git add src/engine/types.ts src/steps/cutover.ts test/cutover.test.ts
git commit -m "feat(cutover): record the downtime window at subscription drop"
```

---

### Task 3: expose the window on `cutover` and `status`

**Files:**
- Modify: `src/cli.ts:31` (import), `:150-163` (status), `:254-271` (cutover)

- [ ] **Step 1: Add the cutover flag and parse it.** In `src/cli.ts`, in the `cutover` command
      block, replace:

```ts
  .option(
    "--out-dir <path>",
    "directory holding the translated-schema sign-off manifest (heterogeneous sources)",
    "ledger",
  )
  .action((o) =>
    withDb(({ source, target }, cfg) =>
      engineFor(cfg).cutover(source, target, cfg, {
        maxLagWaitSec: Number(o.maxLagWait),
        outDir: o.outDir,
      }),
    ),
  );
```

with:

```ts
  .option(
    "--out-dir <path>",
    "directory for the sign-off manifest (heterogeneous sources) and the downtime history",
    "ledger",
  )
  .option(
    "--write-stopped-at <iso>",
    "ISO 8601 timestamp at which you stopped application writes to the SOURCE (RUNBOOK 9a). " +
      "Sets the START of the recorded downtime window; without it the window is a lower bound",
  )
  .action((o) => {
    let writeStoppedAt: number | undefined;
    if (typeof o.writeStoppedAt === "string") {
      const t = Date.parse(o.writeStoppedAt);
      if (Number.isNaN(t)) {
        log.err(
          `--write-stopped-at '${o.writeStoppedAt}' is not a parseable timestamp ` +
            "(use ISO 8601, e.g. 2026-08-04T09:15:00Z)",
        );
        process.exitCode = 1;
        return;
      }
      writeStoppedAt = t;
    }
    return withDb(({ source, target }, cfg) =>
      engineFor(cfg).cutover(source, target, cfg, {
        maxLagWaitSec: Number(o.maxLagWait),
        outDir: o.outDir,
        writeStoppedAt,
      }),
    );
  });
```

- [ ] **Step 2: Read the history in `status`.** In the `status` command block, replace:

```ts
  .option("--require-synced", "exit non-zero unless all tables are ready", false)
  .action((o) => {
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const snap = await status(source, target, cfg);
      if (o.json) process.stdout.write(`${JSON.stringify(snap)}\n`);
      else printStatus(snap);
      if (o.requireSynced && !snap.tables.allReady) process.exitCode = 1;
    });
  });
```

with:

```ts
  .option("--require-synced", "exit non-zero unless all tables are ready", false)
  .option("--out-dir <path>", "directory holding the cutover downtime history", "ledger")
  .action((o) => {
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const snap = await status(source, target, cfg);
      // The downtime history is a filesystem read, deliberately kept OUT of
      // status() so the DB snapshot stays pure and cannot fail on a missing
      // ledger dir.
      const history = readDowntimeHistory(String(o.outDir));
      if (o.json) {
        process.stdout.write(
          `${JSON.stringify({ ...snap, downtime: summarizeDowntimeHistory(history) })}\n`,
        );
      } else {
        printStatus(snap);
        renderDowntimeHistory(history);
      }
      if (o.requireSynced && !snap.tables.allReady) process.exitCode = 1;
    });
  });
```

- [ ] **Step 3: Add the import.** In the import block of `src/cli.ts`, add immediately after
      `import { doctor } from "./steps/doctor.ts";`:

```ts
import {
  readDowntimeHistory,
  renderDowntimeHistory,
  summarizeDowntimeHistory,
} from "./steps/downtime.ts";
```

- [ ] **Step 4: Run the sensors and prove the flags exist.** None of these opens a database
      connection: `--help` exits before any action, and the bad-timestamp case returns before
      `withDb`.

Run:
```bash
bun --no-env-file run typecheck && bun --no-env-file run lint && bun --no-env-file test
bun --no-env-file src/cli.ts cutover --help | grep -- --write-stopped-at
bun --no-env-file src/cli.ts status --help | grep -- --out-dir
bun --no-env-file src/cli.ts --no-env-file --no-log-file cutover --write-stopped-at not-a-date; echo "exit=$?"
```
Expected: typecheck exit 0; biome `Checked 103 files ... No fixes applied.`; suite
`530 pass / 20 skip / 0 fail`; the cutover help line `--write-stopped-at <iso>`; the status help
line `--out-dir <path>`; the last command prints
`--write-stopped-at 'not-a-date' is not a parseable timestamp (use ISO 8601, e.g. 2026-08-04T09:15:00Z)`
and `exit=1`.

- [ ] **Step 5: Commit.**

```bash
git add src/cli.ts
git commit -m "feat(cli): cutover --write-stopped-at and the downtime readout in status"
```

---

# Part B - region change as a named recipe (work-pgmig#2)

### Task 4: the region verdict module

**Files:**
- Create: `src/steps/region.ts`
- Test: `test/region.test.ts`

- [ ] **Step 1: Write the failing test.** Create `test/region.test.ts`:

```ts
/**
 * Unit tests for src/steps/region.ts. A region change is a project-to-project
 * migration, so the only thing pgmig can assert automatically is that the
 * target really is in a different region - and that the identity artifacts
 * (ref + keys) do not travel. Both are pinned here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import { MgmtApi } from "../src/mgmt.ts";
import {
  planRegionCheck,
  REGION_CHANGE_NEVER_CARRIED,
  readRegion,
  regionCheck,
  renderRegionReport,
} from "../src/steps/region.ts";

const SRC = "a".repeat(20);
const TGT = "b".repeat(20);

const cfg = ConfigSchema.parse({
  source: { ref: SRC },
  target: { ref: TGT },
  replication: { tables: ["public.docs"] },
  reconcile: { tables: [{ name: "public.docs" }] },
  watchdog: {},
});

describe("readRegion", () => {
  test("takes a non-empty string region", () => {
    expect(readRegion({ region: "eu-west-1" })).toBe("eu-west-1");
  });
  test("treats a missing, empty, or non-string region as unknown", () => {
    expect(readRegion({})).toBeNull();
    expect(readRegion({ region: "" })).toBeNull();
    expect(readRegion({ region: 5 })).toBeNull();
    expect(readRegion({ region: null })).toBeNull();
  });
});

describe("planRegionCheck", () => {
  test("different regions is a cross-region move", () => {
    const r = planRegionCheck(SRC, TGT, "eu-central-1", "eu-west-1");
    expect(r.verdict).toBe("cross-region");
    expect(r.sourceRegion).toBe("eu-central-1");
    expect(r.targetRegion).toBe("eu-west-1");
  });
  test("identical regions is NOT a region change", () => {
    expect(planRegionCheck(SRC, TGT, "eu-west-1", "eu-west-1").verdict).toBe("same-region");
  });
  test("either region unreadable makes the verdict unknown, never a false green", () => {
    expect(planRegionCheck(SRC, TGT, null, "eu-west-1").verdict).toBe("unknown");
    expect(planRegionCheck(SRC, TGT, "eu-west-1", null).verdict).toBe("unknown");
    expect(planRegionCheck(SRC, TGT, null, null).verdict).toBe("unknown");
  });
  test("carries both refs through for the renderer", () => {
    const r = planRegionCheck(SRC, TGT, "eu-central-1", "eu-west-1");
    expect(r.sourceRef).toBe(SRC);
    expect(r.targetRef).toBe(TGT);
  });
});

describe("REGION_CHANGE_NEVER_CARRIED", () => {
  test("names the identity artifacts a new project always mints fresh", () => {
    const joined = REGION_CHANGE_NEVER_CARRIED.join(" | ").toLowerCase();
    expect(joined).toContain("project ref");
    expect(joined).toContain("jwt");
    expect(joined).toContain("api key");
  });
});

describe("renderRegionReport", () => {
  for (const verdict of ["cross-region", "same-region", "unknown"] as const) {
    test(`does not throw for a ${verdict} report`, () => {
      const r =
        verdict === "cross-region"
          ? planRegionCheck(SRC, TGT, "eu-central-1", "eu-west-1")
          : verdict === "same-region"
            ? planRegionCheck(SRC, TGT, "eu-west-1", "eu-west-1")
            : planRegionCheck(SRC, TGT, null, null);
      expect(() => renderRegionReport(r)).not.toThrow();
    });
  }
});

describe("regionCheck against a mocked Management API", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockProjects(bySuffix: Record<string, unknown>): void {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      const key = Object.keys(bySuffix).find((k) => u.endsWith(k));
      if (key === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(bySuffix[key]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  test("reads both regions and reports cross-region", async () => {
    mockProjects({
      [SRC]: { status: "ACTIVE_HEALTHY", region: "eu-central-1" },
      [TGT]: { status: "ACTIVE_HEALTHY", region: "eu-west-1" },
    });
    const r = await regionCheck(new MgmtApi("sbp_test"), cfg);
    expect(r.verdict).toBe("cross-region");
    expect(r.sourceRegion).toBe("eu-central-1");
    expect(r.targetRegion).toBe("eu-west-1");
  });

  test("a project payload with no region field yields unknown, not a crash", async () => {
    mockProjects({
      [SRC]: { status: "ACTIVE_HEALTHY" },
      [TGT]: { status: "ACTIVE_HEALTHY", region: "eu-west-1" },
    });
    const r = await regionCheck(new MgmtApi("sbp_test"), cfg);
    expect(r.verdict).toBe("unknown");
    expect(r.sourceRegion).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun --no-env-file test test/region.test.ts`
Expected: FAIL with `error: Cannot find module '../src/steps/region.ts'`.

- [ ] **Step 3: Implement.** Create `src/steps/region.ts`:

```ts
import { type Config, supabaseSourceRef } from "../config.ts";
import { log } from "../log.ts";
import type { MgmtApi } from "../mgmt.ts";

/**
 * Region change has no in-place mechanism: a project's region is fixed at
 * creation (docs/MIGRATION-SCOPE.md, Project Settings -> General). The real
 * procedure is "create a new project in the target region and migrate into it",
 * which is exactly the pipeline the rest of this tool implements. See
 * docs/REGION-CHANGE.md for the full recipe.
 *
 * The one thing pgmig can assert automatically is that the move is actually
 * cross-region - a target accidentally created in the SOURCE's region passes
 * every other gate in the tool and still leaves you where you started.
 */

export type RegionVerdict = "cross-region" | "same-region" | "unknown";

export interface RegionReport {
  sourceRef: string;
  targetRef: string;
  sourceRegion: string | null;
  targetRegion: string | null;
  verdict: RegionVerdict;
}

/**
 * Identity artifacts a project-to-project move never carries. Sourced from
 * docs/MIGRATION-SCOPE.md section C row 5 and the Data API rows of the
 * dashboard map: a new project mints new signing material, by design.
 */
export const REGION_CHANGE_NEVER_CARRIED: readonly string[] = [
  "project ref (the API hostname and connection host both change)",
  "JWT signing secret",
  "anon / service_role API keys",
  "auth signing keys (the JWKS the project publishes)",
];

/**
 * Pure: read the region off a raw project payload. Defensive on purpose - the
 * field is not part of any type this repo owns, so an absent or non-string
 * value must degrade to "unknown" rather than assert a region that is not there.
 */
export function readRegion(project: Record<string, unknown>): string | null {
  const r = project.region;
  return typeof r === "string" && r !== "" ? r : null;
}

/** Pure: the verdict. Unknown when either side could not be read - never a false green. */
export function planRegionCheck(
  sourceRef: string,
  targetRef: string,
  sourceRegion: string | null,
  targetRegion: string | null,
): RegionReport {
  const verdict: RegionVerdict =
    sourceRegion === null || targetRegion === null
      ? "unknown"
      : sourceRegion === targetRegion
        ? "same-region"
        : "cross-region";
  return { sourceRef, targetRef, sourceRegion, targetRegion, verdict };
}

export function renderRegionReport(r: RegionReport): void {
  log.step("region-check");
  log.detail(`source ${r.sourceRef}: region ${r.sourceRegion ?? "unknown"}`);
  log.detail(`target ${r.targetRef}: region ${r.targetRegion ?? "unknown"}`);
  if (r.verdict === "cross-region") {
    log.ok(`cross-region move: ${r.sourceRegion} -> ${r.targetRegion}`);
  } else if (r.verdict === "same-region") {
    log.warn(
      `both projects are in ${r.sourceRegion}. This migration will NOT change the region - ` +
        "region is fixed at project creation, so the target has to be created in the region " +
        "you want (docs/REGION-CHANGE.md).",
    );
  } else {
    log.warn(
      "could not read the region of one or both projects from the Management API - " +
        "confirm both regions in the dashboard before you commit to the migration window.",
    );
  }
  log.info("--- never carried by a project-to-project move ---");
  for (const item of REGION_CHANGE_NEVER_CARRIED) log.detail(item);
  log.detail(
    "Every existing user session invalidates at cutover and the app must ship new keys. " +
      "See docs/REGION-CHANGE.md.",
  );
}

/** Fetch both project payloads and produce the verdict. */
export async function regionCheck(api: MgmtApi, cfg: Config): Promise<RegionReport> {
  const sourceRef = supabaseSourceRef(cfg);
  const targetRef = cfg.target.ref;
  const [src, tgt] = await Promise.all([api.getProject(sourceRef), api.getProject(targetRef)]);
  return planRegionCheck(sourceRef, targetRef, readRegion(src), readRegion(tgt));
}
```

- [ ] **Step 4: Run the tests and the sensors.**

Run: `bun --no-env-file test test/region.test.ts && bun --no-env-file run typecheck && bun --no-env-file run lint`
Expected: `12 pass`, `0 fail`; typecheck exit 0; biome `Checked 105 files ... No fixes applied.`
As in Task 1, the named-import order in the test is biome's (`REGION_CHANGE_NEVER_CARRIED`
before `readRegion`), not alphabetical.

- [ ] **Step 5: Mutation-check the fail-closed verdict.** In `planRegionCheck`, change
      `sourceRegion === null || targetRegion === null` to `sourceRegion === null`. Run
      `bun --no-env-file test test/region.test.ts`: expect `either region unreadable ...` to fail.
      Restore and re-run: `12 pass`.

- [ ] **Step 6: Commit.**

```bash
git add src/steps/region.ts test/region.test.ts
git commit -m "feat(region): cross-region verdict and the never-carried identity list"
```

---

### Task 5: the `region-check` command

**Files:**
- Modify: `src/cli.ts:33` (import), after the `provision` command block (`:370-390`)

- [ ] **Step 1: Add the import.** In the import block of `src/cli.ts`, add immediately after
      `import { provision } from "./steps/provision.ts";` (biome sorts by module path, and
      `./steps/region.ts` sorts between `provision` and `run`):

```ts
import { regionCheck, renderRegionReport } from "./steps/region.ts";
```

- [ ] **Step 2: Add the command.** Insert this block immediately after the closing `});` of the
      `provision` command and before the `program` line that starts
      `.command("claim <orgSlug> <token>")`:

```ts
program
  .command("region-check")
  .description(
    "compare SOURCE and TARGET project regions and list what a project-to-project move never carries",
  )
  .option(
    "--require-different",
    "exit non-zero unless the target is in a DIFFERENT region from the source",
    false,
  )
  .option("--json", "emit the region report as a single JSON object on stdout", false)
  .action((o) => {
    if (o.json) log.toStderr();
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    api
      .assertAccess([supabaseSourceRef(cfg), cfg.target.ref])
      .then(() => regionCheck(api, cfg))
      .then((r) => {
        if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`);
        else renderRegionReport(r);
        // Fail CLOSED on 'unknown': a region we could not read is not evidence
        // that the move is cross-region.
        if (o.requireDifferent && r.verdict !== "cross-region") process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

```

- [ ] **Step 3: Run the sensors and prove the command exists.** `--help` never reaches
      `loadSecrets`, so no token is needed.

Run:
```bash
bun --no-env-file run typecheck && bun --no-env-file run lint && bun --no-env-file test
bun --no-env-file src/cli.ts --help | grep region-check
bun --no-env-file src/cli.ts region-check --help
```
Expected: typecheck exit 0; biome `Checked 105 files ... No fixes applied.`; suite
`542 pass / 20 skip / 0 fail`, `Ran 562 tests across 38 files`; the top-level help lists
`region-check`; its own help lists `--require-different` and `--json`.

- [ ] **Step 4: Commit.**

```bash
git add src/cli.ts
git commit -m "feat(cli): region-check command"
```

---

### Task 6: the region-change recipe and the doc wiring

**Files:**
- Create: `docs/REGION-CHANGE.md`
- Modify: `docs/RUNBOOK.md:359-361` (safety-net bullet), `:366-375` (step 9 block), `:582,589,594` (command reference)
- Modify: `docs/MIGRATION-SCOPE.md:63` (section C row 5)
- Modify: `README.md` command reference (`cutover`, `status`, after `provision`)

- [ ] **Step 1: Write the recipe.** Create `docs/REGION-CHANGE.md`:

````markdown
# Region change

Changing a Supabase project's region has no in-place mechanism. Region is fixed when the
project is created (see the Project Settings table in
[MIGRATION-SCOPE.md](MIGRATION-SCOPE.md): "immutable; region is chosen when you create the
target"). The real procedure is: **create a new project in the target region and migrate the
old project into it**, which is the pipeline the rest of this tool implements.

This page is that pipeline, sequenced for the region case, plus the part it cannot solve.

## What this recipe does and does not solve

| Half of the problem | Status |
|---|---|
| Row data moved with a short write freeze | solved - `replicate` / `watch` / `reconcile` / `cutover` |
| Schema, roles, extensions, auth row data | solved - `bootstrap` (RUNBOOK step 6) |
| Project config: auth, realtime, PostgREST, storage settings, pooler | solved - `config-sync` |
| Billable infra: compute, disk, PITR, IPv4, backup schedule | solved - `provision` |
| Edge Function code and project secrets | solved - `functions`, `config-sync` (`projectSecrets`) |
| Storage objects | solved - `storage` |
| Post-move health gate | solved - `verify` |
| The target is actually in a different region | solved - `region-check` |
| **Project ref, API keys, JWT signing secret** | **not solvable.** New project, new signing material, by design |

That last row is why "just change the region" is not a checkbox for anyone with a shipped
mobile app: the API hostname and the anon key are compiled into builds already on user
devices, and every existing session's JWT was signed with a secret the new project does not
have.

## The identity change, precisely

[MIGRATION-SCOPE.md](MIGRATION-SCOPE.md) section C row 5 states it: the JWT signing secret and
the anon / service_role API keys are **never** carried, by design. `config-sync` copies auth
configuration but excludes the signing material - `src/config.ts` says so at the
`configSync.secrets` flag, and the PostgREST section excludes `jwt_secret` for the same
reason. Auth signing keys have their own endpoint and are deliberately not copied either.

The consequences, in the order they hit you:

1. **The project ref changes.** The API URL and the database host both contain it. Every
   client, server, CI secret, webhook URL and third-party callback that hardcodes the old ref
   must be updated.
2. **The anon and service_role keys change.** Anything holding the old anon key gets a 401
   against the new project.
3. **Every existing session is invalid.** Refresh tokens are rows in `auth.refresh_tokens` and
   DO migrate, but the access tokens signed by the old project's secret do not verify against
   the new project's keys. Users re-authenticate.
4. **Anything that cannot be redeployed is stranded.** A web app redeploys in minutes. A
   mobile build with the URL and anon key baked in is gated on app-store review and on users
   actually updating.

### Two mitigations - UNVERIFIED

There are two mitigations commonly proposed for the stranded-client problem:

- A **stable custom domain** in front of the project, so the API hostname that clients
  hardcode survives the ref change and only the DNS/edge target moves.
- A **trusted external token issuer** (the third-party-auth path: Firebase / Auth0 / Cognito /
  Clerk), so the tokens clients present were never signed by the project's own secret and
  therefore survive the move.

**Neither is verified by anything in this repo, and the pairing is not verified at all.** What
this repo does contain is: custom domain is listed as manual and DNS-coupled
(MIGRATION-SCOPE.md section C row 21, endpoints under `/custom-hostname/*`), and third-party
auth is a `config-sync` opt-in (`thirdPartyAuth`, `/config/auth/third-party-auth`, additive,
keyed by issuer/JWKS URL). That both exist is not evidence that combining them makes a region
change transparent to a shipped client.

To settle it, run this on a throwaway pair before you rely on it:

1. `pgmig sandbox up --org <id>` to get two projects.
2. Attach a custom domain to the source and point a test client at the custom hostname only.
3. Configure a third-party issuer on both projects and mint a token from that issuer.
4. Run the recipe below end to end, repoint the custom domain at the target, and check
   whether the unchanged client still authenticates with the same token and the same
   hostname - without an app update.
5. Record the result here with the date, and delete the sentence above.

Until that experiment exists, quote the mitigation as untested.

## The recipe

Full detail for each step is in [RUNBOOK.md](RUNBOOK.md); this is the region-specific
sequencing and the extra gates.

```bash
# 0. Rehearse on throwaway infrastructure. Region moves are not special here - the
#    rehearsal proves the pipeline and gives you a downtime number to plan the window with.
bun start rehearse integration

# 1. Create the target project IN THE TARGET REGION. This is the only step that
#    decides the region, and it cannot be changed afterwards. Confirm the region has
#    capacity at the compute size you need before you commit to a date.
#    (RUNBOOK step 4 lists the region identifiers.)

# 2. Point migrate.config.yaml + .env at the new target (RUNBOOK step 5), then assert
#    the target really is somewhere else. Fails closed if either region is unreadable.
bun start region-check --require-different

# 3. Match the billable tier BEFORE the freeze - a target smaller than the source
#    will not survive the post-cutover load. Preview first.
bun start provision
bun start provision --confirm

# 4. Prepare the target: extensions, roles, schema, auth row data.
bun start doctor --source-only
bun start bootstrap
bun start bootstrap --confirm

# 5. Readiness gate, then replication.
bun start doctor
bun start preflight
bun start replicate
bun start watch

# 6. Freeze writes on the source. Note the exact timestamp - it is the start of your
#    downtime window and the only number that proves the "near-zero" claim.
date -u +%Y-%m-%dT%H:%M:%SZ

# 7. Verify, then cut over. Pass the freeze timestamp so the recorded window covers
#    the real outage instead of only the part pgmig was present for.
bun start reconcile
bun start cutover --write-stopped-at 2026-08-04T09:15:00Z

# 8. Copy the non-data surface.
bun start config-sync --dry-run
bun start config-sync
bun start functions
bun start storage ./storage-objects

# 9. Repoint the app: new project ref, new anon key, new service_role key, new database
#    URL. Users will re-authenticate. See "The identity change, precisely" above.

# 10. Health gate, then read the recorded downtime window back.
bun start verify
bun start status

# 11. Drop the replication objects.
bun start teardown
```

## What a region move does not give you

[MIGRATION-SCOPE.md](MIGRATION-SCOPE.md) has a section titled "A region move is not data
residency". Read it before promising anyone a compliance outcome: Storage objects sit behind a
global CDN, Realtime is a globally distributed cluster, Edge Functions deploy globally, and
platform telemetry lands in a backend whose storage region is independent of the database
region. A region move relocates the database, not everything derived from it.

If the driver is read latency rather than residency, the same document notes that a read
replica in the target region is an interim option that keeps the primary where it is.

## The downtime number

`cutover` records one line per run into `ledger/downtime-history.ndjson` and `status` prints
last / best / median / worst across all recorded runs. The window it records starts when
writes stopped and ends when the subscription was dropped, i.e. when the target was free to
take writes. It does NOT include repointing and redeploying the app. Quote it with that
boundary attached.
````

- [ ] **Step 2: Link the recipe from the runbook safety-net checklist.** In `docs/RUNBOOK.md`,
      replace:

```
- **JWT secret / API keys are NEVER copied.** Existing user sessions will invalidate after
  cutover. Your application must use the new project's keys. Update env vars before
  repointing the app.
```

with:

```
- **JWT secret / API keys are NEVER copied.** Existing user sessions will invalidate after
  cutover. Your application must use the new project's keys. Update env vars before
  repointing the app. If this migration is a region change, read
  [REGION-CHANGE.md](REGION-CHANGE.md) first.
```

- [ ] **Step 3: Record the freeze time in the step-9 block.** In `docs/RUNBOOK.md`, in the
      fenced bash block of section 9, replace:

```bash
# 9a. STOP application writes to the SOURCE (put the app in read-only / take it down).
#     This is the only moment of downtime.
```

with:

```bash
# 9a. STOP application writes to the SOURCE (put the app in read-only / take it down).
#     This is the only moment of downtime. Record the exact instant - it is the start
#     of the downtime window you will publish:
date -u +%Y-%m-%dT%H:%M:%SZ
```

and replace:

```bash
# 9c. drain replication lag to zero and drop the subscription:
bun start cutover                     # default waits up to 300s for lag to drain
#   (override: bun start cutover --max-lag-wait 600)
```

with:

```bash
# 9c. drain replication lag to zero and drop the subscription. Pass the 9a timestamp so
#     the recorded downtime window covers the real outage, not just this command:
bun start cutover --write-stopped-at 2026-08-04T09:15:00Z
#   (override the drain wait: bun start cutover --max-lag-wait 600)
#   cutover appends the window to ledger/downtime-history.ndjson; `bun start status`
#   prints last / best / median / worst across every recorded cutover.
```

- [ ] **Step 4: Update the RUNBOOK command reference.** In the "Command reference (this tool)"
      table, replace this row:

```
| `bun start status [--json] [--require-synced]` | one-shot replication snapshot (sub state, srsubstate, slot active, WAL retained, lag) for a scheduled watcher |
```

with:

```
| `bun start status [--json] [--require-synced] [--out-dir P]` | one-shot replication snapshot (sub state, srsubstate, slot active, WAL retained, lag) for a scheduled watcher, plus the recorded cutover downtime windows from `P/downtime-history.ndjson` |
```

replace this row:

```
| `bun start cutover [--max-lag-wait SEC] [--out-dir P]` | drain lag to 0, resync owned sequences, drop subscription |
```

with:

```
| `bun start cutover [--max-lag-wait SEC] [--out-dir P] [--write-stopped-at ISO]` | drain lag to 0, resync owned sequences, drop subscription, and append the downtime window to `P/downtime-history.ndjson` |
```

and insert this row immediately after the `bun start provision [--confirm]` row:

```
| `bun start region-check [--require-different] [--json]` | compare SOURCE and TARGET project regions and list what a project-to-project move never carries; with the flag, exit non-zero unless the regions differ |
```

- [ ] **Step 5: Point migration scope at the recipe.** In `docs/MIGRATION-SCOPE.md`, section C
      row 5 ends with `app must re-key + users re-login |`. The row contains an em-dash in an
      earlier column, so edit the ASCII tail with `sd` rather than retyping the row:

```bash
sd 'app must re-key \+ users re-login \|' \
   'app must re-key + users re-login. Region change is the common case: see [REGION-CHANGE.md](REGION-CHANGE.md). |' \
   docs/MIGRATION-SCOPE.md
```

- [ ] **Step 6: Update the README command reference.** In `README.md`, replace the cutover
      block's comment + command lines:

```
# Drain lag to 0, resync owned sequences, drop subscription.
# --max-lag-wait <sec>: seconds to wait for lag to drain (default: 300)
# --out-dir <path>: directory holding the translated-schema sign-off manifest (default: ledger)
bun start cutover
```

with:

```
# Drain lag to 0, resync owned sequences, drop subscription, record the downtime window.
# --max-lag-wait <sec>: seconds to wait for lag to drain (default: 300)
# --out-dir <path>: sign-off manifest + downtime history directory (default: ledger)
# --write-stopped-at <iso>: when you stopped app writes (start of the recorded window)
bun start cutover --write-stopped-at 2026-08-04T09:15:00Z
```

replace the status block's lines:

```
# One-shot replication snapshot for a scheduled watcher.
# --json: emit a single JSON object on stdout
# --require-synced: exit non-zero unless all tables are ready
bun start status --json
```

with:

```
# One-shot replication snapshot for a scheduled watcher, plus the recorded cutover
# downtime windows (last / best / median / worst).
# --json: emit a single JSON object on stdout (downtime summary under "downtime")
# --require-synced: exit non-zero unless all tables are ready
# --out-dir <path>: directory holding the downtime history (default: ledger)
bun start status --json
```

and replace (the old text includes the closing fence of the README's provision block):

````
# Copy billable infra (compute size, PITR/IPv4, disk, backup schedule).
# Preview by default; --confirm applies (changes the bill).
bun start provision --confirm
```
````

with:

````
# Copy billable infra (compute size, PITR/IPv4, disk, backup schedule).
# Preview by default; --confirm applies (changes the bill).
bun start provision --confirm
```

```bash
# Compare SOURCE and TARGET project regions; list what a project move never carries.
# --require-different: exit non-zero unless the regions differ (fails closed on unknown)
# --json: emit the region report as JSON on stdout
# Region change recipe: docs/REGION-CHANGE.md
bun start region-check --require-different
```
````

- [ ] **Step 7: Run the sensors and the repo's link check.**

Run:
```bash
bun --no-env-file run typecheck && bun --no-env-file run lint && bun --no-env-file test
for f in README.md docs/*.md; do d=$(dirname "$f"); rg -o '\]\(([^)#]+)' -r '$1' "$f" | while read -r t; do case "$t" in http*|mailto:*|\{*) continue;; esac; [ -f "$d/$t" ] || [ -f "$t" ] || echo "broken link in $f: $t"; done; done
rg -c 'region-check|write-stopped-at' README.md docs/RUNBOOK.md docs/REGION-CHANGE.md
```
Expected: sensors unchanged from Task 5 (`542 pass / 20 skip / 0 fail`; biome
`Checked 105 files`); no `broken link` lines; every one of the three files reports a non-zero
count. Biome ignores `.md` here, so the link loop is the markdown-side check.

- [ ] **Step 8: Commit.**

```bash
git add docs/REGION-CHANGE.md docs/RUNBOOK.md docs/MIGRATION-SCOPE.md README.md
git commit -m "docs: region-change recipe, freeze timestamp in cutover, downtime readout"
```

---

# Part C - 100+ GiB single-table rehearsal (work-pgmig#3)

**Why:** the scale harness has been exercised up to roughly 10M rows / single-digit GiB. A
realistic large database has a 100+ GiB largest table with a heavy STORED generated column.
Unknown at that size: initial-copy time, peak WAL retained by the slot against the default
`watchdog.maxRetainedWalMb` (2048, `src/config.ts:98`), the logical-replication cutover window,
and `pg_upgrade --link` downtime. This part measures them on throwaway Docker infrastructure
and writes them down.

**What a dry run can and cannot prove here.** Task 7 is code and is verified by typecheck +
lint (the harness is not a unit test; importing it connects to a database). Tasks 8-12 are a
live run: Docker, hundreds of GiB of disk, hours of wall clock. Nothing in them can be
verified ahead of time; each step names what to read and where it is recorded.

**Order:** Tasks 1-3 and 7 merged first (the scale harness calls the real `cutover`, so the
history file only fills once Task 2 is in). Run Task 9 and Task 10 sequentially, never in
parallel: their disk peaks do not add up that way.

### Task 7: scale-harness knobs for a 100+ GiB run

**Files:**
- Modify: `test/scale.harness.ts:36-37` (doc), `:56` (env), `:83` (watchdog), `:186-219` (cutover calls)

At 100+ GiB the initial copy can outlast the hardcoded 60-minute `syncTimeoutMin`, and the
post-load drain can outlast `maxLagWaitSec: 120`. Under `WRITE_LOAD` the harness knows the exact
instant writes stopped, so it passes that as the operator write-stop and the recorded window is
not a lower bound.

- [ ] **Step 1: Make the change.** In `test/scale.harness.ts`:

(a) Replace the tunables doc line:

```ts
 * Tunables: WATCHDOG_MB (default 2048 under load, 8 in WATCHDOG_FIRE),
 *   WRITE_INTERVAL_MS (default 4), WRITE_AFTER_SEC (default 5), BLOAT_ROWS (4000).
```

with:

```ts
 * Tunables: WATCHDOG_MB (default 2048 under load, 8 in WATCHDOG_FIRE),
 *   WRITE_INTERVAL_MS (default 4), WRITE_AFTER_SEC (default 5), BLOAT_ROWS (4000),
 *   SYNC_TIMEOUT_MIN (default 60), MAX_LAG_WAIT_SEC (default 120) - raise both for 100+ GiB.
```

(b) Immediately after the line `const BLOAT_ROWS = Number(process.env.BLOAT_ROWS ?? 4000);`,
insert:

```ts
const SYNC_TIMEOUT_MIN = Number(process.env.SYNC_TIMEOUT_MIN ?? 60);
const MAX_LAG_WAIT_SEC = Number(process.env.MAX_LAG_WAIT_SEC ?? 120);
```

(c) Replace:

```ts
  watchdog: { maxRetainedWalMb: WATCHDOG_MB, pollIntervalSec: 2, syncTimeoutMin: 60 },
```

with:

```ts
  watchdog: {
    maxRetainedWalMb: WATCHDOG_MB,
    pollIntervalSec: 2,
    syncTimeoutMin: SYNC_TIMEOUT_MIN,
  },
```

(d) In `migration()`, replace:

```ts
  let writeStats = "";
  if (writerP) {
```

with:

```ts
  let writeStats = "";
  // The instant the writers have actually stopped: the START of the recorded downtime window.
  let writeStoppedAt: number | undefined;
  if (writerP) {
```

and replace:

```ts
    const a = (await auditP) ?? { ins: 0, upd: 0, del: 0 };
```

with:

```ts
    const a = (await auditP) ?? { ins: 0, upd: 0, del: 0 };
    writeStoppedAt = Date.now();
```

(e) Still in `migration()`, replace BOTH occurrences of:

```ts
    await cutover(source, target, cfg, { maxLagWaitSec: 120 });
```

with:

```ts
    await cutover(source, target, cfg, { maxLagWaitSec: MAX_LAG_WAIT_SEC, writeStoppedAt });
```

Leave `cutoverRefusesTest()`'s `{ maxLagWaitSec: 8 }` alone: that negative test needs a short
wait.

- [ ] **Step 2: Verify.**

Run:
```bash
bun --no-env-file run typecheck && bun --no-env-file run lint && bun --no-env-file test
rg -n 'SYNC_TIMEOUT_MIN|MAX_LAG_WAIT_SEC|writeStoppedAt' test/scale.harness.ts
```
Expected: typecheck exit 0; biome `Checked 105 files ... No fixes applied.`; suite unchanged
(`542 pass / 20 skip / 0 fail`; the harness is not a `*.test.ts`, so nothing new runs); the
`rg` prints 8 lines: the tunables doc line, the two consts, the watchdog field, the `let`, the
assignment, and the two cutover call sites. Behaviour (the record lands in `ledger/downtime-history.ndjson` with
`"writeStopSource":"operator"`) is verified live in Task 9 Step 3, not here.

- [ ] **Step 3: Commit.**

```bash
git add test/scale.harness.ts
git commit -m "test(scale): sync/lag-wait knobs and the operator write-stop mark for large runs"
```

---

### Task 8: preconditions and fixture calibration (LIVE)

**Files:** none (reads only).

- [ ] **Step 1: Tooling.**

Run:
```bash
docker version --format '{{.Server.Version}}'
docker compose version
psql --version
bun --version
jq --version
```
Expected: each prints a version. `upgrade lab` restores through the HOST `psql`
(`src/upgrade/lab.ts:345-385`), so a missing `psql` stops Task 10.

- [ ] **Step 2: Disk.** The estimates below are derived, not measured; the mechanism is
      stated so it can be checked.

- Scale run (Task 9) peak ~= 2.2 x the seeded size: the source holds the data, the target
  holds a full copy, plus up to `WATCHDOG_MB` of retained WAL and the writer's churn. Wrong if
  the target's index build or TOAST overhead is much larger than the source's.
- Upgrade lab (Task 10) peak ~= 5 x `--seed-gib`: the old container (1x), the HOST dump
  `.upgrade-lab/seed-dump.sql` (about 1x - plain-SQL text; the tsvector column is generated,
  not dumped), the lab container's restored old cluster (1x), `/pgdata/snapshot-old` (1x), and
  the per-run `cp -a` copy `/pgdata/old-run` (1x; the `--link` upgrade hardlinks into it rather
  than copying). Wrong if the dump is much smaller than the heap (it can be).

For a 100 GiB target that is ~220 GiB for Task 9 and ~500 GiB for Task 10, with the host
dump on the host filesystem and everything else inside Docker's storage.

Run:
```bash
df -h .
docker system df
docker run --rm alpine df -h /
```
Expected: host free space >= 120 GiB (the dump); Docker storage free >= 450 GiB (the
`alpine df` line reports the Docker VM's disk on macOS Docker Desktop; raise
Settings -> Resources -> Disk image size if it is short). If either is short, STOP here or
lower the target size and say so in the results.

- [ ] **Step 3: Calibrate rows per GiB for the scale fixture.** `ROWS` sizes `public.documents`
      of `test/annoying-schema.ts`; bytes per row are not pinned anywhere, so measure them.

Run:
```bash
docker compose -f docker-compose.test.yml run --rm -e ROWS=1000000 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'
docker compose -f docker-compose.test.yml exec -T source psql -U postgres -Atc \
  "SELECT pg_total_relation_size('public.documents'), count(*) FROM public.documents"
```
Expected: the harness ends with `scale run complete`; the `psql` line prints
`<bytes>|1000000`. The source service stays up after `run --rm` (only the runner is removed),
and the harness's final `teardown` drops replication objects, not tables.

Compute the row count for a 105 GiB `documents` table (5% headroom over 100 GiB):

```bash
BYTES=<bytes from the psql line>
echo $(( 105 * 1073741824 / (BYTES / 1000000) ))
```

Record the printed number as `ROWS_100G` for Task 9 (and in the Task 11 table).

---

### Task 9: logical-replication rehearsal at 100+ GiB (LIVE)

**Files:** writes `ledger/downtime-history.ndjson`, `ledger/scale-writer-*.log`,
`logs/scale-annoying-*.log` (all gitignored).

- [ ] **Step 1: Run the harness under write load** in a detached shell (hours). `WATCHDOG_MB`
      is set to the config default on purpose: whether 2048 MB survives a 100+ GiB copy under
      load is one of the things being measured.

Run:
```bash
ROWS_100G=<from Task 8 Step 3>
nohup docker compose -f docker-compose.test.yml run --rm \
  -e ROWS="$ROWS_100G" -e WRITE_LOAD=1 -e WATCHDOG_MB=2048 \
  -e SYNC_TIMEOUT_MIN=1440 -e MAX_LAG_WAIT_SEC=1800 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts' \
  > logs/scale-100g.out 2>&1 &
```
Expected: `logs/scale-100g.out` shows `seed documents`, then `watch` poll lines with
`WAL retained NNNMB`.

- [ ] **Step 2: Watch it, and know when to stop.**

Run (repeat as needed):
```bash
tail -n 5 logs/scale-100g.out
docker run --rm alpine df -h /
```
STOP (Ctrl-C the run, then go to Task 12) if Docker free space drops below 20 GiB. If the WAL
watchdog fires (`WAL watchdog: slot retains NNNNMB > 2048MB limit`), that is a finding, not a
harness bug: record the retained figure and the elapsed copy time from the log, then re-run
Step 1 with `-e WATCHDOG_MB=` set above the observed peak to get the copy and cutover numbers.

- [ ] **Step 3: Read the numbers.**

Run:
```bash
tail -n 14 logs/scale-100g.out
rg -o 'WAL retained (\d+)MB' -r '$1' logs/scale-annoying-*.log | sort -n | tail -1
tail -n 1 ledger/downtime-history.ndjson | jq '{totalMs, drainMs, finalizeMs, writeStopSource, lowerBound}'
```
Expected: the `scale report` block (rows, on-disk MiB, seed, initial copy with MiB/s,
reconcile `PASSED`, cutover seconds); one number (peak retained WAL in MB); one JSON object
with `"writeStopSource": "operator"` and `"lowerBound": false`. A `lowerBound: true` record
means Task 7 is not merged. If the `ledger/` file is root-owned (Linux bind mount), read it with
`sudo`. If more than one `scale-annoying-*.log` exists, pass the newest one explicitly.

---

### Task 10: upgrade lab at 100 GiB (LIVE)

**Files:** writes `.upgrade-lab/seed-dump.sql`, `.upgrade-lab/upgrade-lab-report.json`,
`logs/pgmig-lab-*.log` (all gitignored).

- [ ] **Step 1: Free the scale pair first** (disk): `docker compose -f docker-compose.test.yml down -v`.
      Expected: `Container pgmig-itest-... Removed` lines and the anonymous volumes removed.

- [ ] **Step 2: Run the lab** in a detached shell. `--seed-gib` forces the pgdg flavor
      (`src/upgrade/lab.ts:438-441`), so the old side is the `postgres:15` image, not a Supabase
      image; that fidelity gap goes into the results.

Run:
```bash
nohup bun --no-env-file src/cli.ts --no-env-file upgrade lab --from 15 --to 17 --seed-gib 100 --runs 3 \
  > logs/upgrade-lab-100g.out 2>&1 &
```
The second `--no-env-file` is pgmig's own flag: without it the CLI's `preAction` hook loads
`.env` (`src/cli.ts:72-90`), which the lab does not need.
Expected: in order, `seeding old container to ~100 GiB`, `replaying identical data into the lab
container`, `pg_upgrade --check passed`, then `run 1:` ... `run 3:` lines, `report written to
.upgrade-lab/upgrade-lab-report.json`, and `lab torn down`. Each run re-copies the snapshot, so
runs 2 and 3 cost another full copy of wall clock each; `--runs 1` is acceptable if time is
short, and the results must then say "single run, no median".

- [ ] **Step 3: Read the numbers.**

Run:
```bash
jq '{labGiB: (.labSizeBytes / 1073741824), medianPgUpgradeSec, runs}' .upgrade-lab/upgrade-lab-report.json
```
Expected: lab size >= 100, the median `pg_upgrade --link` seconds, and per-run
`prepSec` / `pgUpgradeSec` / `analyzeSec` / `totalSec`.

---

### Task 11: record the results

**Files:**
- Modify: `docs/RUNBOOK.md` (new subsection at the end of section 3)

- [ ] **Step 1: Add the results table.** In `docs/RUNBOOK.md`, immediately after the paragraph
      that ends `same gates, exercised at scale.` and before the `---` that precedes
      `## 4. Create the target project`, insert the block below with one blank line on each side. Every value is filled from the
      command named in the Source column; nothing in it can be written before the run.

```markdown
### Scale rehearsal results (100+ GiB single table)

Measured on throwaway Docker infrastructure (`docker-compose.test.yml` pair, PG16 -> PG16, and
the `upgrade lab` pgdg flavor, PG15 -> PG17). Rehearsal numbers: the host's disk and CPU set
them, not a managed instance.

| Measure | Value | Source |
|---|---|---|
| Date, host (CPU / RAM / disk type) | | operator |
| `ROWS` and `public.documents` size | | Task 8 Step 3 calibration; `scale report` on-disk line |
| Seed time | | `scale report` `seed` line |
| Initial copy time and MiB/s | | `scale report` `initial copy` line |
| Peak WAL retained during copy (vs `maxRetainedWalMb` 2048) | | `rg 'WAL retained'` over the harness log |
| Watchdog fired at 2048 MB? | | harness log |
| Reconcile time and result | | `scale report` `reconcile` line |
| Cutover downtime window (total / drain / finalize) | | last line of `ledger/downtime-history.ndjson` |
| `upgrade lab` size, runs | | `upgrade-lab-report.json` `labSizeBytes`, `runs` |
| `pg_upgrade --link` median seconds | | `upgrade-lab-report.json` `medianPgUpgradeSec` |
| Post-upgrade ANALYZE seconds (median of runs) | | `upgrade-lab-report.json` `runs[].analyzeSec` |

Fidelity gaps: the replication pair is plain `postgres:16` on both sides, not a managed
instance under read load; the upgrade lab's `--seed-gib` path uses the pgdg image, not the
Supabase PG15 image; neither run has network restrictions or cross-region latency.
```

- [ ] **Step 2: Fill every Value cell** from the outputs of Task 8 Step 3, Task 9 Step 3 and
      Task 10 Step 3. Write durations with their unit (`s` / `min`) and sizes in GiB. If a run
      was stopped early, write what was observed and why it stopped instead of leaving a blank.

- [ ] **Step 3: Verify.**

Run:
```bash
rg -A 22 'Scale rehearsal results' docs/RUNBOOK.md | rg -c '\| \|'; echo "exit=$?"
```
Expected: no count line and `exit=1` (`rg -c` prints nothing when nothing matches). The
unfilled template prints `11` and `exit=0`; any number means a Value cell is still empty.

- [ ] **Step 4: Note the result on the cards and commit.**

```bash
vkctl comment work-pgmig#3 "100+ GiB rehearsal recorded in docs/RUNBOOK.md 'Scale rehearsal results'"
vkctl comment work-pgmig#1 "first rehearsal window recorded via cutover -> ledger/downtime-history.ndjson; copied into docs/RUNBOOK.md"
git add docs/RUNBOOK.md
git commit -m "docs(runbook): record the 100+ GiB scale and upgrade-lab rehearsal results"
```

---

### Task 12: teardown (LIVE - also the abort path from Task 9 Step 2)

**Files:** none tracked.

- [ ] **Step 1: Remove the containers, volumes and the host dump.**

Run:
```bash
docker compose -f docker-compose.test.yml down -v
bun --no-env-file src/cli.ts --no-env-file upgrade lab --from 15 --to 17 --clean
rm .upgrade-lab/seed-dump.sql
```
Expected: compose prints `Removed` lines (or nothing if already down); the lab prints
`lab containers removed (images kept - delete manually if unwanted)`; `rm` succeeds or reports
the file absent. Keep `.upgrade-lab/upgrade-lab-report.json` and `ledger/` until Task 11 is
committed.

- [ ] **Step 2: Verify the space came back.**

Run:
```bash
docker ps -a --filter name=pgmig- --format '{{.Names}}'
docker run --rm alpine df -h /
```
Expected: no container names printed; Docker free space back near the Task 8 Step 2 reading.
The lab images (`pgmig-pgupgrade:15-17`) and `postgres:*` images remain; remove them with
`docker image rm` only if the disk is needed.

---

## Self-review

**Coverage against the cards.**
work-pgmig#1: module + history (Task 1), written at subscription drop (Task 2), read by
`status` (Task 3), documented (Task 6 Steps 3, 4, 6). work-pgmig#2: `src/steps/region.ts` +
`test/region.test.ts` (Task 4), `region-check` (Task 5), `docs/REGION-CHANGE.md` + wiring (Task
6). work-pgmig#3: harness knobs (Task 7), preconditions + calibration (Task 8), scale run with
`ROWS` calibrated to a 100+ GiB `documents` table (Task 9), `upgrade lab --seed-gib` (Task 10), numbers in the #1 history
and the RUNBOOK (Tasks 9 Step 3, 11), stop/teardown (Task 9 Step 2, Task 12).

**Placeholders.** Code steps carry complete code. The angle-bracket values in Part C
(`<bytes from the psql line>`, `<from Task 8 Step 3>`) and the empty Value cells in Task 11 are
measurements that only exist after a live run; each names the command that produces it. The
mitigation pairing in `docs/REGION-CHANGE.md` is marked UNVERIFIED in the doc with the
experiment that would settle it.

**Type consistency.** `CutoverMarks` -> `DowntimeWindow` -> `DowntimeRecord` is one chain;
`cutover` spreads a window and adds three fields. `readDowntimeHistory` /
`summarizeDowntimeHistory` / `renderDowntimeHistory` all take `DowntimeRecord[]`.
`writeStoppedAt?: number` has the same name and type in `CutoverOpts`, in cutover's inline opts,
in the CLI action, and in the scale harness. `StatusSnapshot` is untouched; the `downtime` key
exists only in the `status --json` payload assembled by the CLI.

**Known weaknesses, stated rather than hidden.**

1. The recorded window ends at the subscription drop, not when the app serves from the target.
   The repoint/redeploy tail is real user-facing downtime and is not in the number.
2. Without the freeze timestamp the window is a lower bound, and nothing forces the operator
   to supply it. `run --through cutover` does not take the flag (no human observes a freeze in
   CI), so its records are always lower bounds.
3. `region-check` proves the two regions differ, not that the target region is the intended
   one; nothing in config declares an intended region.
4. `readRegion` degrades an unreadable region to `unknown` and `--require-different` treats
   `unknown` as failure. If the Management API renames the field, the gate becomes a hard stop.
5. The NDJSON history is per-checkout, under a gitignored directory, and rehearsal records
   (including the scale harness's, `targetRef` `bbbb...`) share the file with production
   ones. `targetRef` tells them apart; filtering is a `jq` job, not a feature.
6. `formatMs` rounds to one decimal from one second up; the raw `totalMs` is in the record.
7. Part C's disk estimates are derived (mechanism stated in Task 8 Step 2), not measured.

**Dry-run status (2026-10-13, ee76ef2).** Tasks 1-7 were applied verbatim to a scratch tar
copy (no `.git`, no `.env`, `node_modules` symlinked back from the real repo). Every `bun`
command ran with `--no-env-file`; nothing opened a database connection or ran Docker.

| Point | `bun test` | typecheck | lint |
|---|---|---|---|
| Baseline | 504 pass / 20 skip / 0 fail, 524 tests, 36 files | exit 0 | `Checked 101 files`, no fixes |
| Task 1 red | `Cannot find module '../src/steps/downtime.ts'` | - | - |
| After Task 1 | downtime file 22 pass | exit 0 | 103 files |
| Task 2 red | cutover file 7 pass / 2 fail (the two named tests) | red (excess `outDir`) | - |
| After Task 2 | 530 pass / 20 skip / 0 fail, 550 tests, 37 files | exit 0 | 103 files |
| After Task 3 | unchanged | exit 0 | 103 files |
| Task 4 red | `Cannot find module '../src/steps/region.ts'` | - | - |
| After Task 4 | region file 12 pass | exit 0 | 105 files |
| After Tasks 5, 6, 7 | 542 pass / 20 skip / 0 fail, 562 tests, 38 files | exit 0 | 105 files, no fixes |

Also observed: `cutover --help` prints `--write-stopped-at <iso>`; `status --help` prints
`--out-dir <path>`; `cutover --write-stopped-at not-a-date` prints the parse error with exit 1;
the top-level help lists `region-check` and its help lists `--require-different` and `--json`;
the link loop prints nothing (and prints two `broken link` lines when `docs/REGION-CHANGE.md` is
moved away); the repo's docs-examples check still finds every command, `region-check`
included; the scale-harness `rg` prints 8 lines; no step created `ledger/` or `logs/` in the
copy (the temp `outDir` in the cutover tests works).

Mutation checks (each turned exactly one named test red; restored after): Task 1, disabling the
marks-order check -> `rejects marks that run backwards`; Task 2, the three mutants in Step 5 ->
the drain-mark, unrecordable-window and lower-bound tests respectively; Task 4, dropping the
`targetRegion === null` arm -> `either region unreadable ...`; Task 6, removing
`docs/REGION-CHANGE.md` -> the link loop reports both inbound links.

Defects found in this revision and fixed in the text above. Found by reading the plan against
ee76ef2: (1) Task 2's drain anchor was `if (lag <= 0) {`, now `if (lag !== null && lag <= 0) {`;
(2) Task 2 claimed no unit test drives `cutover()` and had no test - it now extends
`test/cutover.test.ts` with the `?real` import, and gives the existing DROP-reaching test a temp
`outDir`, without which the suite would write `ledger/downtime-history.ndjson` into the working
directory; (3) Task 6 skipped `README.md`, whose command reference documents every `cutover` /
`status` flag; (4) Task 6's README provision replacement had mismatched fences (caught on
re-read before applying). Found by the dry run: (5) Task 2 Step 3(a) anchored on
`outDir?: string;`, which occurs twice in `src/engine/types.ts` - an exact-match editor refuses
it; now a unique replace; (6) Task 2 Step 2 claimed Step 5 proves both guard tests are wired -
only one is mutation-reachable, wording corrected; (7) Task 7's expected `rg` output omitted the
doc-comment hit (8 lines, not 7); (8) Task 11's empty-cell check used `-A 16` (covers 9 of 11
rows) and expected `0`, but `rg -c` prints nothing and exits 1 on zero matches - now `-A 22`
with `exit=1` expected, tested against the unfilled (11) and filled (exit 1) template; (9) Task
10/12 passed `--no-env-file` only to Bun, not to pgmig, whose `preAction` hook loads `.env`
when present.

Not verified, and not verifiable without live infrastructure or credentials:

- All of Tasks 8-12 (Docker, 100+ GiB, hours): the calibration arithmetic, the disk estimates
  (derived, mechanism stated in Task 8 Step 2), copy rate, peak WAL, both downtime numbers, and
  the teardown. Task 11's insertion point and its empty-cell check were exercised on the copy;
  nothing else in Part C was run.
- Task 7's behaviour: typecheck and lint pass and the `rg` listing matches, but that the harness
  records `"writeStopSource":"operator"` is only observable in Task 9 Step 3.
- Task 3's not-a-date guard was not mutation-checked: the mutant would fall through to `withDb`
  and attempt a database connection.
- That the recorded window matches a stopwatch on a real Supabase cutover; that
  `GET /v1/projects/{ref}` returns `region` as shown in the dashboard (the code degrades to
  `unknown` if not); a live `region-check` run (needs a PAT); and the custom-domain plus
  external-issuer mitigation, which `docs/REGION-CHANGE.md` marks UNVERIFIED.
- The repo's no-internal docs sensor reads a pattern file that is not present on the machine
  used for this dry run (and passes silently when it is missing - work-pgmig#9); the plan
  was checked by hand for confidential terms instead.
