import type { Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * Fault injection. The point of a rehearsal is not to watch the happy path
 * succeed — it's to deliberately introduce each known failure mode and confirm
 * the orchestrator's gates (preflight / watch / reconcile) actually catch it.
 *
 * Every scenario is reversible-ish or clearly marked destructive-on-target.
 * Run against THROWAWAY projects only.
 */

export type ScenarioName =
  | "drop-replica-identity"
  | "lose-row"
  | "corrupt-row"
  | "stall-subscriber"
  | "desync-sequence"
  | "tsearch-drift";

type Ctx = { source: Db; target: Db; arg?: string };

type Scenario = {
  describe: string;
  expect: string; // which gate should catch it
  /**
   * What re-running reconcile after this scenario should show, so the rehearsal fault gate
   * (orchestrate.ts) can judge the outcome correctly instead of assuming every scenario is
   * reconcile-must-fail: "must-fail" (the classic divergence case), "must-pass" (tsearch-drift
   * proves reconcile correctly ignores it), or "none" when the scenario's own gate is preflight/
   * watch/cutover - reconcile was already exercised earlier in the same pipeline and re-running it
   * post-chaos proves nothing about this scenario.
   */
  reconcileGate: "must-fail" | "must-pass" | "none";
  run: (ctx: Ctx) => Promise<void>;
};

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "drop-replica-identity": {
    describe: "Set a table's REPLICA IDENTITY to NOTHING on the source.",
    expect: "preflight must FAIL the table (no PK/UK/FULL).",
    reconcileGate: "none",
    run: async ({ source, arg }) => {
      const tbl = arg ?? "public.documents";
      await source.unsafe(`ALTER TABLE ${tbl} REPLICA IDENTITY NOTHING`);
      log.ok(`${tbl} REPLICA IDENTITY NOTHING — re-run preflight, expect ✗`);
    },
  },

  "lose-row": {
    describe: "Delete one random row on the TARGET only (simulates a dropped row).",
    expect: "reconcile must report 1 missing_on_target in some bucket.",
    reconcileGate: "must-fail",
    run: async ({ target, arg }) => {
      const tbl = arg ?? "public.documents";
      const [r] = await target.unsafe(
        `DELETE FROM ${tbl} WHERE ctid IN (SELECT ctid FROM ${tbl} LIMIT 1) RETURNING *`,
      );
      log.ok(
        `deleted 1 row on target (${r ? "ok" : "table empty?"}) — re-run reconcile, expect FAIL`,
      );
    },
  },

  "corrupt-row": {
    describe: "Mutate one row's content on the TARGET only (content drift, same PK).",
    expect: "reconcile must report 1 hash_diff (count still matches).",
    reconcileGate: "must-fail",
    run: async ({ target, arg }) => {
      const tbl = arg ?? "public.documents";
      await target.unsafe(
        `UPDATE ${tbl} SET content = content || '_corrupted'
         WHERE ctid IN (SELECT ctid FROM ${tbl} LIMIT 1)`,
      );
      log.ok(`corrupted 1 row's content on target — re-run reconcile, expect hash_diff`);
    },
  },

  "stall-subscriber": {
    describe: "DISABLE the subscription on the target while the writer keeps running.",
    expect: "watch's WAL watchdog should fire as the source slot retains WAL.",
    reconcileGate: "none",
    run: async ({ target, arg }) => {
      const sub = arg ?? "region_migration_sub";
      await target.unsafe(`ALTER SUBSCRIPTION ${sub} DISABLE`);
      log.ok(
        `subscription ${sub} DISABLED — keep the writer running, re-run watch, expect watchdog abort`,
      );
      log.detail(`re-enable with: ALTER SUBSCRIPTION ${sub} ENABLE`);
    },
  },

  "desync-sequence": {
    describe:
      "Create a serial-PK demo table and advance its source sequence past the target's (the classic post-cutover collision).",
    expect: "demonstrates why sequences need manual setval at cutover (uuid PKs are immune).",
    reconcileGate: "none",
    run: async ({ source }) => {
      await source.unsafe(
        `CREATE TABLE IF NOT EXISTS public.chaos_seq_demo (id bigserial PRIMARY KEY, v text)`,
      );
      await source.unsafe(`SELECT setval('public.chaos_seq_demo_id_seq', 1000000, true)`);
      log.ok(
        "source chaos_seq_demo sequence advanced to 1e6 — target would collide on first insert without setval",
      );
    },
  },

  "tsearch-drift": {
    describe:
      "Change default_text_search_config on the target (would break a naive hash that included search_vector).",
    expect: "reconcile must still PASS - we exclude generated columns, proving the guard works.",
    reconcileGate: "must-pass",
    run: async ({ target }) => {
      // H-2: ALTER DATABASE is a persistent, database-level GUC change that survives
      // teardown. We revert it here rather than printing a hint that may be missed.
      await target.unsafe(
        `ALTER DATABASE postgres SET default_text_search_config = 'pg_catalog.simple'`,
      );
      log.ok(
        "target default_text_search_config = simple — reconcile should STILL pass (search_vector excluded)",
      );
      try {
        await target.unsafe(`ALTER DATABASE postgres RESET default_text_search_config`);
        log.detail("target default_text_search_config reset to cluster default");
      } catch (e) {
        log.warn(
          `tsearch-drift revert failed (${e instanceof Error ? e.message : e}) — ` +
            "run: ALTER DATABASE postgres RESET default_text_search_config",
        );
      }
    },
  },
};

export async function runChaos(ctx: Ctx, name: ScenarioName): Promise<void> {
  const sc = SCENARIOS[name];
  log.step(`chaos: ${name}`);
  log.detail(sc.describe);
  log.detail(`expected gate: ${sc.expect}`);
  await sc.run(ctx);
}
