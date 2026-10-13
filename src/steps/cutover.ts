import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { qi, withRetry } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Final cutover. Caller MUST have already stopped application writes to the source.
 *  0. refuse unless every table of our subscription finished initial sync ('r')
 *  1. wait for replication lag -> 0
 *  2. (sequences) re-sync any sequences listed (none for uuid/text PKs)
 *  3. drop the subscription on the target (safely: DISABLE → detach slot → DROP)
 *
 * Does NOT repoint your app or re-enable source writes — that is a human decision.
 * Never re-enable writes on the source afterwards (split-brain).
 */
export async function cutover(
  source: Db,
  target: Db,
  cfg: Config,
  opts: { sequences?: string[]; maxLagWaitSec?: number },
): Promise<void> {
  log.step("cutover");
  log.warn("Assuming application writes to the SOURCE are already stopped. If not, stop them now.");

  const { subscription, slot } = cfg.replication;
  const deadline = Date.now() + (opts.maxLagWaitSec ?? 300) * 1000;

  // initial-sync gate: standalone `cutover` (no preceding `watch`) must not drop a
  // subscription whose tables are still copying - the target would be missing rows
  // for good. Only 'r' counts as done, same as watch: 's' (synced) is a transient
  // hand-off state the apply worker moves to 'r' on its own.
  const states = await withRetry(
    () =>
      target<{ srsubstate: string; n: number }[]>`
        SELECT srsubstate, count(*)::int AS n FROM pg_subscription_rel
        JOIN pg_subscription s ON s.oid = srsubid AND s.subname = ${subscription}
        GROUP BY srsubstate`,
    "cutover/sync-check",
  );
  const total = states.reduce((a, s) => a + Number(s.n), 0);
  if (total === 0) {
    throw new Error(
      `subscription "${subscription}" has no tables in pg_subscription_rel on the target - ` +
        "check the subscription name in config and that `replicate` ran; refusing to cut over.",
    );
  }
  const notReady = states.filter((s) => s.srsubstate !== "r");
  if (notReady.length > 0) {
    const n = notReady.reduce((a, s) => a + Number(s.n), 0);
    const by = notReady.map((s) => `${s.srsubstate}=${s.n}`).join(", ");
    throw new Error(
      `initial sync incomplete: ${n} of ${total} table(s) not ready (${by}; need srsubstate='r'). ` +
        "Run `pgmig watch` until every table is ready, then cut over.",
    );
  }
  log.ok(`all ${total} tables ready (srsubstate='r')`);

  // 0. quiesce check: confirm the SOURCE is actually write-stopped before draining.
  //    If WAL is still advancing AND client backends are running write queries,
  //    writes are NOT stopped — draining to lag=0 is impossible and cutting over
  //    now would lose post-cutover writes. Warn loudly (autovacuum etc. can move
  //    WAL too, so this is a strong signal, not a hard stop).
  const [r1] = await source<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  await sleep(1500);
  const [r2] = await source<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  const lsn1 = r1?.lsn;
  const lsn2 = r2?.lsn;
  if (lsn1 !== lsn2) {
    const [w] = await source`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND state = 'active'
        AND pid <> pg_backend_pid()
        AND query !~* '^[[:space:]]*(select|copy|with|show|set|start_replication|fetch)'`;
    const n = w?.n ?? 0;
    log.warn(
      `source WAL still advancing (${lsn1} -> ${lsn2}) with ${n} active write-shaped ` +
        `client backend(s). Application writes do NOT appear stopped — draining to lag=0 ` +
        `may never complete, and any writes after this point will be LOST at cutover. ` +
        `Stop application writes to the source before proceeding.`,
    );
  } else {
    log.ok("source WAL quiescent — writes appear stopped");
  }

  // 1. drain lag
  // H-5: wrap each poll query in withRetry — a transient network blip at the most
  // irreversible step of the migration must not abort cutover mid-drain.
  for (;;) {
    const [row] = await withRetry(
      () =>
        source`
          SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
          FROM pg_replication_slots WHERE slot_name = ${slot}`,
      "cutover/lag-drain",
    );
    // No row = the slot does not exist, so nothing proves the subscriber caught up.
    if (!row) {
      throw new Error(
        `replication slot "${slot}" not found on the source - cannot confirm lag drained; ` +
          "refusing to cut over (check replication.slot in config).",
      );
    }
    // confirmed_flush_lsn NULL (slot never confirmed a flush) -> lag_bytes NULL:
    // unknown, so keep waiting rather than reading it as zero.
    const lag = row.lag_bytes === null ? null : Number(row.lag_bytes);
    log.info(
      lag === null
        ? "replication lag unknown (confirmed_flush_lsn is NULL)"
        : `replication lag ${(lag / 1024).toFixed(1)} KB`,
    );
    if (lag !== null && lag <= 0) {
      log.ok("lag drained to zero");
      break;
    }
    if (Date.now() > deadline)
      throw new Error("lag did not drain in time — are writes really stopped?");
    await sleep(2000);
  }

  // 2. sequence re-sync. Logical replication does NOT replicate sequence values,
  //    so any serial/identity sequence on the target is stuck at its post-schema-load
  //    value and the next insert would collide with a replicated row. Discover every
  //    sequence OWNED BY a column of a replicated table, read its final value on the
  //    (now write-stopped) source, and setval it on the target. Safe because writes
  //    are stopped and lag is drained, so source values are final. No-op for
  //    uuid/text-PK schemas (zero owned sequences).
  const ownedSeqs = await source<{ seq: string }[]>`
    SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname) AS seq
    FROM pg_class s
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                    AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE s.relkind = 'S'
      AND (tn.nspname || '.' || t.relname) = ANY(${cfg.replication.tables})`;
  const seqs = [...new Set([...ownedSeqs.map((r) => r.seq), ...(opts.sequences ?? [])])];
  if (seqs.length === 0) {
    log.detail("no owned sequences among replicated tables — nothing to re-sync");
  }
  for (const seq of seqs) {
    try {
      const [sv] = await source<{ last_value: string; is_called: boolean }[]>`
        SELECT last_value, is_called FROM ${source.unsafe(seq)}`;
      if (!sv) {
        log.warn(`sequence ${seq} not readable on source — resync it manually`);
        continue;
      }
      await target.unsafe(`SELECT setval($1, $2, $3)`, [seq, sv.last_value, sv.is_called]);
      log.ok(`sequence ${seq} set to ${sv.last_value} (is_called=${sv.is_called}) on target`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(
        `sequence ${seq} resync failed (${msg}) — set it manually before re-enabling inserts`,
      );
    }
  }

  // 3. drop subscription — C-4: use the safe three-step sequence from teardown.ts:
  //    DISABLE (stops the walreceiver) → SET slot_name=NONE (detaches remote slot so
  //    DROP doesn't try to drop it on the source) → DROP.
  //    Skipping DISABLE risks a DROP that hangs waiting for an active walreceiver.
  await target.unsafe(`ALTER SUBSCRIPTION ${qi(subscription)} DISABLE`);
  await target.unsafe(`ALTER SUBSCRIPTION ${qi(subscription)} SET (slot_name = NONE)`);
  await target.unsafe(`DROP SUBSCRIPTION ${qi(subscription)}`);
  log.ok(`dropped subscription ${subscription}`);
  log.warn(
    "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
  );
}
