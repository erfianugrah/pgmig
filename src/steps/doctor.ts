import type { Config, Secrets } from "../config.ts";
import { classifyConn, connect, type Db, type PgProvider } from "../db.ts";
import { connectMySql, type MySqlConn } from "../engine/mysql.ts";
import { connectSqlServer, type SqlServerConn } from "../engine/sqlserver.ts";
import { check, runCheck, runProbe } from "../kb/checks.ts";
import { sourcePrepFor } from "../kb/engine-prep.ts";
import { lookupProviderHint } from "../kb/provider-hints.ts";
import { evalRules } from "../kb/source-prep-eval.ts";
import { log } from "../log.ts";
import { MgmtApi } from "../mgmt.ts";
import { extensionStatements, missingExtensions } from "./bootstrap.ts";
import {
  checkCustomPostgresConfig,
  checkForeignReplicationSlots,
  checkReplicationCapacity,
  subscribeGrantSQL,
} from "./checks.ts";

/**
 * `doctor` — an automated, re-runnable readiness checklist.
 *
 * Everything you'd otherwise check by hand with psql before a migration:
 * connection shape (pooler vs direct), reachability, source wal_level + replica
 * identity, the reconcile hashColumns ↔ live-schema cross-check, stale
 * publication/slot leftovers, row counts, custom pg_db_role_setting GUC
 * overrides that config-sync cannot carry, and (when the target exists) its PG
 * version + CREATE SUBSCRIPTION grant + whether the schema is loaded yet.
 *
 * Tolerant by design: the target usually does NOT exist during prep, so an
 * unreachable target is reported, not fatal. Source schema checks are skipped
 * (not failed) when the source can't be reached.
 */

export interface HashColumnDiff {
  /** live non-generated columns NOT in the pinned list → silently un-hashed (divergence missed). */
  missingFromPinned: string[];
  /** pinned columns that don't exist on the table → reconcile SQL would error. */
  nonexistent: string[];
  /** pinned columns that are generated → recomputed on subscriber → false mismatch. */
  generatedPinned: string[];
}

export interface Fk {
  /** schema.table that has the FK */
  table: string;
  /** schema.table it references */
  references: string;
}

export interface ExtVersionRow {
  extname: string;
  extversion: string;
}

export interface ExtensionVersionMismatch {
  extname: string;
  source: string;
  target: string;
}

/**
 * Pure: extensions present on BOTH sides whose installed version differs. A version jump can
 * silently change behaviour, or - worse - have no forward `ALTER EXTENSION ... UPDATE` path at
 * all. Existence-only diffing (see `missingExtensions`) can't see this; it only catches an
 * extension missing entirely, not one present-but-stale on the target.
 */
export function diffExtensionVersions(
  source: ExtVersionRow[],
  target: ExtVersionRow[],
): ExtensionVersionMismatch[] {
  const tgtMap = new Map(target.map((e) => [e.extname, e.extversion]));
  const out: ExtensionVersionMismatch[] = [];
  for (const s of source) {
    const t = tgtMap.get(s.extname);
    if (t !== undefined && t !== s.extversion)
      out.push({ extname: s.extname, source: s.extversion, target: t });
  }
  return out.sort((a, b) => a.extname.localeCompare(b.extname));
}

/**
 * Extensions with a documented history of breaking on a Postgres version jump. `pg_net` and
 * `wrappers` have shipped binary-vs-catalog version mismatches after an upgrade that crash
 * background workers until `ALTER EXTENSION ... UPDATE` is run; `pg_cron` and `pg_repack` have
 * historically shipped gaps in their UPDATE path between some versions, which can leave a
 * project with no forward path at all. Not exhaustive - extend as you hit more.
 */
export const EXTENSION_UPDATE_RISK: Record<string, string> = {
  pg_net:
    "binary/catalog version mismatches have crashed background workers post-upgrade until " +
    "`ALTER EXTENSION pg_net UPDATE` runs - verify the update succeeds before relying on it live",
  wrappers:
    "same binary/catalog mismatch symptom observed as pg_net - verify " +
    "`ALTER EXTENSION wrappers UPDATE` succeeds",
  pg_cron:
    "missing minor-version UPDATE paths have left a project unrecoverable in production - " +
    "confirm a path from the source version to the target version exists BEFORE cutover, not after",
  pg_repack:
    "has historically shipped with no UPDATE path between some versions - confirm one exists " +
    "for this exact version pair before depending on it",
};

/** Known-risk note for an extension name, if any. Exported for tests. */
export function extensionRiskNote(extname: string): string | undefined {
  return EXTENSION_UPDATE_RISK[extname];
}

/**
 * Pure: of the tables we replicate, which OTHER schemas/tables do they FK into
 * that we are NOT replicating? Those referenced rows must already exist on the
 * target before the initial copy, or FK enforcement rejects the copied rows.
 * The canonical case: public.documents.user_id → auth.users (Supabase-managed,
 * migrated via dump/restore, not by this tool).
 */
export function externalDeps(fks: Fk[], replicated: string[]): string[] {
  const set = new Set(replicated);
  const out = new Set<string>();
  for (const f of fks) {
    if (set.has(f.table) && !set.has(f.references)) out.add(f.references);
  }
  return [...out].sort();
}

/**
 * Pure: the runnable dump/restore command for the cross-schema dependencies a
 * replicated table FKs into (the `auth.users` trap). Their ROW data must exist
 * on the target before the initial copy. Returns the exact `supabase db dump`
 * one-liner so the operator doesn't reconstruct it from prose.
 */
export function externalDepDumpCommand(deps: string[]): string {
  const schemas = [...new Set(deps.map((d) => d.split(".")[0]))].sort();
  return (
    `supabase db dump --db-url "$SOURCE_DB_URL" --data-only --schema ${schemas.join(",")} -f predeps.sql && ` +
    `psql "$TARGET_DB_URL" --command 'SET session_replication_role = replica' -f predeps.sql`
  );
}

/**
 * Token liveness classification for the doctor summary. A PRESENT token is not
 * enough - doctor is the pre-flight gate, so a green tick here must mean the
 * Management API actually accepted it. An expired/revoked PAT 401s; that is a
 * WARN (config-sync/provision/create will fail) rather than a hard FAIL, since
 * pure-PG migrations never need the token at all.
 */
export async function checkAccessToken(
  token: string | undefined,
  validate: (token: string) => Promise<{ ok: boolean; status: number }>,
): Promise<{ level: "ok" | "warn"; message: string }> {
  if (!token) {
    return {
      level: "warn",
      message: "SUPABASE_ACCESS_TOKEN unset - config-sync will be unavailable",
    };
  }
  const { ok, status } = await validate(token);
  if (ok) {
    return { level: "ok", message: "SUPABASE_ACCESS_TOKEN valid (config-sync available)" };
  }
  if (status === 401) {
    return {
      level: "warn",
      message:
        "SUPABASE_ACCESS_TOKEN present but REJECTED (HTTP 401) - expired/revoked. " +
        "config-sync/provision/create will fail; generate a fresh PAT at " +
        "https://supabase.com/dashboard/account/tokens",
    };
  }
  return {
    level: "warn",
    message:
      `SUPABASE_ACCESS_TOKEN present but could not be validated (HTTP ${status}) - ` +
      "Management API unreachable; config-sync may be unavailable",
  };
}

/** Pure: compare a reconcile table's pinned hashColumns against the live schema. */
export function diffHashColumns(
  pinned: string[] | undefined,
  liveNonGenerated: string[],
  liveGenerated: string[],
): HashColumnDiff {
  if (!pinned) return { missingFromPinned: [], nonexistent: [], generatedPinned: [] };
  const all = new Set([...liveNonGenerated, ...liveGenerated]);
  const gen = new Set(liveGenerated);
  const pinnedSet = new Set(pinned);
  return {
    missingFromPinned: liveNonGenerated.filter((c) => !pinnedSet.has(c)),
    nonexistent: pinned.filter((c) => !all.has(c)),
    generatedPinned: pinned.filter((c) => gen.has(c)),
  };
}

export interface DoctorReport {
  pass: number;
  warn: number;
  fail: number;
}

/**
 * Parse a Postgres server version string into the integer major version.
 * Accepts both "15.8" (SHOW server_version) and "150008" (SHOW server_version_num).
 * Returns null if unparseable.
 */
export function parsePgMajor(ver: string): number | null {
  if (!ver) return null;
  // server_version_num style: 150008 -> 15
  if (/^\d{5,6}$/.test(ver)) {
    return Math.floor(Number(ver) / 10_000);
  }
  // "15.8" or "PostgreSQL 15.8 (Debian ...)" style
  const m = ver.match(/(\d+)\.\d+/);
  return m ? Number(m[1]) : null;
}

/**
 * Derive the local pg_dump major version by shelling out. Returns null when
 * pg_dump is not on PATH. Called once per doctor invocation. Pure parse
 * companion -- exported for unit tests.
 */
export function guessLocalPgDumpMajor(): number | null {
  try {
    const proc = Bun.spawnSync(["pg_dump", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const out = new TextDecoder().decode(proc.stdout).trim();
    // "pg_dump (PostgreSQL) 15.8" or "pg_dump (PostgreSQL) 16.2 (Debian ...)"
    const m = out.match(/pg_dump \(PostgreSQL\) (\d+)\.\d+/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function doctor(
  cfg: Config,
  secrets: Secrets,
  opts: {
    sourceOnly?: boolean;
    /** Injected for tests; defaults to the real mysql2-backed connector (heterogeneous path). */
    mysqlConnect?: (url: string) => Promise<MySqlConn>;
    /** Injected for tests; defaults to the real mssql-backed connector (heterogeneous path). */
    sqlServerConnect?: (url: string) => Promise<SqlServerConn>;
    /** Injected for tests; defaults to a live GET /v1/organizations via MgmtApi. */
    validateToken?: (token: string) => Promise<{ ok: boolean; status: number }>;
  } = {},
): Promise<DoctorReport> {
  const r: DoctorReport = { pass: 0, warn: 0, fail: 0 };
  const ok = (m: string) => {
    r.pass++;
    log.ok(m);
  };
  const warn = (m: string) => {
    r.warn++;
    log.warn(m);
  };
  const fail = (m: string) => {
    r.fail++;
    log.err(m);
  };

  // ── 1. config + secrets (no network) ───────────────────────────────────
  log.step("doctor: config + connection shape");
  log.detail(
    cfg.source.engine === "postgres"
      ? `source ref ${cfg.source.ref}  →  target ref ${cfg.target.ref}`
      : `source engine ${cfg.source.engine}  →  target ref ${cfg.target.ref}`,
  );
  {
    const validate = opts.validateToken ?? ((t: string) => new MgmtApi(t).validateToken());
    const tc = await checkAccessToken(secrets.SUPABASE_ACCESS_TOKEN, validate);
    (tc.level === "ok" ? ok : warn)(tc.message);
  }

  // Heterogeneous source (mysql/sqlserver): a mysql://-style DSN driven by Debezium CDC. The PG
  // pooler/direct ladder, pg_* source checks, and CREATE-SUBSCRIPTION target checks don't apply.
  // Walk the engine-prep playbook live against the source instead + a reduced PG target check.
  if (cfg.source.engine !== "postgres") {
    await heterogeneousDoctor(cfg, secrets, opts, { ok, warn, fail });
    return summarize(r);
  }

  const src = classifyConn(secrets.SOURCE_DB_URL);
  const tgt = classifyConn(secrets.TARGET_DB_URL);
  log.detail(
    `source conn ${src.host}:${src.port} (${src.provider})   ` +
      `target conn ${tgt.host}:${tgt.port} (${tgt.provider})`,
  );
  for (const note of providerNotes(src, tgt, { sourceOnly: opts.sourceOnly })) log.detail(note);
  const repl = secrets.SOURCE_REPLICATION_URL ? classifyConn(secrets.SOURCE_REPLICATION_URL) : null;
  if (src.isPooler) {
    if (repl?.isSupabaseDirect)
      ok(
        `SOURCE_DB_URL is a pooler (admin/seed/reconcile), but SOURCE_REPLICATION_URL is the ` +
          `direct host (ref ${repl.ref}) — the subscription will stream from there. Correct split ` +
          `for running pgmig from a host without IPv6 to the direct host.`,
      );
    else if (repl)
      fail(
        "SOURCE_DB_URL is a pooler AND SOURCE_REPLICATION_URL is not a direct host — the " +
          "subscription's CONNECTION must be the DIRECT host (db.<ref>.supabase.co); the pooler can't stream WAL.",
      );
    else
      fail(
        "SOURCE_DB_URL is a POOLER endpoint and SOURCE_REPLICATION_URL is unset - replicate would " +
          "point CREATE SUBSCRIPTION at the pooler, which cannot stream WAL, so the subscription " +
          "would never sync. Set SOURCE_REPLICATION_URL to the source DIRECT host " +
          "(db.<ref>.supabase.co), or enable the source's IPv4 add-on and use the direct host as " +
          "SOURCE_DB_URL.",
      );
    if (src.isTransactionPooler)
      fail(
        "SOURCE_DB_URL is the TRANSACTION pooler (port 6543) — `bootstrap` runs pg_dump/pg_dumpall " +
          "against it and the transaction pooler has no session-level features, so the dump fails. " +
          "Use the SESSION pooler (port 5432) for SOURCE_DB_URL.",
      );
  } else if (src.isSupabaseDirect) {
    ok(`SOURCE_DB_URL is the direct host (ref ${src.ref}) — correct for replication`);
  }
  if (!opts.sourceOnly) {
    if (tgt.isPooler)
      warn("TARGET_DB_URL is a POOLER endpoint — CREATE SUBSCRIPTION needs the direct host");
    else if (tgt.isSupabaseDirect)
      ok(`TARGET_DB_URL is the direct host (ref ${tgt.ref}) — correct for replication`);
  }

  // ── 2. connect (short timeout, tolerant) ───────────────────────────────
  const { source, target, close } = connect(secrets, { connectTimeoutSec: 10 });
  try {
    const srcReach = await probe(source);
    if (srcReach.ok) ok(`source reachable (${src.host})`);
    else {
      fail(`source UNREACHABLE (${src.host}): ${reachHint(srcReach.error, src)}`);
    }

    // ── 3. source schema checks ──────────────────────────────────────────
    if (srcReach.ok) await sourceChecks(source, cfg, { ok, warn, fail });

    // ── 4. target checks ─────────────────────────────────────────────────
    if (!opts.sourceOnly) {
      const tgtReach = await probe(target);
      if (tgtReach.ok) {
        ok(`target reachable (${tgt.host})`);
        await targetChecks(source, target, cfg, srcReach.ok, { ok, warn, fail });
      } else {
        warn(
          `target not reachable yet (${tgt.host}) — expected during prep before it's created: ${reachHint(tgtReach.error, tgt)}`,
        );
      }
    }
  } finally {
    await close();
  }

  return summarize(r);
}

/** Shared verdict footer for both the native-PG and heterogeneous doctor paths. */
function summarize(r: DoctorReport): DoctorReport {
  log.step("doctor: summary");
  const verdict = r.fail > 0 ? "NOT READY" : r.warn > 0 ? "READY (with warnings)" : "READY";
  log.detail(`${r.pass} pass · ${r.warn} warn · ${r.fail} fail`);
  r.fail > 0 ? log.err(verdict) : log.ok(verdict);
  return r;
}

type Sink = { ok: (m: string) => void; warn: (m: string) => void; fail: (m: string) => void };

async function probe(db: Db): Promise<{ ok: boolean; error?: string }> {
  try {
    await db`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The provider advisory lines doctor emits via `log.detail`, as plain strings. Pure so the
 * wiring conditionals (source always; target only when not source-only; nothing when the
 * hint is null) are unit-testable without a live connection.
 */
export function providerNotes(
  src: { provider: PgProvider },
  tgt: { provider: PgProvider },
  opts: { sourceOnly?: boolean } = {},
): string[] {
  const notes: string[] = [];
  const s = providerHint(src.provider, "source");
  if (s) notes.push(`source provider note — ${s}`);
  if (!opts.sourceOnly) {
    const t = providerHint(tgt.provider, "target");
    if (t) notes.push(`target provider note — ${t}`);
  }
  return notes;
}

/**
 * Provider-specific logical-replication enablement guidance. All targets are native
 * Postgres; only the *how-to-enable* differs. Returns null for `supabase` (covered by the
 * pooler/direct ladder) and `generic` (self-hosted; the generic wal_level check suffices).
 * The knowledge itself lives in `src/kb/provider-hints.ts` as validated, provenance-stamped
 * data (docs/GUIDED-MIGRATION.md §8, §10.1); this is the thin lookup doctor calls.
 */
export function providerHint(provider: PgProvider, role: "source" | "target"): string | null {
  return lookupProviderHint(provider, role);
}

/** Turn a raw connection error into actionable guidance. */
function reachHint(error: string | undefined, c: ReturnType<typeof classifyConn>): string {
  const e = error ?? "unknown error";
  if (/network is unreachable|enetunreach|ehostunreach/i.test(e) && c.isSupabaseDirect)
    return "host resolves IPv6-only and there's no IPv6 route from here. Run pgmig from an IPv6-capable host, or enable the source's IPv4 add-on.";
  return e;
}

async function sourceChecks(source: Db, cfg: Config, s: Sink): Promise<void> {
  log.step("doctor: source readiness");

  const q = (sql: string, p?: readonly unknown[]) => source.unsafe(sql, (p ?? []) as never[]);
  const wal = await runCheck(q, check("source.wal_level_logical"));
  wal.ok
    ? s.ok("source wal_level=logical")
    : s.fail(`source wal_level=${wal.observed} (need 'logical')`);

  // replica identity per published table
  const replicaIdentity = check("source.replica_identity");
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const row = await runProbe<{ relreplident: string; has_pk: boolean }>(q, replicaIdentity, [
      schema ?? "",
      table ?? "",
    ]);
    if (!row) {
      s.fail(`published table ${qt} not found on source`);
      continue;
    }
    const good =
      (row.relreplident === "d" && row.has_pk) ||
      row.relreplident === "f" ||
      row.relreplident === "i";
    good
      ? s.ok(`${qt} replica identity ok (${row.relreplident === "d" ? "PK" : row.relreplident})`)
      : s.fail(
          `${qt} has no replica identity — UPDATE/DELETE won't replicate (set REPLICA IDENTITY FULL)`,
        );
  }

  // reconcile hashColumns ↔ live schema
  for (const t of cfg.reconcile.tables) {
    const [schema, table] = t.name.split(".");
    const cols = await source`
      SELECT column_name, is_generated FROM information_schema.columns
      WHERE table_schema = ${schema ?? ""} AND table_name = ${table ?? ""}`;
    if (cols.length === 0) {
      s.fail(`reconcile table ${t.name} not found on source`);
      continue;
    }
    const nonGen = cols.filter((c) => c.is_generated === "NEVER").map((c) => String(c.column_name));
    const gen = cols.filter((c) => c.is_generated === "ALWAYS").map((c) => String(c.column_name));
    const d = diffHashColumns(t.hashColumns, nonGen, gen);
    if (!t.hashColumns) {
      s.ok(
        `${t.name} reconcile auto-hashes ${nonGen.length} non-generated cols (${gen.length} generated excluded)`,
      );
    } else if (d.nonexistent.length || d.generatedPinned.length) {
      if (d.nonexistent.length)
        s.fail(`${t.name} hashColumns reference missing columns: ${d.nonexistent.join(", ")}`);
      if (d.generatedPinned.length)
        s.fail(
          `${t.name} hashColumns include GENERATED columns (false mismatch): ${d.generatedPinned.join(", ")}`,
        );
    } else if (d.missingFromPinned.length) {
      s.warn(
        `${t.name} hashColumns omit live columns (divergence there won't be caught): ${d.missingFromPinned.join(", ")}`,
      );
    } else {
      s.ok(
        `${t.name} hashColumns match live schema (${t.hashColumns.length} cols, ${gen.length} generated excluded)`,
      );
    }
  }

  // cross-schema FK dependencies — the auth.users trap
  const fkRows = await source`
    SELECT (n.nspname || '.' || c.relname) AS tbl,
           (fn.nspname || '.' || fc.relname) AS ref
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class fc ON fc.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE con.contype = 'f'`;
  const fks: Fk[] = fkRows.map((r) => ({ table: String(r.tbl), references: String(r.ref) }));
  const deps = externalDeps(fks, cfg.replication.tables);
  if (deps.length === 0) {
    s.ok("no cross-schema FK dependencies among replicated tables");
  } else {
    for (const d of deps)
      s.warn(
        `replicated tables FK into ${d} (not replicated) — its data MUST exist on the target ` +
          `before the initial copy, or FK enforcement rejects the rows. Migrate ${d.split(".")[0]} ` +
          `via dump/restore (supabase db dump) first.`,
      );
    log.detail(`fix: ${externalDepDumpCommand(deps)}`);
  }

  // stale leftovers from a prior run
  const slot = await runCheck(q, check("source.slot_absent"), [cfg.replication.slot]);
  slot.present
    ? s.warn(`slot ${cfg.replication.slot} already exists on source — teardown a prior run first`)
    : s.ok(`no stale slot (${cfg.replication.slot})`);
  const pub = await runCheck(q, check("source.publication_absent"), [cfg.replication.publication]);
  if (pub.present) s.warn(`publication ${cfg.replication.publication} already exists on source`);

  // foreign logical replication slots - a competing CDC consumer (Artie/ClickPipes/PeerDB/
  // Debezium) can hold WAL retention hostage; undiscovered ones have aborted real migrations
  // the night before cutover.
  await checkForeignReplicationSlots(source, cfg, s);

  // row counts (informational -- drives copy-time + WAL expectations)
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [c] = await source`
      SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname = ${schema ?? ""} AND relname = ${table ?? ""}`;
    log.detail(`${qt}: ~${c?.n_live_tup ?? "?"} live rows`);
  }

  // -- STORED generated columns: recomputed per-row by the subscriber during
  //    the initial copy, which is the measured throughput killer (~7x slower
  //    with a STORED tsvector -- ~11 MiB/s vs ~80 MiB/s). Warn so the
  //    migration time estimate accounts for them.
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const genCols = await source`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${schema ?? ""}
        AND table_name = ${table ?? ""}
        AND is_generated = 'ALWAYS'`;
    if (genCols.length > 0) {
      const names = genCols.map((r) => String(r.column_name)).join(", ");
      s.warn(
        `${qt} has STORED generated column(s): ${names}. The subscriber recomputes each row ` +
          "during the initial copy -- this is the measured throughput killer (~7x slower with a " +
          "STORED tsvector, ~11 MiB/s vs ~80 MiB/s). The migration time estimate must account for it.",
      );
    }
  }

  // -- pg_cron active jobs: pause at watermark, don't enable on target until cutover
  try {
    const cronJobs = await source`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cron'`;
    if (cronJobs.length > 0) {
      const activeJobs = await source`
        SELECT count(*)::int AS n FROM cron.job WHERE active = true`;
      if (activeJobs.length > 0 && Number(activeJobs[0]?.n ?? 0) > 0) {
        s.warn(
          `pg_cron has ${String((activeJobs[0] as { n: number }).n)} active job(s) in cron.job -- every cron job must be ` +
            "PAUSED at the migration watermark and must NOT be enabled on the target until cutover. " +
            "A half-migrated target firing ingestion jobs or outbound pg_net calls is a split-brain / " +
            "duplicate-action risk.",
        );
      }
    }
  } catch {
    // cron schema absent or not accessible -- skip
  }

  // -- Vault / pgsodium: root key not carried by dump/restore
  try {
    const vaultSecrets = await source`
      SELECT count(*)::int AS n
      FROM information_schema.schemata
      WHERE schema_name = 'vault'`;
    if (vaultSecrets.length > 0) {
      const hasSecrets = await source`
        SELECT 1 FROM vault.secrets LIMIT 1`;
      if (hasSecrets.length > 0) {
        s.warn(
          "supabase_vault is installed and vault.secrets is non-empty -- the encryption root key " +
            "is NOT carried by a manual dump/restore. The root key must be copied from the source " +
            "while the source is still ACTIVE (once the source is paused/deleted the key, and " +
            "everything encrypted under it, is unrecoverable). Overwriting a key makes data under " +
            "a different key inaccessible.",
        );
      }
    }
  } catch {
    // vault absent or not accessible -- skip
  }

  // -- pg_dump client version vs source server major
  {
    const [sv] = await source`SHOW server_version`;
    const srcVer = String(sv?.server_version ?? "");
    const dumpVer = guessLocalPgDumpMajor();
    if (dumpVer !== null) {
      const srcMajor = parsePgMajor(srcVer);
      if (srcMajor !== null && dumpVer < srcMajor) {
        s.fail(
          `local pg_dump client (PG ${dumpVer}) is OLDER than the source server (PG ${srcVer}) -- ` +
            "this fails with a GSSAPI negotiation error. Install pg_dump >= PG " +
            `${String(srcMajor)} or run pgmig on a host with a matching client.`,
        );
      }
    }
  }
}

async function targetChecks(
  source: Db,
  target: Db,
  cfg: Config,
  sourceReachable: boolean,
  s: Sink,
): Promise<void> {
  log.step("doctor: target readiness");

  const [tgtV] = await target`SHOW server_version_num`;
  const tgtNum = Number(tgtV?.server_version_num ?? 0);
  if (sourceReachable) {
    const [srcV] = await source`SHOW server_version_num`;
    const srcNum = Number(srcV?.server_version_num ?? 0);
    log.detail(`source PG ${srcNum} / target PG ${tgtNum}`);
    if (tgtNum < srcNum)
      s.warn(
        "target major version is older than source — logical replication may reject some types",
      );
    else s.ok("target version ≥ source");
  }

  // C-1: pg_has_role('pg_create_subscription') throws on PG15 — version-gate via shared helper.
  const [sub] = await target.unsafe(subscribeGrantSQL(tgtNum));
  if (sub?.is_super || sub?.has_grant) s.ok("target role can CREATE SUBSCRIPTION");
  else if (tgtNum < 160_000)
    s.warn("PG15 target + non-superuser — CREATE SUBSCRIPTION may be blocked; smoke-test it");
  else s.fail("target role lacks pg_create_subscription membership");

  // replication-capacity GUCs (warn-only): slot/sender headroom on source, worker-process
  // floor on target (the Azure Flexible Server "out of background worker slots" footgun).
  if (sourceReachable) await checkReplicationCapacity(source, target, cfg, s);

  // "Invisible" custom Postgres config (warn-only): ALTER ROLE/DATABASE SET overrides in
  // pg_db_role_setting that config-sync's Management-API endpoint does NOT carry.
  if (sourceReachable) await checkCustomPostgresConfig(source, target, s);

  // non-default extensions present on source must be enabled on target before schema load
  if (sourceReachable) {
    const IGNORE = new Set(["plpgsql"]);
    const [srcExt, tgtExt] = await Promise.all([
      source<
        { extname: string; extversion: string }[]
      >`SELECT extname, extversion FROM pg_extension`,
      target<
        { extname: string; extversion: string }[]
      >`SELECT extname, extversion FROM pg_extension`,
    ]);
    // missingExtensions already excludes built-ins (plpgsql); keep IGNORE for any
    // doctor-specific additions but defer the core filter to the shared helper.
    const missing = missingExtensions(
      srcExt.map((e) => String(e.extname)).filter((e) => !IGNORE.has(e)),
      tgtExt.map((e) => String(e.extname)),
    );
    if (missing.length === 0) {
      s.ok("target has all source extensions");
    } else {
      s.warn(`target missing source extensions (enable before schema load): ${missing.join(", ")}`);
      for (const stmt of extensionStatements(missing)) log.detail(`fix: ${stmt}`);
      log.detail("or run: pgmig bootstrap --confirm (enables these + restores roles + schema)");
    }

    // extensions present on BOTH sides but at a different version: a version jump can silently
    // change behaviour or, worse, have no forward UPDATE path at all. Existence-only diffing
    // above can't see this.
    const mismatches = diffExtensionVersions(
      srcExt.map((e) => ({ extname: String(e.extname), extversion: String(e.extversion) })),
      tgtExt.map((e) => ({ extname: String(e.extname), extversion: String(e.extversion) })),
    );
    if (mismatches.length === 0) {
      s.ok("no extension version mismatches between source and target");
    } else {
      for (const m of mismatches) {
        const risk = extensionRiskNote(m.extname);
        s.warn(
          `extension ${m.extname} version differs: source=${m.source} target=${m.target} - run ` +
            `\`ALTER EXTENSION ${m.extname} UPDATE\` on the target after cutover` +
            (risk ? `. KNOWN RISK: ${risk}` : ""),
        );
      }
    }
  }

  // is the schema loaded on the target yet? (logical replication does NOT carry DDL)
  // M-10: also check for partitioned tables (relkind='p') and warn about ONLY limitation.
  const tq = (sql: string, p?: readonly unknown[]) => target.unsafe(sql, (p ?? []) as never[]);
  const schemaLoaded = check("target.schema_loaded");
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const row = await runProbe<{ relkind: string }>(tq, schemaLoaded, [schema ?? "", table ?? ""]);
    if (!row) {
      s.fail(
        `target table ${qt} MISSING — load the schema on the target before replicate (DDL is not replicated)`,
      );
    } else if (row.relkind === "p") {
      s.warn(
        `${qt} is a PARTITIONED TABLE — reconcile scans ONLY the parent partition root and ` +
          "will miss rows in child partitions.",
      );
    } else {
      s.ok(`target table ${qt} exists (schema loaded)`);
    }
  }

  // If the subscription already exists, every published table must appear in
  // pg_subscription_rel — otherwise it was ADDed to the publication after the
  // subscription was created and the subscriber never picked it up (its rows are
  // silently NOT replicating). The fix is `replicate` again (REFRESH PUBLICATION).
  const [subExists] = await target`
    SELECT 1 FROM pg_subscription WHERE subname = ${cfg.replication.subscription}`;
  if (subExists) {
    const subRel = await target`
      SELECT n.nspname || '.' || c.relname AS qt
      FROM pg_subscription_rel sr
      JOIN pg_subscription sub ON sub.oid = sr.srsubid
      JOIN pg_class c ON c.oid = sr.srrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE sub.subname = ${cfg.replication.subscription}`;
    const subbed = new Set(subRel.map((r) => String(r.qt)));
    const notSubbed = cfg.replication.tables.filter((qt) => !subbed.has(qt));
    notSubbed.length === 0
      ? s.ok(
          `subscription ${cfg.replication.subscription} covers all ${cfg.replication.tables.length} published tables`,
        )
      : s.fail(
          `subscription ${cfg.replication.subscription} is NOT replicating: ${notSubbed.join(", ")} ` +
            "— added to the publication after the subscription was created. Re-run `replicate` " +
            "(it now issues REFRESH PUBLICATION) to start their initial copy.",
        );
  }
}

/**
 * doctor for a heterogeneous (Debezium) source. Runs the engine-prep playbook LIVE against the
 * source — MySQL (mysql2) or SQL Server (mssql) — judging items carrying a machine-checkable
 * `assert`, reporting documentation-grade probes as live readings, and doing a REDUCED PG target
 * check: Debezium has no PG subscription, so the target just needs to be reachable, version-sane,
 * and already carry the translated tables.
 */
async function heterogeneousDoctor(
  cfg: Config,
  secrets: Secrets,
  opts: {
    sourceOnly?: boolean;
    mysqlConnect?: (url: string) => Promise<MySqlConn>;
    sqlServerConnect?: (url: string) => Promise<SqlServerConn>;
  },
  s: Sink,
): Promise<void> {
  const tgt = classifyConn(secrets.TARGET_DB_URL);
  log.detail(
    `source engine ${cfg.source.engine} (Debezium CDC; SOURCE_DB_URL is a ${cfg.source.engine}:// DSN)   ` +
      `target conn ${tgt.host}:${tgt.port} (${tgt.provider})`,
  );

  if (cfg.source.engine === "mysql") {
    await liveSourcePrepChecks(
      "mysql",
      secrets.SOURCE_DB_URL,
      s,
      opts.mysqlConnect ?? connectMySql,
    );
  } else {
    await liveSourcePrepChecks(
      "sqlserver",
      secrets.SOURCE_DB_URL,
      s,
      opts.sqlServerConnect ?? connectSqlServer,
    );
  }

  if (opts.sourceOnly) return;

  // Reduced target check. connect() also builds a PG client from the mysql:// SOURCE_DB_URL, but
  // it's lazy (no connection until queried) and we never query it here — only `target`.
  const { target, close } = connect(secrets, { connectTimeoutSec: 10 });
  try {
    const reach = await probe(target);
    if (!reach.ok) {
      s.warn(
        `target not reachable yet (${tgt.host}) — expected during prep before it's created: ${reachHint(reach.error, tgt)}`,
      );
      return;
    }
    s.ok(`target reachable (${tgt.host})`);
    await heterogeneousTargetChecks(target, cfg, s);
  } finally {
    await close();
  }
}

/**
 * Run each source-prep item live for the given engine: `assert` items are judged pass/warn/fail (by
 * item severity) against the probe rows; `detect`-only items (e.g. binlog retention, whose threshold
 * is judgement-based) are surfaced as live readings to weigh against `verify.expect`; guided/auto
 * items (schema translation, identity resync) are pointed at the command that handles them. MySQL
 * and SQL Server share this loop — only the connector + the items' SQL differ.
 */
async function liveSourcePrepChecks(
  engine: "mysql" | "sqlserver",
  url: string,
  s: Sink,
  open: (url: string) => Promise<{
    query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
    end(): Promise<void>;
  }>,
): Promise<void> {
  const label = engine === "sqlserver" ? "SQL Server" : "MySQL";
  log.step(`doctor: ${label} source readiness (live engine-prep checks)`);
  let conn: { query<T = Record<string, unknown>>(sql: string): Promise<T[]>; end(): Promise<void> };
  try {
    conn = await open(url);
  } catch (e) {
    s.fail(`${label} source UNREACHABLE — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const my = conn;
  try {
    for (const item of sourcePrepFor(engine)) {
      if (item.assert) {
        let rows: Record<string, unknown>[];
        try {
          rows = await my.query(item.assert.sql);
        } catch (e) {
          s.fail(`${item.title}: probe failed — ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        const results = evalRules(item.assert.rules, rows);
        const failed = results.filter((x) => !x.ok);
        if (failed.length === 0) {
          s.ok(`${item.title} (${results.map((x) => x.label).join(", ")})`);
        } else {
          const detail = failed.map((x) => `${x.label} [${x.observed}]`).join("; ");
          item.severity === "fail"
            ? s.fail(`${item.title}: ${detail}`)
            : s.warn(`${item.title}: ${detail}`);
          log.detail(`fix: ${item.guidance.split("\n")[0]}`);
        }
      } else if (item.detect) {
        try {
          const rows = await my.query(item.detect.sql);
          const reading = rows.length ? JSON.stringify(rows[0]) : "(no rows)";
          s.warn(
            `${item.title}: verify manually — observed ${reading}; expect ${item.verify?.expect ?? "see guide"}`,
          );
        } catch (e) {
          s.warn(`${item.title}: probe failed — ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        log.detail(
          `${item.title}: ${
            item.klass === "guided"
              ? "run `pgmig translate` (cutover is gated on sign-off)"
              : "handled automatically at the relevant phase"
          }`,
        );
      }
    }
  } finally {
    await my.end();
  }
}

/**
 * Reduced PG target check for a Debezium migration: version sanity + the translated tables exist.
 * Debezium's RegexRouter lands rows under `public.<bare table>`, so we check `public.<table>` for
 * each configured `schema.table`. No subscription/grant/extension/FK checks — PG-source only.
 */
async function heterogeneousTargetChecks(target: Db, cfg: Config, s: Sink): Promise<void> {
  log.step("doctor: target readiness (Debezium JDBC sink)");
  const [v] = await target`SHOW server_version_num`;
  const num = Number(v?.server_version_num ?? 0);
  num >= 150_000
    ? s.ok(`target PG ${num} (≥15)`)
    : s.warn(`target PG ${num} — pgmig targets PG15+`);

  const tq = (sql: string, p?: readonly unknown[]) => target.unsafe(sql, (p ?? []) as never[]);
  const schemaLoaded = check("target.schema_loaded");
  for (const qt of cfg.replication.tables) {
    const [, table] = qt.split(".");
    const row = await runProbe<{ relkind: string }>(tq, schemaLoaded, ["public", table ?? ""]);
    row
      ? s.ok(`target table public.${table} exists (translated schema loaded)`)
      : s.fail(
          `target table public.${table} MISSING — run \`pgmig translate --apply\` to load the ` +
            "translated schema (Debezium does not create tables)",
        );
  }
}
