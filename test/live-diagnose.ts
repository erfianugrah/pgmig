/**
 * Failure diagnostics for the live harnesses: what the subscriber and the
 * source said, read before the finally block deletes both projects.
 * Subscription stats come from the target over SQL; error lines come from each
 * project's logs through the Management API logs endpoint (ClickHouse SQL,
 * window at most 24 h, results capped at 1000 rows).
 */
import type { Db } from "../src/db.ts";
import { log } from "../src/log.ts";
import type { MgmtApi } from "../src/mgmt.ts";

async function logLines(api: MgmtApi, ref: string, pattern: string): Promise<string[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 3600_000);
  const sql =
    "select timestamp, event_message from logs where source = 'postgres_logs' " +
    `and (${pattern}) order by timestamp desc limit 25`;
  const qs = `sql=${encodeURIComponent(sql)}&iso_timestamp_start=${encodeURIComponent(start.toISOString())}&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await api.get<{
    result?: { timestamp?: unknown; event_message?: string }[];
    error?: unknown;
  }>(ref, `/analytics/endpoints/logs?${qs}`);
  if (r.body?.error) return [`logs endpoint error: ${JSON.stringify(r.body.error).slice(0, 200)}`];
  return (r.body?.result ?? []).map(
    (x) =>
      `${String(x.timestamp)} ${String(x.event_message ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 300)}`,
  );
}

export async function diagnose(
  api: MgmtApi,
  source: Db,
  target: Db,
  srcRef: string,
  tgtRef: string,
): Promise<void> {
  const stats = await target.unsafe(
    "select s.subname, s.apply_error_count, s.sync_error_count, r.srrelid::regclass::text as rel, r.srsubstate from pg_stat_subscription_stats s left join pg_subscription sub on sub.oid = s.subid left join pg_subscription_rel r on r.srsubid = sub.oid",
  );
  log.warn(`subscription stats: ${JSON.stringify(stats)}`);
  const slots = await source.unsafe(
    "select slot_name, slot_type, active, wal_status, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained from pg_replication_slots",
  );
  log.warn(`source slots: ${JSON.stringify(slots)}`);
  const timeouts = await source.unsafe(
    "select r.rolname, s.setconfig from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole where s.setconfig::text ~ '(timeout|wal_sender)'",
  );
  log.warn(`source role/database timeout settings: ${JSON.stringify(timeouts)}`);
  const pat =
    "event_message like '%logical replication%' or event_message like '%could not%' or event_message like '%canceling statement%' or event_message like '%terminating%' or event_message like '%timeout%'";
  for (const [label, ref] of [
    ["target", tgtRef],
    ["source", srcRef],
  ] as const) {
    const lines = await logLines(api, ref, pat);
    log.warn(`${label} postgres_logs (${lines.length} lines, newest first):`);
    for (const l of lines) log.detail(`  ${l}`);
  }
}
