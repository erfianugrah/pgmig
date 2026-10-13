import { classifyConn, type Db } from "../db.ts";
import { log } from "../log.ts";
import { SUPABASE_MANAGED_SCHEMAS } from "../steps/bootstrap.ts";
import { EXTENSION_UPDATE_RISK } from "../steps/doctor.ts";
import {
  BASELINE_EXTENSIONS,
  CRON_HISTORY_SIZE_SQL,
  CUSTOM_OPERATOR_ESTIMATORS_SQL,
  DB_SIZE_SQL,
  deprecatedOnTarget,
  EXTENSION_INVENTORY_SQL,
  estimateUpgradeDowntime,
  LOGICAL_SLOTS_SQL,
  LTREE_INDEXES_SQL,
  LTREE_REINDEX_NEEDED_SQL,
  MD5_ROLES_SQL,
  partitionRegTypeColumns,
  preUpgradeChecklist,
  REGTYPE_COLUMNS_SQL,
  REGTYPE_EXTENSION_OWNED_SQL,
  renderEstimate,
  SERVER_VERSION_SQL,
} from "./kb.ts";
import { isSupabaseProject } from "./source.ts";

/**
 * `upgrade doctor` - a read-only readiness audit for a Postgres MAJOR-version
 * upgrade (the pg_upgrade path), against the source project only. Complements
 * the migration `doctor`: that one gates logical-replication readiness, this
 * one gates "will pg_upgrade and the platform upgrade flow accept this
 * database, and what will surprise me afterwards".
 *
 * Fail-closed on hard blockers (deprecated extensions on the target major,
 * reg* columns, logical slots); warns on everything recoverable.
 */

export interface UpgradeDoctorReport {
  pass: number;
  warn: number;
  fail: number;
}

interface Sink {
  ok: (m: string) => void;
  warn: (m: string) => void;
  fail: (m: string) => void;
}

interface ExtRow {
  extname: string;
  extversion: string;
  external_dependents: number;
}

export interface UpgradeDoctorOpts {
  /** Target major version (e.g. 17). */
  to: number;
  /** Source connection string (for provider detection -> checklist extras). */
  sourceUrl: string;
  /** Assumed disk copy throughput for the downtime estimate (MB/s, megabytes). */
  copyMBps?: number;
  /** Fixed platform overhead for the downtime estimate (seconds). */
  fixedOverheadSec?: number;
}

export async function upgradeDoctor(db: Db, opts: UpgradeDoctorOpts): Promise<UpgradeDoctorReport> {
  const r: UpgradeDoctorReport = { pass: 0, warn: 0, fail: 0 };
  const sink: Sink = {
    ok: (m) => {
      r.pass++;
      log.ok(m);
    },
    warn: (m) => {
      r.warn++;
      log.warn(m);
    },
    fail: (m) => {
      r.fail++;
      log.err(m);
    },
  };

  const [ver] = await db.unsafe(SERVER_VERSION_SQL);
  const serverVersion = String(ver?.server_version ?? "unknown");
  const fromMajor = Number.parseInt(serverVersion, 10);
  log.step(`upgrade doctor: PG ${serverVersion} -> ${opts.to}`);
  if (Number.isFinite(fromMajor)) {
    if (fromMajor >= opts.to) {
      sink.fail(
        `source is already on ${serverVersion} - target major ${opts.to} is not an upgrade`,
      );
      return summarize(r);
    }
    sink.ok(`upgrade path PG ${fromMajor} -> ${opts.to}`);
  } else {
    sink.warn(`could not parse source major from '${serverVersion}' - continuing anyway`);
  }

  const isSupabase = await isSupabaseProject(db);
  await extensionChecks(db, opts.to, sink);
  await blockerChecks(db, sink, isSupabase);
  await sizeAndEstimate(db, opts, sink);
  await postUpgradeSurfacing(db, opts.to, sink);

  const provider = isSupabase ? "supabase" : classifyConn(opts.sourceUrl).provider;
  log.step("upgrade doctor: pre-upgrade checklist");
  for (const item of preUpgradeChecklist(provider)) log.detail(`[ ] ${item}`);

  return summarize(r);
}

function summarize(r: UpgradeDoctorReport): UpgradeDoctorReport {
  log.step("upgrade doctor: summary");
  const verdict = r.fail > 0 ? "NOT READY" : r.warn > 0 ? "READY (with warnings)" : "READY";
  log.detail(`${r.pass} pass / ${r.warn} warn / ${r.fail} fail`);
  r.fail > 0 ? log.err(verdict) : log.ok(verdict);
  return r;
}

async function extensionChecks(db: Db, to: number, s: Sink): Promise<void> {
  log.step("upgrade doctor: extensions");
  const exts = await db.unsafe<ExtRow[]>(EXTENSION_INVENTORY_SQL);
  const names = exts.map((e) => e.extname);

  const deprecated = deprecatedOnTarget(names, to);
  if (deprecated.length === 0) {
    s.ok(`no installed extension is deprecated on PG${to}`);
  }
  for (const d of deprecated) {
    s.fail(`extension '${d.extname}' must be DROPPED before upgrading to PG${to} - ${d.note}`);
  }

  for (const e of exts) {
    const risk = EXTENSION_UPDATE_RISK[e.extname];
    if (risk)
      s.warn(`extension '${e.extname}' (${e.extversion}) has an upgrade-risk history: ${risk}`);
    if (e.external_dependents === 0 && !BASELINE_EXTENSIONS.has(e.extname)) {
      s.warn(
        `extension '${e.extname}' has ZERO in-database dependents - possibly unused. ` +
          `Verify by app code search, then drop before the upgrade (fewer extensions = fewer failure modes)`,
      );
    }
  }
  log.detail(
    `installed: ${exts.map((e) => `${e.extname}@${e.extversion}`).join(", ") || "(none beyond baseline)"}`,
  );
}

async function blockerChecks(db: Db, s: Sink, isSupabase: boolean): Promise<void> {
  log.step("upgrade doctor: hard blockers");

  const regCols =
    await db.unsafe<{ schema: string; table: string; column: string; type: string }[]>(
      REGTYPE_COLUMNS_SQL,
    );
  const { user: regUser, managed: regManaged } = isSupabase
    ? partitionRegTypeColumns(regCols, SUPABASE_MANAGED_SCHEMAS)
    : { user: regCols, managed: [] };
  if (regCols.length === 0) {
    s.ok("no reg* columns referencing system OIDs (pg_upgrade accepts the cluster)");
  }
  if (regManaged.length > 0) {
    s.warn(
      `${regManaged.length} reg* column(s) in platform-MANAGED schemas ` +
        `(${[...new Set(regManaged.map((c) => `${c.schema}.${c.table}`))].join(", ")}) - ` +
        "the managed upgrade flow recreates its own schemas, so these are informational, " +
        "not operator blockers; flag them in the staging dry-run to confirm",
    );
  }
  if (regUser.length > 0) {
    const extOwned = new Set(
      (await db.unsafe<{ table: string }[]>(REGTYPE_EXTENSION_OWNED_SQL)).map((r) => r.table),
    );
    const describe = regUser.map((c) => {
      const owner = extOwned.has(`${c.schema}.${c.table}`) ? " [extension-owned]" : "";
      return `${c.schema}.${c.table}.${c.column} (${c.type})${owner}`;
    });
    const allExtOwned = regUser.every((c) => extOwned.has(`${c.schema}.${c.table}`));
    s.fail(
      `${regUser.length} reg* column(s) referencing system OIDs - pg_upgrade REFUSES these: ` +
        describe.join(", ") +
        (allExtOwned
          ? ". ALL are extension-owned: dropping the extension(s) clears them."
          : ". Convert user-table data (e.g. store names as text); [extension-owned] ones clear when the extension is dropped."),
    );
  }

  const slots =
    await db.unsafe<{ slot_name: string; database: string; active: boolean; temporary: boolean }[]>(
      LOGICAL_SLOTS_SQL,
    );
  const permanent = slots.filter((sl) => !sl.temporary);
  if (permanent.length === 0) {
    s.ok("no logical replication slots (upgrade prerequisite met)");
  } else {
    s.fail(
      `${permanent.length} logical replication slot(s) must be DROPPED before the upgrade: ` +
        permanent
          .map((sl) => `${sl.slot_name} (db ${sl.database}${sl.active ? ", ACTIVE" : ""})`)
          .join(", ") +
        ". NOTE: includes any slot a live subscriber depends on - coordinate the drop with the consumer.",
    );
  }

  try {
    const md5 = await db.unsafe<{ rolname: string }[]>(MD5_ROLES_SQL);
    if (md5.length === 0) {
      s.ok("no login roles on md5 password hashing");
    } else {
      s.warn(
        `${md5.length} custom role(s) still on md5 password hashing - they cannot connect after ` +
          `the upgrade until re-passworded: ${md5.map((m) => m.rolname).join(", ")}. ` +
          `Fix: ALTER ROLE <name> WITH PASSWORD '<password>' (moves them to scram-sha-256).`,
      );
    }
  } catch {
    s.warn(
      "could not read pg_authid (insufficient privilege on this platform) - md5-password check " +
        "skipped; audit custom roles by hand",
    );
  }
}

async function sizeAndEstimate(db: Db, opts: UpgradeDoctorOpts, s: Sink): Promise<void> {
  log.step("upgrade doctor: size + downtime estimate");
  const [row] = await db.unsafe<{ bytes: string; user_objects: number }[]>(DB_SIZE_SQL);
  const bytes = Number(row?.bytes ?? 0);
  const gib = (bytes / 1_073_741_824).toFixed(2);
  const est = estimateUpgradeDowntime(bytes, {
    copyMBps: opts.copyMBps,
    fixedOverheadSec: opts.fixedOverheadSec,
  });
  s.ok(
    `database ${gib} GiB, ${row?.user_objects ?? "?"} user objects - estimated downtime window ` +
      `${renderEstimate(est)} (mostly fixed platform overhead at this size)`,
  );
  for (const a of est.assumptions) log.detail(`assumption: ${a}`);
  if (bytes > 50 * 1_073_741_824) {
    s.warn(
      `${gib} GiB is large for a first rehearsal - shrink the lab copy (archive/drop) or ` +
        `expect the copy term to dominate the window`,
    );
  }
}

async function postUpgradeSurfacing(db: Db, to: number, s: Sink): Promise<void> {
  log.step("upgrade doctor: post-upgrade surfacing");

  const cron = await db.unsafe<{ bytes: string | null }[]>(CRON_HISTORY_SIZE_SQL);
  const cronBytes = cron[0]?.bytes == null ? null : Number(cron[0].bytes);
  if (cronBytes != null) {
    const mb = (cronBytes / 1_048_576).toFixed(0);
    (cronBytes > 1_073_741_824 ? s.warn : s.ok)(
      `pg_cron cron.job_run_details is ${mb} MB - it is DUPLICATED during the platform upgrade; ` +
        (cronBytes > 1_073_741_824
          ? "prune it first or the instantaneous disk pressure can fail the upgrade"
          : "small enough not to threaten the upgrade"),
    );
  }

  const [ltreeNeed] =
    await db.unsafe<{ encoding: string; collation_provider: string; reindex_required: boolean }[]>(
      LTREE_REINDEX_NEEDED_SQL,
    );
  const ltreeIdx =
    await db.unsafe<{ schemaname: string; tablename: string; indexname: string }[]>(
      LTREE_INDEXES_SQL,
    );
  if (ltreeIdx.length > 0 && ltreeNeed?.reindex_required) {
    s.warn(
      `${ltreeIdx.length} ltree index(es) on a ${ltreeNeed.encoding}/${ltreeNeed.collation_provider} ` +
        `database may return incomplete results after the upgrade until rebuilt: ` +
        ltreeIdx.map((i) => i.indexname).join(", ") +
        ". Plan REINDEX INDEX CONCURRENTLY <name> post-upgrade (online, no downtime).",
    );
  } else if (ltreeIdx.length > 0) {
    s.ok(
      `${ltreeIdx.length} ltree index(es) present but encoding/collation do not force a reindex`,
    );
  }

  const ops = await db.unsafe<{ schema: string; operator: string }[]>(
    CUSTOM_OPERATOR_ESTIMATORS_SQL,
  );
  if (ops.length > 0) {
    s.warn(
      `${ops.length} user operator(s) use a non-built-in selectivity estimator - recreating them ` +
        `(restore/branch) needs superuser on PG >= 15.18 / ${to}.10: ` +
        ops.map((o) => `${o.schema}.${o.operator}`).join(", "),
    );
  }
}
