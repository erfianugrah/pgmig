# Cutover downtime window + region change as a named recipe - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give pgmig a measured downtime number per cutover, persisted across runs and
readable from `status`, and turn "change my project's region" into a named, sequenced recipe
whose unsolvable part (project ref + API keys) is stated instead of implied.

**Architecture:** one new pure module `src/steps/downtime.ts` owns the window arithmetic and
an append-only NDJSON history under the existing `ledger/` out-dir; `cutover` writes one
record at the moment it drops the subscription; the `status` CLI action reads the history and
prints a summary. A second small module `src/steps/region.ts` compares the source and target
project regions through the Management API and prints the identity artifacts a region move
never carries; `docs/REGION-CHANGE.md` sequences the existing commands around it.

**Tech stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`), commander CLI, zod
config, biome lint/format, `bun:test` unit tests. No new dependencies.

**Standing constraint:** the operator has asked for no commits in this session. Per-task
commit steps are therefore omitted; commit at your own cadence.

**Verified against the repo on 2026-08-04:**

| Fact | Proof |
|---|---|
| Sensors are `bun run typecheck` (tsc --noEmit), `bun run lint` (biome check .), `bun test` | `package.json` scripts; `.pi/harness.json` sensors block names them identically |
| Baseline is green: typecheck exit 0, `Checked 99 files ... No fixes applied`, `490 pass / 20 skip / 0 fail` across 34 files | ran all three in a scratch copy of the repo |
| There is NO run history today. `ledger/` is a gitignored artifact dir written by `reconcile` (`ledger/reconcile-<ts>.json`), `verify` (`ledger/verify-<ts>.json`), `bootstrap` and `translate`; `logs/` is the durable log sink opened by `log.toFile()` in the CLI `preAction` hook | `.gitignore` lists `ledger/` and `logs/`; `src/steps/reconcile.ts:110,167`; `src/steps/verify.ts` reportPath; `src/cli.ts` preAction hook; `src/log.ts` `toFile` |
| No SQLite, no JSON ledger of runs anywhere | a repo-wide ripgrep for `ledger` across `src/**/*.ts` returns only the out-dir default, the reconcile inflight-loss ledger (a rehearsal-writer id file), and the rehearsal writer itself |
| `cutover()` today takes `opts: { sequences?: string[]; maxLagWaitSec?: number }` and returns `Promise<void>` | `src/steps/cutover.ts` |
| The engine seam's `CutoverOpts` already carries `outDir?: string`, and `src/cli.ts` already passes it | `src/engine/types.ts`; `src/cli.ts` cutover action |
| `cutover` drains lag in a `for(;;)` loop that `break`s on `lag <= 0`, then resyncs sequences, then DISABLE / `SET (slot_name = NONE)` / DROP SUBSCRIPTION | `src/steps/cutover.ts` |
| `status()` is a pure DB read returning `StatusSnapshot`; the CLI action prints it or emits it as one JSON object | `src/steps/status.ts`; `src/cli.ts` status command |
| `provision` does NOT create projects. It PATCHes billable addons / disk / backup schedule on an EXISTING target and has exactly one flag, `--confirm` | `src/steps/provision.ts`; `src/cli.ts` provision command |
| Project creation with a region exists only on `MgmtApi.createProject(name, organizationId, dbPass, region)`, used only by `sandbox up` (`--src-region` / `--tgt-region`) | `src/mgmt.ts`; `src/steps/sandbox.ts:225,233`; `src/cli.ts:600-601` |
| `MgmtApi.getProject(ref)` returns the raw project object, documented in-repo as carrying `status` and `region` | `src/mgmt.ts` `getProject` doc comment |
| JWT signing secret and API keys are never carried, by design | `docs/MIGRATION-SCOPE.md` section C row 5; `src/config.ts` `configSync.secrets` doc comment |
| Test import order in this repo is `bun:test`, then `node:*`, then relative | `test/config.test.ts`, `test/translate.test.ts`, `test/debezium-runtime-io.test.ts` |
| Integration tiers self-skip without `TEST_SOURCE_DB_URL` / `TEST_TARGET_DB_URL` | `test/integration.test.ts`, `test/bootstrap.integration.test.ts` guards |

Every CLI flag this plan mentions in a NEW form is created by this plan; none of them exist in
`src/cli.ts` today. Task 3 and Task 5 add them, and each ends with a `--help` invocation that
prints the flag back so the name is proven rather than assumed.

**Dry-run status:** Tasks 1-6 were applied verbatim to a scratch copy at `/tmp/pgmig-check`
(tar copy excluding `node_modules`, `.git`, `.env`, the compiled `pgmig` binary, `logs/` and
`ledger/`; `node_modules` symlinked back). Sensors before: typecheck exit 0; lint
`Checked 99 files ... No fixes applied`; `bun test` 490 pass / 20 skip / 0 fail across 34 files.
Sensors after all six tasks: typecheck exit 0; lint `Checked 103 files ... No fixes applied`;
`bun test` 524 pass / 20 skip / 0 fail across 36 files. Five defects were found and are listed
at the end of Self-review; the code below is the corrected version.

Not verified, and not verifiable without live infrastructure: that the recorded window matches
a wall-clock stopwatch across a real Supabase cutover (needs two live projects and a real
freeze); that `GET /v1/projects/{ref}` returns a `region` field with the value shown in the
dashboard (needs a live PAT - Task 5 handles the field being absent instead of asserting it);
and the custom-domain + external-issuer mitigation pairing in `docs/REGION-CHANGE.md`, which
is marked UNVERIFIED in the doc itself with the experiment that would settle it.

## Why not just extend an existing artifact

- **Why not add the window to the `reconcile` JSON report.** `reconcile` is read-only and is
  run BEFORE the freeze (RUNBOOK step 9b) as well as after. The window's start is the freeze
  and its end is the subscription drop, both of which are `cutover`'s business. Attaching the
  number to a report that also gets written pre-freeze would make it ambiguous which run the
  number belongs to.
- **Why not extend `StatusSnapshot`.** `status()` takes two `Db` handles and issues three
  queries; it touches no filesystem. Its shape is the contract for `status --json`, which the
  RUNBOOK positions as a scheduled watcher. Adding a disk read inside it means a poll loop
  starts failing (or lying) when `ledger/` is absent, which is the normal state on a fresh
  checkout. The CLI action composes the two reads instead, so `status()` stays pure.
- **Why a single append-only NDJSON file rather than the `ledger/<step>-<ts>.json`
  convention.** Those are per-run snapshots that nothing reads back. The downtime number's
  value is the trend: rehearsal 1..N, then the production run. That needs accumulation in one
  file, and NDJSON appends without a read-modify-write, so a crashed cutover cannot truncate
  the history of the previous ones.
- **Why not a target-region flag on `provision`.** `provision` does not create projects; it
  PATCHes addons on a target that already exists, and region is immutable after creation
  (`docs/MIGRATION-SCOPE.md`, Project Settings table: "immutable; region is chosen when you
  create the target"). Such a flag there would be one that cannot do what its name says. The
  first-class hook that IS honest is an assertion: read both projects' regions and tell the
  operator whether the move they think they are doing is actually cross-region.

## File structure

| Path | Responsibility |
|---|---|
| `src/steps/downtime.ts` | CREATE - pure window arithmetic, NDJSON history append/parse/read, history summary + renderer |
| `test/downtime.test.ts` | CREATE - unit tests for every pure function in `downtime.ts` |
| `src/steps/cutover.ts` | MODIFY - stamp the three marks, append one history record, log the window |
| `src/engine/types.ts` | MODIFY - add `writeStoppedAt?: number` to `CutoverOpts` |
| `src/cli.ts` | MODIFY - the new cutover flag, the new status flag + downtime summary, the new `region-check` command |
| `src/steps/region.ts` | CREATE - region verdict (pure) + Management-API fetch + renderer |
| `test/region.test.ts` | CREATE - unit tests for the verdict, the region reader, and the fetch path |
| `docs/REGION-CHANGE.md` | CREATE - the named recipe, including what it cannot solve |
| `docs/RUNBOOK.md` | MODIFY - link the recipe, record the window in the step-9 block, add the command-reference rows |
| `docs/MIGRATION-SCOPE.md` | MODIFY - point row 5 at the recipe |

---

### Task 1: the downtime module (pure arithmetic + NDJSON history)

**Files:** Create `src/steps/downtime.ts`, Test `test/downtime.test.ts`

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

```bash
cd /path/to/pgmig && bun test test/downtime.test.ts
```

Expect a module-resolution failure, not an assertion failure:
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

- [ ] **Step 4: Run the tests.**

```bash
cd /path/to/pgmig && bun test test/downtime.test.ts && bun run typecheck && bun run lint
```

Expect `22 pass`, `0 fail` from the downtime file, `tsc --noEmit` exit 0, and biome
`No fixes applied`. The named-import order above is the one biome's organize-imports assist
produces; retyping it alphabetically fails `bun run lint`.


---

### Task 2: stamp the marks in `cutover` and write the record

**Files:** Modify `src/steps/cutover.ts`, Modify `src/engine/types.ts`

- [ ] **Step 1: Widen the engine seam.** In `src/engine/types.ts`, inside `CutoverOpts`,
      add this field immediately after the existing `outDir?: string;` line:

```ts
  /**
   * Epoch ms at which application writes to the SOURCE were actually stopped (RUNBOOK 9a).
   * Sets the START of the recorded downtime window. Omit it and the window falls back to
   * cutover's own start time and is recorded as a LOWER BOUND.
   */
  writeStoppedAt?: number;
```

- [ ] **Step 2: Import the downtime module and widen the options.** In
      `src/steps/cutover.ts`, insert after the existing `import { log } from "../log.ts";`:

```ts
import { appendDowntimeRecord, type CutoverMarks, computeWindow, formatMs } from "./downtime.ts";
```

One line, and in that exact order - biome collapses it to one line (it fits the 100-column
limit) and puts `type CutoverMarks` before `computeWindow`.

then replace the options parameter:

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

- [ ] **Step 3: Start the clock.** Immediately after the opening warn line in `cutover()`
      (the one beginning `log.warn("Assuming application writes to the SOURCE`), insert:

```ts

  // Downtime clock. The freeze itself happens before this command runs, so the
  // operator-supplied write-stop is the true start; cutoverStartedAt is the
  // lower-bound fallback. lagDrainedAt is filled by the drain loop below.
  const cutoverStartedAt = Date.now();
  let lagDrainedAt = 0;
```

- [ ] **Step 4: Stamp the drain.** In the drain loop, replace:

```ts
    if (lag <= 0) {
      log.ok("lag drained to zero");
      break;
    }
```

with:

```ts
    if (lag <= 0) {
      lagDrainedAt = Date.now();
      log.ok("lag drained to zero");
      break;
    }
```

- [ ] **Step 5: Close the window and record it.** Replace the final block, which today reads:

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
loop somehow exits without taking the mark, and a 0 there would compute a 56-year window.

- [ ] **Step 6: Run the sensors.**

```bash
cd /path/to/pgmig && bun run typecheck && bun run lint && bun test
```

Expect typecheck exit 0, biome `No fixes applied`, and the suite green with the same counts as
after Task 1. No existing unit test drives `cutover()`; the only caller is the docker-gated
integration tier, which self-skips without `TEST_SOURCE_DB_URL`.

---

### Task 3: expose the window on `cutover` and `status`

**Files:** Modify `src/cli.ts`

- [ ] **Step 1: Add the flag and parse it.** In `src/cli.ts`, in the `cutover` command block,
      replace:

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

- [ ] **Step 4: Run the sensors and prove the flags exist.**

```bash
cd /path/to/pgmig && bun run typecheck && bun run lint && bun test
bun src/cli.ts cutover --help
bun src/cli.ts status --help
```

The cutover help must list `--write-stopped-at <iso>`; the status help must list
`--out-dir <path>`. Neither `--help` opens a DB connection, so both are safe to run without
credentials.

---

### Task 4: the region verdict module

**Files:** Create `src/steps/region.ts`, Test `test/region.test.ts`

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

```bash
cd /path/to/pgmig && bun test test/region.test.ts
```

Expect `error: Cannot find module '../src/steps/region.ts'`.

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

- [ ] **Step 4: Run the tests.**

```bash
cd /path/to/pgmig && bun test test/region.test.ts && bun run typecheck && bun run lint
```

Expect `12 pass`, `0 fail`, typecheck exit 0, biome `No fixes applied`. As in Task 1, the
named-import order above is biome's, not alphabetical.


---

### Task 5: the `region-check` command

**Files:** Modify `src/cli.ts`

- [ ] **Step 1: Add the import.** In the import block of `src/cli.ts`, add immediately after
      `import { provision } from "./steps/provision.ts";` (biome sorts by module path, and
      `./steps/region.ts` sorts between `provision` and `run`):

```ts
import { regionCheck, renderRegionReport } from "./steps/region.ts";
```

- [ ] **Step 2: Add the command.** Insert this block immediately after the closing `);` of
      the `provision` command and before `program.command("claim <orgSlug> <token>")`:

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

- [ ] **Step 3: Run the sensors and prove the command exists.**

```bash
cd /path/to/pgmig && bun run typecheck && bun run lint && bun test
bun src/cli.ts --help | grep region-check
bun src/cli.ts region-check --help
```

The top-level help must list `region-check`, and its own help must list
`--require-different` and `--json`. `--help` never reaches `loadSecrets`, so no token is
needed to run these two checks.

---

### Task 6: the region-change recipe and the doc wiring

**Files:** Create `docs/REGION-CHANGE.md`, Modify `docs/RUNBOOK.md`, Modify
`docs/MIGRATION-SCOPE.md`

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

- [ ] **Step 2: Link the recipe from the runbook safety-net checklist.** In
      `docs/RUNBOOK.md`, find the bullet that begins
      `- **JWT secret / API keys are NEVER copied.**` and append this sentence to the end of
      that bullet's last line:

```
  If this migration is a region change, read [REGION-CHANGE.md](REGION-CHANGE.md) first.
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

- [ ] **Step 4: Update the command reference.** In `docs/RUNBOOK.md`, in the
      "Command reference (this tool)" table, replace this row:

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

- [ ] **Step 5: Point migration scope at the recipe.** In `docs/MIGRATION-SCOPE.md`, in the
      section C table, find row 5 (the one whose Artifact cell is
      `**JWT signing secret + API keys (anon/service)**`). That row's final cell ends with
      `app must re-key + users re-login`. Rewrite the tail of the cell so it reads:

```
app must re-key + users re-login. Region change is the common case: see [REGION-CHANGE.md](REGION-CHANGE.md). |
```

The cell contains an em-dash in an earlier column, so do this with `sd` on the ASCII tail
rather than by retyping the row:

```bash
sd 'app must re-key \+ users re-login \|' \
   'app must re-key + users re-login. Region change is the common case: see [REGION-CHANGE.md](REGION-CHANGE.md). |' \
   docs/MIGRATION-SCOPE.md
```

- [ ] **Step 6: Run the sensors and check the links resolve.**

```bash
cd /path/to/pgmig && bun run typecheck && bun run lint && bun test
for f in docs/REGION-CHANGE.md docs/RUNBOOK.md docs/MIGRATION-SCOPE.md; do
  rg -o '\]\(([^)#]+)\)' -r '$1' "$f" | while read -r t; do
    case "$t" in http*|mailto:*) continue;; esac
    [ -f "docs/$t" ] || [ -f "$t" ] || echo "broken link in $f: $t"
  done
done
```

Expect no `broken link` lines. `bun run lint` covers only `.ts` here, so the link loop is the
markdown-side check.


---

## Self-review

**Coverage.** Part A: `computeWindow`, `formatMs`, `parseDowntimeHistory`,
`appendDowntimeRecord`, `readDowntimeHistory`, `summarizeDowntimeHistory`,
`downtimeHistoryPath` and `renderDowntimeHistory` all have unit tests, including the
adversarial paths that matter for a number that gets quoted: backwards marks, a NaN mark, a
truncated NDJSON line, and an empty history. Part B: `readRegion`, `planRegionCheck`,
`REGION_CHANGE_NEVER_CARRIED` and `renderRegionReport` are unit-tested, and `regionCheck` is
tested against a path-aware `globalThis.fetch` mock (the idiom `test/mgmt.test.ts` and
`test/config-sync.integration.test.ts` already use), including the case where the payload has
no `region` field.

**Placeholders.** None. Every type, function and field referenced by a later task is defined
in an earlier one. The one deliberately unresolved thing is the mitigation pairing in
`docs/REGION-CHANGE.md`, and it is marked UNVERIFIED in the doc with the five-step experiment
that would settle it - that is a stated boundary, not a TODO.

**Type consistency.** `CutoverMarks` -> `DowntimeWindow` -> `DowntimeRecord` is one chain;
`DowntimeRecord extends DowntimeWindow`, so `cutover` spreads a window and adds three fields.
`summarizeDowntimeHistory` and `readDowntimeHistory` both traffic in `DowntimeRecord[]`, which
is what the CLI hands to `renderDowntimeHistory`. `StatusSnapshot` is untouched; the extra
`downtime` key exists only in the `status --json` payload, which is assembled in the CLI.
Index access is guarded for `noUncheckedIndexedAccess` (`sorted[mid] ?? 0`, `.at(-1)` with a
null check).

**Known weaknesses, stated rather than hidden.**

1. The recorded window ends when the subscription is dropped, not when the app is serving from
   the target. The repoint/redeploy tail is real downtime for users and is not in the number.
   Both the module doc comment and `docs/REGION-CHANGE.md` say so; the honest fix would be a
   second command the operator runs after the redeploy, which is more surface than this is
   worth until someone asks for it.
2. Without the freeze timestamp the window is a lower bound, and nothing forces the operator
   to supply it. It is a flag, not a gate, because making it required would break
   `run --through cutover` in CI, where no human is present to observe a freeze.
3. `region-check` proves the two projects are in different regions. It does not prove the
   target region is the one you wanted - nothing in config declares an intended region, so
   there is nothing to compare against.
4. `readRegion` degrades an unreadable region to `unknown`, and the gate treats `unknown` as a
   failure. If the Management API ever renames that field, the gate turns into a hard stop
   rather than a silent pass. That is the correct failure direction but it will look like a
   bug when it happens.
5. The NDJSON history is per-checkout, under a gitignored directory. Two operators running
   cutovers from two machines keep two histories. Consolidating them is a paste job, not a
   feature.
6. `formatMs` rounds to one decimal from one second up, so two runs that differ by a few tens
   of milliseconds render identically. The raw `totalMs` is in the record for anyone who cares.

**Dry-run status.** All six tasks were applied verbatim to `/tmp/pgmig-check`.

- Baseline: `bun run typecheck` exit 0; `bun run lint` -> `Checked 99 files in 72ms. No fixes
  applied.`; `bun test` -> 490 pass / 20 skip / 0 fail across 34 files.
- After Task 6: `bun run typecheck` exit 0; `bun run lint` -> `Checked 103 files in 57ms. No
  fixes applied.`; `bun test` -> 524 pass / 20 skip / 0 fail across 36 files. That is +34
  tests in +2 files: 22 from `test/downtime.test.ts`, 12 from `test/region.test.ts`.
- `bun src/cli.ts cutover --help` printed `--write-stopped-at <iso>`; `status --help` printed
  `--out-dir <path>`; `--help | grep region-check` matched; `region-check --help` printed
  `--require-different` and `--json`.
- The markdown link loop over the three touched docs reported nothing.
- No command in the loop opened a database connection or read `.env` (the scratch copy has no
  `.env`, and the integration tiers self-skipped: 20 skips, unchanged from baseline).

Defects the loop found, all now fixed in the text above:

1. **Task 1 expected the wrong test count.** The draft said 21 passing tests in
   `test/downtime.test.ts`; the file as written yields 22. A wrong expected count is a broken
   verification step - the implementer would stop and hunt for a missing test.
2. **biome rejected the named-import order in `test/downtime.test.ts`.** `bun run lint` failed
   with an organize-imports diff wanting `type CutoverMarks` BEFORE `computeWindow`. Biome's
   sort is not the case-insensitive alphabetical order the draft assumed. Order corrected in
   the plan, and a note added so the next author does not "fix" it back.
3. **Same defect in `src/steps/cutover.ts`.** The draft's import listed `computeWindow` before
   `type CutoverMarks` and lint failed identically. Corrected, and the plan now states that
   the import must be one line.
4. **Task 4 expected the wrong test count.** The draft said 14; the file yields 12 (the
   `renderRegionReport` loop generates three tests, not five as the draft's arithmetic
   assumed).
5. **biome rejected the named-import order in `test/region.test.ts`**, wanting
   `REGION_CHANGE_NEVER_CARRIED` before `readRegion`. Corrected.

All five are mechanical, and all five would have stopped a verbatim application of the draft
at a red sensor. None required a design change: the two things most likely to have been design
defects - `lagDrainedAt` reaching `computeWindow` as 0, and `region-check` passing on an
unreadable region - were already handled in the draft (`lagDrainedAt || targetWritableAt`, and
gating on `verdict !== "cross-region"` rather than `=== "same-region"`).

**Not verifiable here.** Three things need live infrastructure and are left as verification
steps rather than pinned facts: the recorded window against a stopwatch on a real cutover; the
presence and spelling of the `region` field on a real `GET /v1/projects/{ref}` response (the
code reads it defensively and reports `unknown` if absent, so a wrong guess degrades rather
than lies); and the custom-domain plus external-issuer mitigation, which
`docs/REGION-CHANGE.md` marks UNVERIFIED and pairs with the experiment that would settle it.
