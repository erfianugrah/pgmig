/**
 * Knowledge base for Postgres major-version upgrade rehearsal (the pg_upgrade path).
 *
 * Pure data + pure functions + SQL text constants only - every export is
 * unit-testable without a database. Grounded in the Supabase platform upgrade
 * guide (/docs/guides/platform/upgrading) and the Postgres release notes:
 *
 *  - Platform prerequisites: read replicas deleted first, logical replication
 *    slots dropped, reg* columns referencing system OIDs removed,
 *    deprecated/unsupported extensions dropped.
 *  - PG17 deprecates plcoffee / plls / plv8 / timescaledb / pgjwt (pgjwt was
 *    enabled by default on every project up to PG15 - "most likely safe to
 *    disable" if the app never calls sign()/verify()).
 *  - pg_cron is dropped + recreated during the platform upgrade and
 *    cron.job_run_details is duplicated first - prune it or the disk pressure
 *    can fail the upgrade.
 *  - Custom roles on md5 passwords must be moved to scram-sha-256.
 *  - ltree indexes may need a reindex (multibyte encoding / non-libc collation).
 *  - Non-built-in operator selectivity estimators now need superuser to (re)create.
 */

// ---------------------------------------------------------------------------
// Extension knowledge
// ---------------------------------------------------------------------------

/** Extensions deprecated on projects running a given Postgres major (Supabase platform). */
export const DEPRECATED_EXTENSIONS_BY_MAJOR: Record<number, Record<string, string>> = {
  17: {
    plcoffee: "deprecated on PG17 - drop before upgrading",
    plls: "deprecated on PG17 - drop before upgrading",
    plv8: "deprecated on PG17 - drop before upgrading (still supported on PG15 until its EOL)",
    timescaledb:
      "deprecated on PG17 - drop before upgrading; back up dependent data FIRST " +
      "(extension objects can own user data you must restore after, on the replacement)",
    pgjwt:
      "deprecated on PG17 - enabled by default on every project up to PG15; if the app " +
      "never calls sign()/verify() explicitly it is most likely safe to drop. (Measured: the " +
      "17.6 supabase/postgres image still ships pgjwt 0.2.0, so pg_upgrade does NOT hard-fail " +
      "on it - the risk is carrying an unsupported extension forward, not an upgrade blocker.)",
  },
};

export interface ExtensionHit {
  extname: string;
  note: string;
}

/** Pure: which installed extensions are deprecated on the target major. */
export function deprecatedOnTarget(installed: string[], targetMajor: number): ExtensionHit[] {
  const table = DEPRECATED_EXTENSIONS_BY_MAJOR[targetMajor] ?? {};
  return installed
    .filter((e) => e in table)
    .map((extname) => ({ extname, note: table[extname] as string }))
    .sort((a, b) => a.extname.localeCompare(b.extname));
}

/**
 * Extensions that are part of a normal Postgres/Supabase baseline and should
 * never be "unused"-flagged or dropped by an operator following this tool's
 * output. Everything else with zero external dependents is only a CANDIDATE -
 * the database cannot see app-side usage (and NEVER sees function-body calls,
 * which is how auth consumes pgcrypto), so the report says "verify by code
 * search", never "drop this". pgjwt is deliberately NOT baseline: it is the
 * canonical example of a platform-default extension most apps never call.
 */
export const BASELINE_EXTENSIONS = new Set([
  "plpgsql",
  "pg_stat_statements",
  // Supabase platform defaults (enabled on every project, consumed by the platform itself)
  "pgcrypto",
  "uuid-ossp",
  "pg_net",
  "pg_graphql",
  "supabase_vault",
]);

/**
 * supabase/postgres image tags per major, for the production-faithful lab
 * flavor (--image supabase). These are the same images hosted projects run.
 */
export const SUPABASE_POSTGRES_IMAGES: Record<number, string> = {
  15: "public.ecr.aws/supabase/postgres:15.8.1.085",
  17: "public.ecr.aws/supabase/postgres:17.6.1.140",
};

/**
 * Extensions implemented as background workers: the cluster must have them in
 * shared_preload_libraries BEFORE CREATE EXTENSION / before serving with them
 * installed (the supabase/postgres image preloads its own set in prod; the lab
 * must reproduce that on both the old and the upgraded cluster).
 */
export const PRELOAD_EXTENSIONS = new Set(["pg_net", "pg_cron", "timescaledb", "pg_tle"]);

/**
 * Pure: comment out GRANT lines whose GRANTED role is platform-reserved. On a
 * real Supabase target those grants are legitimate (the reserved roles exist),
 * which is why bootstrap's filterSupabaseRoles keeps them - but in the plain
 * lab containers they do not exist and the grant errors are pure noise. Lab-
 * side transform only; never applied to the migration bootstrap path.
 */
export function filterGrantsForLab(sql: string, reservedRoles: readonly string[]): string {
  if (reservedRoles.length === 0) return sql;
  const re = new RegExp(`^GRANT "(${reservedRoles.join("|")})" TO `);
  return sql
    .split("\n")
    .map((line) => (re.test(line) ? `-- ${line}` : line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Downtime estimation
// ---------------------------------------------------------------------------

export interface DowntimeEstimate {
  /** Seconds to copy the data directory at the assumed disk throughput. */
  dataCopySec: number;
  /** Fixed platform overhead (new instance boot, validations, post-upgrade base backup). */
  fixedOverheadSec: number;
  totalSecLow: number;
  totalSecHigh: number;
  assumptions: string[];
}

export interface DowntimeOpts {
  /**
   * Assumed disk copy throughput in megaBYTES/s (MB/s). The Supabase platform
   * guide's figure for a project on the default GP3 disk is ~100 MB/s during the
   * upgrade (megabytes, not megabits: ~10 s per GB); faster disk types / higher
   * IOPS reduce the copy time.
   */
  copyMBps: number;
  /** Fixed platform overhead in seconds (default 15 min). */
  fixedOverheadSec: number;
  /** Pessimism multiplier applied to the copy time for the high bound. */
  copyFudge: number;
}

export const DEFAULT_DOWNTIME_OPTS: DowntimeOpts = {
  copyMBps: 100,
  fixedOverheadSec: 900,
  copyFudge: 1.5,
};

/**
 * Pure: DEFAULT_DOWNTIME_OPTS overlaid with the DEFINED fields of `opts` (an
 * explicit undefined, e.g. an unset CLI option passed through, keeps the default),
 * validated so a bad flag is an error rather than "~NaN min" or Infinity.
 */
function resolveDowntimeOpts(opts: Partial<DowntimeOpts>): DowntimeOpts {
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const o: DowntimeOpts = { ...DEFAULT_DOWNTIME_OPTS, ...defined };
  if (!Number.isFinite(o.copyMBps) || o.copyMBps <= 0) {
    throw new Error(`invalid copy throughput ${o.copyMBps} MB/s: must be a positive number`);
  }
  if (!Number.isFinite(o.fixedOverheadSec) || o.fixedOverheadSec < 0) {
    throw new Error(`invalid fixed overhead ${o.fixedOverheadSec}s: must be a number >= 0`);
  }
  return o;
}

/**
 * Pure: the copy rate in MB/s from the `upgrade doctor` flags. `--copy-mbps` is
 * the deprecated megaBIT/s spelling (value / 8) and yields a one-line deprecation
 * note for the caller to print. Neither flag -> the default.
 */
export function resolveCopyMBps(flags: { copyMbPerSec?: string; copyMbps?: string }): {
  copyMBps: number;
  deprecation?: string;
} {
  const parse = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`${flag} must be a positive number, got '${raw}'`);
    }
    return n;
  };
  if (flags.copyMbPerSec !== undefined && flags.copyMbps !== undefined) {
    throw new Error("pass either --copy-mb-per-sec or the deprecated --copy-mbps, not both");
  }
  if (flags.copyMbps !== undefined) {
    const copyMBps = parse(flags.copyMbps, "--copy-mbps") / 8;
    return {
      copyMBps,
      deprecation: `--copy-mbps (megabits/s) is deprecated; use --copy-mb-per-sec ${copyMBps} (megabytes/s)`,
    };
  }
  if (flags.copyMbPerSec !== undefined) {
    return { copyMBps: parse(flags.copyMbPerSec, "--copy-mb-per-sec") };
  }
  return { copyMBps: DEFAULT_DOWNTIME_OPTS.copyMBps };
}

/**
 * Pure: estimated upgrade downtime window for a database of `sizeBytes`.
 * total = data-copy time + fixed platform overhead; the low bound assumes the
 * nominal throughput, the high bound a 1.5x slower copy and 1.25x overhead.
 */
export function estimateUpgradeDowntime(
  sizeBytes: number,
  opts: Partial<DowntimeOpts> = {},
): DowntimeEstimate {
  const o = resolveDowntimeOpts(opts);
  const bytesPerSec = o.copyMBps * 1_000_000;
  const dataCopySec = sizeBytes / bytesPerSec;
  const totalSecLow = Math.ceil(dataCopySec + o.fixedOverheadSec);
  const totalSecHigh = Math.ceil(dataCopySec * o.copyFudge + o.fixedOverheadSec * 1.25);
  return {
    dataCopySec,
    fixedOverheadSec: o.fixedOverheadSec,
    totalSecLow,
    totalSecHigh,
    assumptions: [
      `disk copy throughput ~${o.copyMBps} MB/s (Supabase default GP3; faster disk/IOPS shortens this)`,
      `fixed platform overhead ~${Math.round(o.fixedOverheadSec / 60)} min (instance provisioning, validations, post-upgrade base backup)`,
      "upgrade time also scales with OBJECT count (tables/indexes), not just bytes",
      "app-level validation time is NOT included - budget it separately",
    ],
  };
}

/**
 * Pure: extrapolate a lab-measured pg_upgrade time to production scale.
 * The lab measures the size-dependent part on labBytes; we scale it linearly
 * to prodBytes and add the fixed platform overhead. Deliberately crude - the
 * honest output is a range, not a point estimate.
 */
export function extrapolateProdDowntime(
  labUpgradeSec: number,
  labBytes: number,
  prodBytes: number,
  opts: Partial<DowntimeOpts> = {},
): DowntimeEstimate {
  const o = resolveDowntimeOpts(opts);
  const scale = labBytes > 0 ? prodBytes / labBytes : 1;
  const scaled = labUpgradeSec * scale;
  const totalSecLow = Math.ceil(scaled + o.fixedOverheadSec);
  const totalSecHigh = Math.ceil(scaled * o.copyFudge + o.fixedOverheadSec * 1.25);
  return {
    dataCopySec: scaled,
    fixedOverheadSec: o.fixedOverheadSec,
    totalSecLow,
    totalSecHigh,
    assumptions: [
      `lab pg_upgrade took ${labUpgradeSec.toFixed(1)}s on ${(labBytes / 1_073_741_824).toFixed(2)} GiB, scaled x${scale.toFixed(2)} to prod size`,
      `fixed platform overhead ~${Math.round(o.fixedOverheadSec / 60)} min (NOT exercised by the lab: instance provisioning, validations, base backup)`,
      "pg_upgrade --link copies no heap files - time is dominated by object count + catalog work, which scales sub-linearly; treat this as an upper bound",
      "app-level validation time is NOT included - budget it separately",
    ],
  };
}

/** Pure: human-readable "15-20 min" style range from an estimate. */
export function renderEstimate(e: DowntimeEstimate): string {
  const lo = Math.max(1, Math.round(e.totalSecLow / 60));
  const hi = Math.max(lo, Math.round(e.totalSecHigh / 60));
  return lo === hi ? `~${lo} min` : `~${lo}-${hi} min`;
}

// ---------------------------------------------------------------------------
// Platform checklist (Supabase-grounded, provider-agnostic core)
// ---------------------------------------------------------------------------

/** Pre-upgrade checklist lines, grounded in the Supabase platform upgrade guide. */
export function preUpgradeChecklist(provider: string): string[] {
  const core = [
    "Delete read replicas BEFORE the upgrade; re-create them after (platform prerequisite)",
    "Drop logical replication slots before the upgrade (platform prerequisite)",
    "Remove reg* columns referencing system OIDs - pg_upgrade refuses them",
    "Drop deprecated/unsupported extensions for the target major (back up dependent data first)",
    "Take a logical backup (pg_dump) for small DBs; for larger DBs confirm a recent backup + PITR",
    "Agree an off-peak maintenance window and communicate the estimated downtime up front",
    "Migrate custom roles off md5 passwords to scram-sha-256 BEFORE connecting post-upgrade",
    "Review Postgres + PostgREST release notes for breaking changes across the whole version jump",
    "Prune cron.job_run_details if pg_cron is installed (it is duplicated during the upgrade)",
    "Budget app-level validation time post-upgrade - planner changes can produce new slow queries",
    "Verify extension versions post-upgrade; run ALTER EXTENSION ... UPDATE where a path exists",
    "Reduce DB size/object count where cheap (archive, drop unused indexes, vacuum) - upgrade time scales with both",
  ];
  if (provider !== "supabase") return core;
  return [
    ...core,
    "Supabase: the Dashboard upgrade button shows its own eligibility warnings - re-check them on the day",
    "Supabase: the platform right-sizes the disk to ~1.2x DB size during the upgrade - expect the resize",
  ];
}

// ---------------------------------------------------------------------------
// SQL text (constants so tests can assert on them and steps stay readable)
// ---------------------------------------------------------------------------

export const SERVER_VERSION_SQL = "SHOW server_version";

export const DB_SIZE_SQL =
  "SELECT pg_database_size(current_database())::bigint AS bytes, " +
  "(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) AS user_objects";

/**
 * Extension inventory + an "external dependents" count: how many NON-extension
 * objects depend on each extension's members. Zero means nothing in the
 * database would break if the extension were dropped - a CANDIDATE for
 * removal, never proof (app-side usage is invisible to the catalog).
 */
export const EXTENSION_INVENTORY_SQL = `
WITH members AS (
  SELECT d.refobjid AS ext_oid, d.classid, d.objid
  FROM pg_depend d
  WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
),
ext_users AS (
  SELECT m.ext_oid, count(*)::int AS n
  FROM members m
  JOIN pg_depend dep ON dep.refclassid = m.classid AND dep.refobjid = m.objid
  WHERE NOT EXISTS (
    SELECT 1 FROM members m2 WHERE m2.classid = dep.classid AND m2.objid = dep.objid
  )
  GROUP BY m.ext_oid
)
SELECT e.extname, e.extversion, coalesce(u.n, 0) AS external_dependents
FROM pg_extension e
LEFT JOIN ext_users u ON u.ext_oid = e.oid
ORDER BY e.extname`;

/** reg* columns referencing system OIDs block pg_upgrade outright. */
export const REGTYPE_COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, t.typname AS type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND t.typname IN (
    'regproc', 'regprocedure', 'regoper', 'regoperator', 'regclass', 'regtype',
    'regrole', 'regnamespace', 'regconfig', 'regdictionary', 'regcollation'
  )
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2, 3`;

/** Whether each reg*-column table belongs to an extension (dropped with it). */
export const REGTYPE_EXTENSION_OWNED_SQL = `
SELECT n.nspname || '.' || c.relname AS table
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
WHERE c.relkind IN ('r', 'p')`;

/** Logical slots must be dropped before a major upgrade. */
export const LOGICAL_SLOTS_SQL = `
SELECT slot_name, database, active, temporary
FROM pg_replication_slots
WHERE slot_type = 'logical'
ORDER BY 1`;

/**
 * Custom roles still on md5 password hashing (post-upgrade they cannot
 * connect). pg_authid needs superuser-ish rights - on managed platforms this
 * query can fail, so callers tolerate an error and report "could not check".
 */
export const MD5_ROLES_SQL = `
SELECT rolname FROM pg_authid
WHERE rolcanlogin = true AND rolpassword LIKE 'md5%'
ORDER BY 1`;

/**
 * pg_cron history bloat - duplicated during the platform upgrade. NULL when
 * pg_cron is absent. NOTE: a naive
 * `CASE WHEN to_regclass(...) IS NULL THEN NULL ELSE pg_total_relation_size('...')`
 * still errors ("schema cron does not exist") - the literal regclass cast in
 * the ELSE arm is constant-folded at plan time. Routing the cast through
 * to_regclass avoids the literal entirely; pg_total_relation_size is STRICT
 * so a NULL oid yields NULL.
 */
export const CRON_HISTORY_SIZE_SQL = `
SELECT pg_total_relation_size(to_regclass('cron.job_run_details'))::bigint AS bytes`;

/** ltree reindex check (multibyte encoding or non-libc collation provider). */
export const LTREE_REINDEX_NEEDED_SQL = `
SELECT pg_encoding_to_char(encoding) AS encoding,
       datlocprovider AS collation_provider,
       (pg_encoding_max_length(encoding) > 1 OR datlocprovider <> 'c') AS reindex_required
FROM pg_database
WHERE datname = current_database()`;

export const LTREE_INDEXES_SQL = `
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE indexname IN (
  SELECT c.relname
  FROM pg_index i
  JOIN pg_class c ON i.indexrelid = c.oid
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
  JOIN pg_type t ON a.atttypid = t.oid
  WHERE t.typname IN ('ltree', '_ltree')
)
ORDER BY 1, 2, 3`;

/** User operators with non-built-in selectivity estimators (superuser-gated on recreate). */
export const CUSTOM_OPERATOR_ESTIMATORS_SQL = `
SELECT n.nspname AS schema, o.oprname AS operator
FROM pg_operator o
JOIN pg_namespace n ON o.oprnamespace = n.oid
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND ((o.oprrest <> 0 AND o.oprrest::oid >= 10000)
    OR (o.oprjoin <> 0 AND o.oprjoin::oid >= 10000))
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_operator'::regclass AND d.objid = o.oid AND d.deptype = 'e'
  )
ORDER BY 1, 2`;

/** Every user table as schema.table, for verify's table discovery. */
export const USER_TABLES_SQL = `
SELECT table_schema || '.' || table_name AS name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1`;

/** Managed-schema marker for the reg* partition (matches by schema name). */
export type RegTypeColumn = { schema: string; table: string; column: string; type: string };

/**
 * Pure: split reg* blockers into USER-schema columns (pg_upgrade refuses them -
 * hard fail) and MANAGED-schema columns (on Supabase the platform recreates its
 * own schemas - auth/realtime/storage/... - during the managed upgrade, so
 * e.g. realtime.subscription's regclass/regrole columns are informational, not
 * operator blockers).
 */
export function partitionRegTypeColumns(
  cols: RegTypeColumn[],
  managedSchemas: readonly string[],
): { user: RegTypeColumn[]; managed: RegTypeColumn[] } {
  const managed = new Set(managedSchemas);
  const user: RegTypeColumn[] = [];
  const mng: RegTypeColumn[] = [];
  for (const c of cols) (managed.has(c.schema) ? mng : user).push(c);
  return { user, managed: mng };
}

/** Pure: drop tables living in managed schemas (auth/storage/...) from a discovery list. */
export function filterManagedTables(names: string[], managedSchemas: readonly string[]): string[] {
  const managed = new Set(managedSchemas);
  return names.filter((n) => !managed.has(n.split(".")[0] as string));
}

/**
 * Extensions the plain-PGDG lab image can CREATE (contrib ships inside the
 * postgresql-<major> packages). Supabase-platform extensions (pg_net,
 * pg_graphql, supabase_vault, pgjwt, wrappers, ...) have no binaries there.
 */
export const LAB_SUPPORTED_EXTENSIONS = new Set([
  "plpgsql",
  "pg_stat_statements",
  "pgcrypto",
  "uuid-ossp",
  "pg_trgm",
  "btree_gin",
  "btree_gist",
  "citext",
  "cube",
  "dblink",
  "earthdistance",
  "fuzzystrmatch",
  "hstore",
  "intagg",
  "intarray",
  "isn",
  "lo",
  "ltree",
  "pg_buffercache",
  "pg_freespacemap",
  "pg_prewarm",
  "pg_visibility",
  "pgrowlocks",
  "pgstattuple",
  "seg",
  "tablefunc",
  "tcn",
  "tsm_system_rows",
  "tsm_system_time",
  "unaccent",
  "xml2",
]);

/**
 * Pure: strip CREATE EXTENSION / COMMENT ON EXTENSION statements for
 * extensions the lab image cannot provide, from a pg_dump schema file.
 * Returns the filtered SQL + the skipped extension names (for a loud report
 * line - their absence in the lab is a fidelity note, not a silent change).
 */
export function stripUnsupportedExtensions(
  sql: string,
  supported: Set<string> = LAB_SUPPORTED_EXTENSIONS,
): { sql: string; skipped: string[] } {
  const skipped = new Set<string>();
  const re = /^(?:CREATE EXTENSION(?: IF NOT EXISTS)?|COMMENT ON EXTENSION) "?([a-zA-Z0-9_-]+)"?/;
  const lines = sql.split("\n").filter((line) => {
    const m = re.exec(line.trim());
    if (!m) return true;
    const ext = m[1] as string;
    if (supported.has(ext)) return true;
    skipped.add(ext);
    return false;
  });
  return { sql: lines.join("\n"), skipped: [...skipped].sort() };
}
