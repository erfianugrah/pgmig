/**
 * Shared SQL helpers used by both preflight.ts and doctor.ts.
 * Centralising here ensures C-1 (pg_has_role PG15 crash) is fixed once and
 * stays fixed — both callers import the same version-gated query builder.
 */

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";

/** Minimal emit interface so preflight (log.*) and doctor (Sink) can both drive the check. */
export interface CapacitySink {
  ok(msg: string): void;
  warn(msg: string): void;
}

/**
 * Replication-capacity GUC check (warn-only — never a hard fail).
 *
 * Catches the silent under-provisioning that bites managed Postgres in
 * particular: **Azure Database for PostgreSQL Flexible Server** ships a low
 * `max_worker_processes` by default, and logical apply/table-sync workers run
 * as background workers on the SUBSCRIBER — too few and the subscription stalls
 * with `out of background worker slots` (Azure's documented footgun). The slot/
 * sender checks catch a source that simply has no room to create the slot.
 *
 * Thresholds:
 *  - source `max_replication_slots` / `max_wal_senders`: must have headroom for
 *    the one slot+walsender this tool adds (warn if already saturated).
 *  - target `max_worker_processes` >= 16 (Azure's own recommended floor) and
 *    `max_logical_replication_workers` >= tables + 1 (parallel initial sync).
 */
export async function checkReplicationCapacity(
  source: Db,
  target: Db,
  cfg: Config,
  sink: CapacitySink,
): Promise<void> {
  const tables = cfg.replication.tables.length;

  const [src] = await source`
    SELECT current_setting('max_replication_slots')::int AS slots,
           current_setting('max_wal_senders')::int      AS senders,
           (SELECT count(*)::int FROM pg_replication_slots) AS used_slots,
           (SELECT count(*)::int FROM pg_stat_replication)   AS used_senders`;
  const slots = Number(src?.slots ?? 0);
  const senders = Number(src?.senders ?? 0);
  const usedSlots = Number(src?.used_slots ?? 0);
  const usedSenders = Number(src?.used_senders ?? 0);
  usedSlots < slots
    ? sink.ok(`source max_replication_slots=${slots} (${usedSlots} in use — room for the new slot)`)
    : sink.warn(
        `source max_replication_slots=${slots} but ${usedSlots} already in use — no room to create ` +
          `the slot. Raise max_replication_slots and restart.`,
      );
  if (senders <= usedSenders)
    sink.warn(
      `source max_wal_senders=${senders} with ${usedSenders} active — raise it (>= active + 1) so ` +
        `the slot can stream.`,
    );

  const [tgt] = await target`
    SELECT current_setting('max_worker_processes')::int            AS workers,
           current_setting('max_logical_replication_workers')::int AS lr_workers`;
  const workers = Number(tgt?.workers ?? 0);
  const lrWorkers = Number(tgt?.lr_workers ?? 0);
  workers >= 16
    ? sink.ok(`target max_worker_processes=${workers}`)
    : sink.warn(
        `target max_worker_processes=${workers} — raise to >= 16. Logical apply/table-sync run as ` +
          `background workers on the subscriber; too few stalls the subscription with ` +
          `"out of background worker slots" (Azure Flexible Server ships a low default).`,
      );
  if (lrWorkers < tables + 1)
    sink.warn(
      `target max_logical_replication_workers=${lrWorkers} for ${tables} tables — raise to >= ` +
        `${tables + 1} so initial table sync can parallelise (1 apply worker + N sync workers).`,
    );
}

export interface ReplicationSlotRow {
  slot_name: string;
  plugin: string | null;
  active: boolean;
}

/**
 * Pure: logical replication slots present on the source that are NOT ours - a potential
 * competing CDC consumer (Artie, ClickPipes, PeerDB, Debezium, ...). An UNDISCOVERED one of
 * these has aborted a real migration the night before cutover: it can hold WAL retention
 * hostage and interact unpredictably with this tool's own slot/publication. Physical slots
 * (streaming replicas, pg_basebackup) are excluded by the caller's query - a different risk
 * already covered by `checkReplicationCapacity`'s slot/sender headroom check.
 */
export function foreignLogicalSlots(
  rows: ReplicationSlotRow[],
  ourSlot: string,
): ReplicationSlotRow[] {
  return rows
    .filter((r) => r.slot_name !== ourSlot)
    .sort((a, b) => a.slot_name.localeCompare(b.slot_name));
}

/**
 * Report any logical replication slot on the source that isn't ours. Warn-only - a slot
 * existing doesn't necessarily conflict, but an undiscovered one is exactly what has aborted
 * migrations at the worst possible time (the night before cutover). Surfacing every logical
 * slot up front turns that into a pre-flight question instead of a live-run surprise.
 */
export async function checkForeignReplicationSlots(
  source: Db,
  cfg: Config,
  sink: CapacitySink,
): Promise<void> {
  const rows = await source<ReplicationSlotRow[]>`
    SELECT slot_name, plugin, active FROM pg_replication_slots WHERE slot_type = 'logical'`;
  const foreign = foreignLogicalSlots(rows, cfg.replication.slot);
  if (foreign.length === 0) {
    sink.ok("no foreign logical replication slots on source (no competing CDC consumers found)");
    return;
  }
  for (const f of foreign) {
    sink.warn(
      `foreign logical replication slot on source: "${f.slot_name}" (plugin=${f.plugin ?? "?"}, ` +
        `active=${f.active}) - a competing CDC consumer (e.g. Artie, ClickPipes, PeerDB, Debezium) ` +
        "can hold WAL retention and interact unpredictably with this migration. Confirm it's " +
        "expected and accounted for before running `replicate`.",
    );
  }
}

/**
 * "Invisible" custom Postgres config detection.
 *
 * The Management API's `/config/database/postgres` endpoint (config-sync's
 * `dbPostgres` section) only carries the subset of GUCs Supabase exposes there.
 * It does NOT see settings applied directly in SQL via
 * `ALTER ROLE ... SET` / `ALTER DATABASE ... SET` (statement_timeout,
 * auto_explain.*, pg_stat_statements.*, pgaudit.*, session_replication_role,
 * ...). Those live in `pg_db_role_setting` and are invisible to config-sync —
 * exactly the gap. Because pgmig has a direct DB connection we CAN read them,
 * diff source vs target, and tell the operator what to re-apply.
 *
 * We deliberately DETECT + REPORT, never auto-copy: many of these are tuned to
 * the source's compute add-on (shared_buffers, work_mem, max_connections) and
 * blindly applying them onto a smaller target causes instability — Supabase's
 * own docs warn to review custom config when compute changes.
 */
export interface GucOverride {
  /** `<role>@<database>` scope; `*` where the row is role- or db-wide. */
  scope: string;
  key: string;
  value: string;
}

/** Parse pg_db_role_setting rows (setconfig is a text[] of `key=value`). Exported for tests. */
export function parseRoleSettings(
  rows: Array<{ rolname?: string | null; datname?: string | null; setconfig?: string[] | null }>,
): GucOverride[] {
  const out: GucOverride[] = [];
  for (const r of rows) {
    const scope = `${r.rolname ?? "*"}@${r.datname ?? "*"}`;
    for (const kv of r.setconfig ?? []) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      out.push({ scope, key: kv.slice(0, eq), value: kv.slice(eq + 1) });
    }
  }
  return out;
}

/** GUCs whose value is tuned to compute size — must be reviewed, never blindly copied. */
export const COMPUTE_TUNED = new Set([
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "maintenance_work_mem",
  "max_connections",
  "max_parallel_workers",
  "max_parallel_workers_per_gather",
  "max_parallel_maintenance_workers",
  "max_worker_processes",
  "max_wal_size",
]);

export interface GucDiff {
  /** present on source, absent on target. */
  sourceOnly: GucOverride[];
  /** same scope+key on both, but the value differs. */
  changed: Array<{ scope: string; key: string; source: string; target: string }>;
}

/** Pure diff of source vs target GUC overrides. Exported for tests. */
export function diffGucOverrides(src: GucOverride[], tgt: GucOverride[]): GucDiff {
  const tgtMap = new Map(tgt.map((o) => [`${o.scope}\u0000${o.key}`, o.value]));
  const sourceOnly: GucOverride[] = [];
  const changed: GucDiff["changed"] = [];
  for (const o of src) {
    const k = `${o.scope}\u0000${o.key}`;
    if (!tgtMap.has(k)) sourceOnly.push(o);
    else if (tgtMap.get(k) !== o.value) {
      changed.push({
        scope: o.scope,
        key: o.key,
        source: o.value,
        target: tgtMap.get(k) as string,
      });
    }
  }
  return { sourceOnly, changed };
}

const ROLE_SETTING_SQL = `
  SELECT r.rolname, d.datname, s.setconfig
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r    ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase`;

/**
 * Report custom ALTER ROLE/DATABASE GUC overrides on the source that are
 * missing or different on the target. Warn-only — these are the config-sync
 * blind spot, and compute-tuned ones are flagged for manual review.
 */
export async function checkCustomPostgresConfig(
  source: Db,
  target: Db,
  sink: CapacitySink,
): Promise<void> {
  const [srcRows, tgtRows] = await Promise.all([
    source.unsafe(ROLE_SETTING_SQL),
    target.unsafe(ROLE_SETTING_SQL),
  ]);
  const src = parseRoleSettings(srcRows as never);
  const tgt = parseRoleSettings(tgtRows as never);

  if (src.length === 0) {
    sink.ok("no custom ALTER ROLE/DATABASE GUC overrides on source");
    return;
  }
  const { sourceOnly, changed } = diffGucOverrides(src, tgt);
  if (sourceOnly.length === 0 && changed.length === 0) {
    sink.ok(`source has ${src.length} custom GUC override(s) — all present on target`);
    return;
  }
  for (const o of sourceOnly) {
    const tuned = COMPUTE_TUNED.has(o.key) ? " [compute-tuned — review before copying]" : "";
    sink.warn(`custom GUC missing on target: ${o.scope} ${o.key}=${o.value}${tuned}`);
  }
  for (const c of changed) {
    sink.warn(`custom GUC differs: ${c.scope} ${c.key} — source=${c.source} target=${c.target}`);
  }
  sink.warn(
    "These are SQL-level overrides (pg_db_role_setting) — config-sync's Management-API endpoint does " +
      "NOT carry them. Re-apply intentionally via ALTER ROLE/DATABASE ... SET; do not blindly copy " +
      "compute-tuned values onto a smaller target.",
  );
}

/**
 * Version-gated SQL for the CREATE SUBSCRIPTION privilege check.
 *
 * `pg_create_subscription` is a PG16+ role; calling
 * `pg_has_role(current_user, 'pg_create_subscription', 'MEMBER')` on PG15
 * throws "role does not exist" before any version-guard branch is reached.
 * On PG15 we return `false` for has_grant and let the caller fall through to
 * the superuser check.
 */
export function subscribeGrantSQL(pgNum: number): string {
  return pgNum >= 160_000
    ? `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              pg_has_role(current_user, 'pg_create_subscription', 'MEMBER') AS has_grant`
    : `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              false AS has_grant`;
}
