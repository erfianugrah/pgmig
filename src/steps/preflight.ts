import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import {
  checkForeignReplicationSlots,
  checkReplicationCapacity,
  subscribeGrantSQL,
} from "./checks.ts";

/** Read-only checks that must pass before we touch anything. Throws on hard failures. */
export async function preflight(source: Db, target: Db, cfg: Config): Promise<void> {
  log.step("preflight");
  if (cfg.source.engine !== "postgres") {
    throw new Error(
      `preflight is postgres-only (wal_level, pg_publication, replica identity) - source.engine ` +
        `is '${cfg.source.engine}'. There is no equivalent pre-check for the Debezium engine yet; ` +
        "run 'pgmig replicate' directly for a heterogeneous source.",
    );
  }
  let hardFail = false;

  // 1. Postgres versions
  const [srcV] = await source`SHOW server_version_num`;
  const [tgtV] = await target`SHOW server_version_num`;
  const srcNum = Number(srcV?.server_version_num ?? 0);
  const tgtNum = Number(tgtV?.server_version_num ?? 0);
  log.detail(`source PG ${srcNum} / target PG ${tgtNum}`);
  // M-8: raise floor to PG15; pg_stat_subscription_stats (used in watch) is PG15+
  if (srcNum < 150_000) {
    log.err(
      "source is < PG15 — logical replication is available from PG10 but this tool requires PG15+ (pg_stat_subscription_stats, pg_stat_progress_copy)",
    );
    hardFail = true;
  }
  if (tgtNum < 150_000) {
    log.err("target is < PG15 — same requirement as source");
    hardFail = true;
  }
  if (tgtNum < srcNum) {
    log.warn(
      "target major version is older than source — logical replication may reject some types",
    );
  }

  // 2. wal_level on source
  const [wal] = await source`SHOW wal_level`;
  if (wal?.wal_level !== "logical") {
    log.err(`source wal_level=${wal?.wal_level} (need 'logical')`);
    hardFail = true;
  } else {
    log.ok("source wal_level=logical");
  }

  // 2b. Replication-capacity GUCs (warn-only): slot/sender headroom on source,
  //     worker-process floor on target (the Azure Flexible Server footgun).
  await checkReplicationCapacity(source, target, cfg, {
    ok: (m) => log.ok(m),
    warn: (m) => log.warn(m),
  });

  // 3. Target can CREATE SUBSCRIPTION (documented-supported, but verify the role grant).
  //    PG16+: needs pg_create_subscription membership; PG15: superuser only.
  //    C-1: pg_has_role('pg_create_subscription') throws on PG15 — version-gate the SQL.
  const [sub] = await target.unsafe(subscribeGrantSQL(tgtNum));
  const canSubscribe = sub?.is_super || sub?.has_grant;
  if (canSubscribe) {
    log.ok("target role can CREATE SUBSCRIPTION");
  } else if (tgtNum < 160_000) {
    log.warn(
      "PG15 target + non-superuser role — CREATE SUBSCRIPTION may be blocked; smoke-test before relying on it",
    );
  } else {
    log.err("target role lacks pg_create_subscription membership");
    hardFail = true;
  }

  // 4. Every published table has a replica identity (PK / replica index / FULL).
  //    M-10: also check for partitioned tables — reconcile uses ONLY which skips children.
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [r] = await source`
      SELECT c.relreplident, c.relkind,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema ?? ""} AND c.relname = ${table ?? ""}`;
    if (!r) {
      log.err(`published table ${qt} not found on source`);
      hardFail = true;
      continue;
    }
    if (r.relkind === "p") {
      log.warn(
        `${qt} is a PARTITIONED TABLE — reconcile scans ONLY the parent partition root and ` +
          "will miss rows in child partitions. Either reconcile each partition individually or use `--mode full` with caution.",
      );
    }
    // relreplident: d=default(uses PK), f=full, i=index, n=nothing.
    // A PK existing is NOT enough — if relreplident='n' there is no replica
    // identity even with a PK present, and UPDATE/DELETE replication fails.
    const ok =
      (r.relreplident === "d" && r.has_pk) || r.relreplident === "f" || r.relreplident === "i";
    if (ok) {
      log.ok(`${qt} has replica identity (${r.relreplident === "d" ? "PK" : r.relreplident})`);
    } else {
      log.err(
        `${qt} has no replica identity — UPDATE/DELETE will fail. Set REPLICA IDENTITY FULL.`,
      );
      hardFail = true;
    }
  }

  // 5. Name collisions on source (stale slot/publication from a previous run).
  const [existingSlot] = await source`
    SELECT 1 FROM pg_replication_slots WHERE slot_name = ${cfg.replication.slot}`;
  if (existingSlot)
    log.warn(`slot ${cfg.replication.slot} already exists on source — teardown a prior run first`);
  const [existingPub] = await source`
    SELECT 1 FROM pg_publication WHERE pubname = ${cfg.replication.publication}`;
  if (existingPub) log.warn(`publication ${cfg.replication.publication} already exists on source`);

  // 6. Foreign logical replication slots (competing CDC consumers: Artie/ClickPipes/PeerDB/
  //    Debezium) - an undiscovered one of these has aborted a real migration the night before
  //    cutover. Warn-only; catch it here instead of mid-run.
  await checkForeignReplicationSlots(source, cfg, {
    ok: (m) => log.ok(m),
    warn: (m) => log.warn(m),
  });

  if (hardFail) throw new Error("preflight failed — resolve the ✗ items above before continuing");
  log.ok("preflight passed");
}
