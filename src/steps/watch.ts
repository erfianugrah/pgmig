import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deliberate, non-recoverable abort (slot lost, WAL watchdog tripped, deadline).
 *  Distinguished from transient connection errors so the poll loop only retries
 *  the latter and never swallows the former. */
class FatalWatchError extends Error {}

/**
 * Poll the subscription's initial-sync state AND guard the source's WAL bloat.
 * Resolves when every table reaches srsubstate='r' (ready) and lag is ~0.
 * Throws if the slot retains more WAL than watchdog.maxRetainedWalMb — the
 * single most common way logical replication takes down the source.
 */
export async function watch(source: Db, target: Db, cfg: Config): Promise<void> {
  log.step("watch: initial sync + WAL watchdog");
  const { slot, publication, subscription } = cfg.replication;
  const { maxRetainedWalMb, pollIntervalSec, syncTimeoutMin } = cfg.watchdog;
  const deadline = Date.now() + syncTimeoutMin * 60_000;

  // Baseline the subscription's error counters so we can detect a worker that is
  // actively error-LOOPING (counts climbing), not just a single transient at start.
  let prevApplyErr = -1;
  let prevSyncErr = -1;
  let pollCount = 0;

  // Expected copy volume (heap+toast of published tables on the source) so the
  // long initial COPY shows a % instead of a static 0/N for hours. Best-effort.
  let expectedBytes = 0;
  try {
    const [r] = await source.unsafe(
      `SELECT coalesce(sum(pg_table_size(format('%I.%I', schemaname, tablename)::regclass)), 0)::bigint AS b
       FROM pg_publication_tables WHERE pubname = $1`,
      [publication],
    );
    expectedBytes = Number(r?.b ?? 0);
  } catch {
    /* non-fatal: progress % just won't show */
  }

  // A multi-hour watch must survive a transient network blip on the polling
  // connection: the server-side subscription copy keeps running regardless, so a
  // dropped read should retry next poll, not crash the migration. Deliberate
  // aborts (FatalWatchError) always propagate; only transient errors are tolerated,
  // and only up to maxConsecutiveErrors in a row.
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  for (;;) {
    try {
      // WAL retained by the slot on the source (bytes) + slot health
      const [walRow] = await source`
      SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes, active, wal_status
      FROM pg_replication_slots WHERE slot_name = ${slot}`;
      const retainedMb = Number(walRow?.retained_bytes ?? 0) / 1_048_576;

      // A slot the server has invalidated (recycled WAL the subscriber hadn't read,
      // i.e. max_slot_wal_keep_size exceeded) can never recover — replication is
      // permanently broken and must be torn down + restarted. Fail loud, not silent.
      if (walRow?.wal_status === "lost") {
        throw new FatalWatchError(
          "replication slot INVALIDATED (wal_status=lost): the source recycled WAL the " +
            "subscriber had not consumed. Replication cannot resume — teardown and restart " +
            "the migration (and raise max_slot_wal_keep_size / speed up the subscriber).",
        );
      }
      if (walRow && walRow.wal_status !== "reserved" && walRow.wal_status !== "extended") {
        log.warn(`slot wal_status=${walRow.wal_status} — approaching invalidation`);
      }

      // Per-table sync state on the subscriber. srsubstate: i=init d=copying r=ready s=synced
      // Scoped to OUR subscription (as status.ts does): other subscriptions on the
      // target must not hold up, or falsely complete, this migration's sync.
      const states = await target`
      SELECT srsubstate, count(*)::int AS n FROM pg_subscription_rel
      JOIN pg_subscription s ON s.oid = srsubid AND s.subname = ${subscription}
      GROUP BY srsubstate`;
      const byState = Object.fromEntries(states.map((s) => [s.srsubstate, s.n])) as Record<
        string,
        number
      >;
      const total = states.reduce((a, s) => a + Number(s.n), 0);
      const ready = Number(byState.r ?? 0);

      // Subscription worker health. A tablesync / apply worker that hits an error
      // (constraint violation, type mismatch, row conflict) restarts in a loop and
      // bumps these counters while srsubstate stays stuck — the table never reaches
      // 'r' and watch would otherwise just spin to the timeout with no diagnosis.
      // A RISING count is the signal (a single transient at startup is benign).
      // pg_stat_subscription_stats is PG15+; Supabase is PG15+. Best-effort.
      try {
        const [es] = await target`
        SELECT coalesce(apply_error_count, 0)::bigint AS apply_err,
               coalesce(sync_error_count, 0)::bigint AS sync_err
        FROM pg_stat_subscription_stats WHERE subname = ${subscription}`;
        const applyErr = Number(es?.apply_err ?? 0);
        const syncErr = Number(es?.sync_err ?? 0);
        if (prevApplyErr >= 0 && (applyErr > prevApplyErr || syncErr > prevSyncErr)) {
          log.warn(
            `subscription ${subscription} is ERRORING (apply_error_count=${applyErr}, ` +
              `sync_error_count=${syncErr}, both rising) — a worker is restarting in a loop. ` +
              "Check the subscriber logs (apply/tablesync error) — sync will not progress until fixed.",
          );
        }
        prevApplyErr = applyErr;
        prevSyncErr = syncErr;
      } catch {
        /* pg_stat_subscription_stats needs PG15+; skip if unavailable */
      }

      // No apply worker attached at all => subscription disabled or crashed and not
      // restarting. Distinct from "slot inactive" (that's the source side). Skip on the
      // very first poll: right after CREATE SUBSCRIPTION the apply worker takes ~1s to
      // attach, so a first-poll null pid is expected, not a fault.
      const [subw] = await target`
      SELECT count(*)::int AS workers FROM pg_stat_subscription s
      JOIN pg_subscription ps ON ps.oid = s.subid
      WHERE ps.subname = ${subscription} AND s.pid IS NOT NULL`;
      if (pollCount > 0 && Number(subw?.workers ?? 0) === 0) {
        log.warn(
          `subscription ${subscription} has NO running worker (pid is null) — it may be disabled ` +
            "or crashed without restarting. Replication is stalled until a worker attaches.",
        );
      }

      // Live COPY progress from the subscriber's tablesync workers (PG14+).
      let copyMsg = "";
      if (total === 0 || ready < total) {
        try {
          const [cp] = await target`
          SELECT coalesce(sum(bytes_processed), 0)::bigint AS b, count(*)::int AS n
          FROM pg_stat_progress_copy`;
          const copied = Number(cp?.b ?? 0);
          if (Number(cp?.n ?? 0) > 0 || copied > 0) {
            const gb = (n: number) => (n / 1_073_741_824).toFixed(1);
            const pct =
              expectedBytes > 0 ? ` ~${((copied / expectedBytes) * 100).toFixed(0)}%` : "";
            copyMsg = ` | copying ${gb(copied)}/${gb(expectedBytes)}GB${pct}`;
          }
        } catch {
          /* pg_stat_progress_copy needs PG14+; skip if unavailable */
        }
      }

      log.info(
        `sync ${ready}/${total} ready ` +
          `(init=${byState.i ?? 0} copy=${byState.d ?? 0} synced=${byState.s ?? 0}) | ` +
          `WAL retained ${retainedMb.toFixed(0)}MB | slot ${walRow?.active ? "active" : "INACTIVE"}` +
          copyMsg,
      );

      if (retainedMb > maxRetainedWalMb) {
        throw new FatalWatchError(
          `WAL watchdog: slot retains ${retainedMb.toFixed(0)}MB > ${maxRetainedWalMb}MB limit. ` +
            "Subscriber is too slow or stalled — the source disk is at risk. Investigate before continuing.",
        );
      }

      // M-5: detect total===0 after the subscription is established.
      // Our subscription has no pg_subscription_rel rows when: the subscription
      // name in config is wrong (nothing to join), the walreceiver never attached,
      // or max_replication_workers=0. Warn when a subscription of that name exists
      // and is enabled; without this the loop spins silently until syncTimeoutMin.
      if (total === 0 && pollCount > 3) {
        const [subState] = await target`
          SELECT subenabled FROM pg_subscription WHERE subname = ${subscription}`;
        if (subState?.subenabled) {
          log.warn(
            `subscription ${subscription} has been running for ${pollCount} polls but ` +
              "0 tables appear in pg_subscription_rel — verify the subscription name in " +
              "config matches exactly and that a walreceiver process has started.",
          );
        }
      }

      if (total > 0 && ready === total) {
        log.ok(`all ${total} tables synced (srsubstate='r')`);
        return;
      }
      consecutiveErrors = 0; // a clean poll resets the transient-failure streak
      pollCount++;
    } catch (e) {
      if (e instanceof FatalWatchError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (++consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(
          `watch: ${maxConsecutiveErrors} consecutive poll failures — giving up. Last error: ${msg}`,
        );
      }
      log.warn(
        `watch: transient poll error (${consecutiveErrors}/${maxConsecutiveErrors}), retrying next poll: ${msg}`,
      );
    }

    if (Date.now() > deadline) {
      throw new Error(`sync did not complete within ${syncTimeoutMin} min`);
    }
    await sleep(pollIntervalSec * 1000);
  }
}
