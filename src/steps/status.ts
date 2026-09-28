import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * One-shot replication health snapshot — designed to be polled by a scheduled
 * watcher (GitHub Action cron, Lambda, etc). Pure read; no side effects.
 * `--require-synced` lets a poll loop exit non-zero until every table is ready.
 */
export interface StatusSnapshot {
  ts: string;
  subscription: { name: string; exists: boolean; enabled: boolean | null };
  tables: {
    total: number;
    ready: number;
    init: number;
    copying: number;
    synced: number;
    allReady: boolean;
  };
  slot: { name: string; exists: boolean; active: boolean; walRetainedMb: number; lagBytes: number };
}

export async function status(source: Db, target: Db, cfg: Config): Promise<StatusSnapshot> {
  if (cfg.source.engine !== "postgres") {
    throw new Error(
      `status is postgres-only (pg_subscription, pg_replication_slots) - source.engine is ` +
        `'${cfg.source.engine}'. The Debezium engine has no native-PG subscription/slot to poll; ` +
        "there is no equivalent snapshot for a heterogeneous source yet.",
    );
  }
  const { slot, subscription } = cfg.replication;

  const [sub] = await target`
    SELECT subenabled FROM pg_subscription WHERE subname = ${subscription}`;

  const states = await target`
    SELECT srsubstate, count(*)::int AS n FROM pg_subscription_rel
    JOIN pg_subscription s ON s.oid = srsubid AND s.subname = ${subscription}
    GROUP BY srsubstate`;
  const by = Object.fromEntries(states.map((s) => [s.srsubstate, Number(s.n)])) as Record<
    string,
    number
  >;
  const total = states.reduce((a, s) => a + Number(s.n), 0);
  const ready = by.r ?? 0;

  const [slotRow] = await source`
    SELECT active,
           pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes,
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
    FROM pg_replication_slots WHERE slot_name = ${slot}`;

  return {
    ts: new Date().toISOString(),
    subscription: {
      name: subscription,
      exists: Boolean(sub),
      enabled: sub ? Boolean(sub.subenabled) : null,
    },
    tables: {
      total,
      ready,
      init: by.i ?? 0,
      copying: by.d ?? 0,
      synced: by.s ?? 0,
      allReady: total > 0 && ready === total,
    },
    slot: {
      name: slot,
      exists: Boolean(slotRow),
      active: Boolean(slotRow?.active),
      walRetainedMb: Math.round(Number(slotRow?.retained_bytes ?? 0) / 1_048_576),
      // L-6: clamp to 0 — pg_wal_lsn_diff can transiently return a negative value
      // (confirmed_flush_lsn momentarily exceeds pg_current_wal_lsn during slot
      // recreation). Negative lag has no meaningful interpretation for callers.
      lagBytes: Math.max(0, Number(slotRow?.lag_bytes ?? 0)),
    },
  };
}

export function printStatus(s: StatusSnapshot): void {
  log.step("status");
  log.detail(
    `subscription ${s.subscription.name}: ${s.subscription.exists ? (s.subscription.enabled ? "enabled" : "disabled") : "absent"}`,
  );
  log.detail(
    `tables ${s.tables.ready}/${s.tables.total} ready (init=${s.tables.init} copy=${s.tables.copying} synced=${s.tables.synced})`,
  );
  log.detail(
    `slot ${s.slot.name}: ${s.slot.exists ? (s.slot.active ? "active" : "INACTIVE") : "absent"} | WAL retained ${s.slot.walRetainedMb}MB | lag ${(s.slot.lagBytes / 1_048_576).toFixed(1)}MB`,
  );
  s.tables.allReady ? log.ok("all tables synced") : log.warn("not fully synced");
}
