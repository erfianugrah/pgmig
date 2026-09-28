import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Config, Secrets } from "../config.ts";
import { classifyConn, type Db, qi } from "../db.ts";
import { log } from "../log.ts";

/**
 * `bootstrap` — prepare the TARGET before `replicate`.
 *
 * Logical replication carries ROW DATA ONLY: no DDL, no roles, no extensions.
 * So the target must already have the schema (and the roles + extensions the
 * schema depends on) loaded BEFORE the initial copy, or `replicate` fails — most
 * visibly when a published table FKs into a not-yet-present table and every
 * copied row is rejected.
 *
 * This wraps the generic-Postgres pre-step the README used to leave as a
 * copy-paste `pg_dump | psql` block. It follows the same doctrine as the
 * functions/storage wrappers (`cli-wrappers.ts`): we DO NOT reimplement schema
 * extraction — `pg_dumpall`/`pg_dump` are authoritative — we just orchestrate
 * them in the load-bearing order with the right flags. Like `provision`/`claim`
 * it PREVIEWS by default and only mutates the target with `--confirm`.
 *
 * Scope: extensions + roles (no passwords) + schema (DDL). The Supabase-specific
 * `auth`/`storage` ROW data is opt-in via `--with-auth-data` (dumps the auth
 * schema rows and restores them with FK triggers deferred - the auth.users FK
 * pre-step); without that flag it's skipped and `doctor` prints the exact manual
 * command when it detects a cross-schema FK into auth.
 */

/** Extensions that always exist on a fresh database — never worth "enabling". */
export const ALWAYS_PRESENT_EXTENSIONS = new Set(["plpgsql"]);

/**
 * Schemas Supabase provisions and manages on EVERY project. They already exist
 * (with their objects) on any Supabase target, so dumping them from a Supabase
 * source and restoring would abort the atomic schema load on `CREATE SCHEMA auth
 * already exists`. We exclude them so bootstrap restores ONLY your app objects —
 * the same subset `supabase db dump` emits, but via plain `pg_dump` (no Docker).
 * Their ROW data (e.g. `auth.users`) is the separate manual step doctor flags.
 *
 * Mirrors the canonical `InternalSchemas` list in the Supabase CLI source
 * (apps/cli-go/pkg/migration/dump.go) — verified 2026-06-20 against supabase/cli.
 * `information_schema` / `pg_*` are omitted: pg_dump never dumps them anyway.
 * Wildcard patterns (`timescaledb_*`) use pg_dump's --exclude-schema pattern
 * matching (same rules as psql \d).
 */
export const SUPABASE_MANAGED_SCHEMAS = [
  "_analytics",
  "_realtime",
  "_supavisor",
  "auth",
  "cron",
  "dbdev",
  "etl",
  "extensions",
  "graphql",
  "graphql_public",
  "net",
  "pgbouncer",
  "pgmq",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "realtime",
  "repack",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  "tiger",
  "tiger_data",
  "timescaledb_*",
  "_timescaledb_*",
  "topology",
  "vault",
];

/**
 * Supabase-managed ROLES that exist on every project. Restoring CREATE/ALTER/GRANT
 * for these onto a Supabase target either collides (role already exists) or is
 * outright blocked by supautils (you can't ALTER a reserved role's superuser
 * attributes as the non-superuser `postgres` you connect as) — so we filter them
 * out instead of relying on the restore to noisily error past every one.
 *
 * Mirrors `reservedRoles` in the Supabase CLI source
 * (apps/cli-go/pkg/migration/dump.go) — verified 2026-06-20 against supabase/cli.
 * Entries are regex fragments (e.g. `supabase_.*`, `cli_login_.*`) matched against
 * the quoted role name in the dump.
 */
export const SUPABASE_RESERVED_ROLES = [
  "anon",
  "authenticated",
  "authenticator",
  "cli_login_.*",
  "dashboard_user",
  "pgbouncer",
  "postgres",
  "service_role",
  "supabase_.*",
  "pgsodium_keyholder",
  "pgsodium_keyiduser",
  "pgsodium_keymaker",
  "pgtle_admin",
];

/**
 * Role-level GUCs that supautils permits a Supabase project to ALTER (everything
 * else requires superuser and would error). `ALTER ROLE "<reserved>" SET "<cfg>"`
 * lines matching these are kept even though the reserved-role line is otherwise
 * commented out. Mirrors `allowedConfigs` in the Supabase CLI source.
 */
export const SUPABASE_ALLOWED_ROLE_CONFIGS = [
  "pgaudit.*",
  "pgrst.*",
  "session_replication_role",
  "statement_timeout",
  "track_io_timing",
];

/**
 * Pure: filter a `pg_dumpall --roles-only --quote-all-identifiers` dump so it is
 * safe to restore onto a Supabase target. Faithful port of the Supabase CLI's
 * `scripts/dump_role.sh` sed pipeline (verified 2026-06-20):
 *
 *   1. comment out `\restrict` / `\unrestrict` psql meta-commands (psql 17+)
 *   2. comment out `CREATE ROLE "<reserved>"`
 *   3. comment out `ALTER ROLE "<reserved>"`
 *   4. strip `NOSUPERUSER` / `NOREPLICATION` attributes (require superuser to set)
 *   5. re-enable `ALTER ROLE … SET "<allowed-config>" …` lines commented by step 3
 *   6. comment out `GRANT "…" TO "<reserved>"`
 *   7. collapse adjacent duplicate lines, append `RESET ALL;`
 *
 * Non-reserved (your app) roles pass through untouched — that's the subset we want.
 */
export function filterSupabaseRoles(sql: string): string {
  const reserved = `(${SUPABASE_RESERVED_ROLES.join("|")})`;
  const allowed = `(${SUPABASE_ALLOWED_ROLE_CONFIGS.join("|")})`;
  const reRestrict = /^\\(un)?restrict /;
  const reReservedRole = new RegExp(`^(CREATE ROLE|ALTER ROLE) "${reserved}"`);
  const reReservedGrant = new RegExp(`GRANT ".*" TO "${reserved}"`);
  const reAllowedSet = new RegExp(`^-- (.* SET "${allowed}" .*)`);

  const out: string[] = [];
  let prev: string | null = null;
  for (let line of sql.split("\n")) {
    // 1: \restrict / \unrestrict meta-commands
    if (reRestrict.test(line)) line = `-- ${line}`;
    // 2 + 3: reserved CREATE/ALTER ROLE
    else if (reReservedRole.test(line)) line = `-- ${line}`;
    // 4: drop superuser-only attributes
    line = line.replace(/ (NOSUPERUSER|NOREPLICATION)/g, "");
    // 5: re-enable safe `SET "<allowed>"` lines that step 3 just commented
    const setMatch = line.match(reAllowedSet);
    if (setMatch?.[1] !== undefined) line = setMatch[1];
    // 6: grants to reserved roles
    if (reReservedGrant.test(line)) line = `-- ${line}`;
    // 7: collapse adjacent duplicates
    if (line === prev) continue;
    prev = line;
    out.push(line);
  }
  out.push("RESET ALL;");
  return out.join("\n");
}

/**
 * Pure: filter a `pg_dump --schema-only --quote-all-identifiers` dump of a Supabase
 * source so it restores onto a Supabase target as the non-superuser `postgres`.
 * Faithful port of the Supabase CLI's `scripts/dump_schema.sh` sed pipeline
 * (apps/cli-go/pkg/migration/scripts/dump_schema.sh) — verified 2026-06-20.
 *
 * `--exclude-schema` alone is NOT enough: event triggers, the `supabase_realtime`
 * publication, FDW grants, `COMMENT ON EXTENSION`, and pg17's `transaction_timeout`
 * GUC are cluster-level or superuser-owned objects that a plain dump still emits
 * and that abort the restore. The pipeline:
 *   - makes CREATE SCHEMA/TABLE/SEQUENCE idempotent, VIEW/FUNCTION/TRIGGER replaceable
 *   - comments out EVENT TRIGGERs (+ their `WHEN TAG IN` / `EXECUTE FUNCTION` lines),
 *     the `supabase_realtime` publication, FDW owner/grants, supabase_admin default
 *     privileges, `COMMENT ON EXTENSION`, cron policies/tables, and `SET transaction_timeout`
 *   - strips version/schema clauses off the pg_tle/pgsodium/pgmq CREATE EXTENSION lines
 */
export function filterSupabaseSchema(sql: string): string {
  const excluded = SUPABASE_MANAGED_SCHEMAS.map((s) => s.replace(/\*/g, ".*")).join("|");
  const reGrant = new RegExp(`^GRANT (.+) ON (.+) "(${excluded})"`);
  const reRevoke = new RegExp(`^REVOKE (.+) ON (.+) "(${excluded})"`);
  const cmt = (l: string) => `-- ${l}`;

  return sql
    .split("\n")
    .map((line) =>
      line
        .replace(/^\\(un)?restrict .*$/, cmt)
        .replace(/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "')
        .replace(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "')
        .replace(/^CREATE SEQUENCE "/, 'CREATE SEQUENCE IF NOT EXISTS "')
        .replace(/^CREATE VIEW "/, 'CREATE OR REPLACE VIEW "')
        .replace(/^CREATE FUNCTION "/, 'CREATE OR REPLACE FUNCTION "')
        .replace(/^CREATE TRIGGER "/, 'CREATE OR REPLACE TRIGGER "')
        .replace(/^CREATE PUBLICATION "supabase_realtime/, cmt)
        .replace(/^CREATE EVENT TRIGGER /, cmt)
        .replace(/^ {9}WHEN TAG IN /, cmt)
        .replace(/^ {3}EXECUTE FUNCTION /, cmt)
        .replace(/^ALTER EVENT TRIGGER /, cmt)
        .replace(/^ALTER PUBLICATION "supabase_realtime_/, cmt)
        .replace(/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /, cmt)
        .replace(/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/, cmt)
        .replace(/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/, cmt)
        .replace(reGrant, cmt)
        .replace(reRevoke, cmt)
        .replace(/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/, "$1;")
        .replace(/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/, "$1;")
        .replace(/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/, "$1;")
        .replace(/^COMMENT ON EXTENSION (.+)/, cmt)
        .replace(/^CREATE POLICY "cron_job_/, cmt)
        .replace(/^ALTER TABLE "cron"/, cmt)
        .replace(/^SET transaction_timeout = 0;/, cmt),
    )
    .join("\n");
}

/** Pure: is this connection string a Supabase endpoint (direct OR pooler)? */
export function isSupabaseSource(url: string): boolean {
  const c = classifyConn(url);
  return c.isPooler || c.isSupabaseDirect;
}

/** Pure: the extensions on source missing from target (sorted, minus built-ins). */
export function missingExtensions(sourceExt: string[], targetExt: string[]): string[] {
  const have = new Set(targetExt);
  return sourceExt.filter((e) => !ALWAYS_PRESENT_EXTENSIONS.has(e) && !have.has(e)).sort();
}

/** Pure: idempotent CREATE EXTENSION statements for the missing extensions. */
export function extensionStatements(missing: string[]): string[] {
  return missing.map((e) => `CREATE EXTENSION IF NOT EXISTS ${qi(e)};`);
}

/** Pure: redact the password in a postgres connection URL for safe logging. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

/** Pure: redact any postgres URL argument inside a spawn argv for logging. */
export function redactArgv(cmd: string[]): string {
  return cmd.map((a) => (/^postgres(ql)?:\/\//i.test(a) ? redactUrl(a) : a)).join(" ");
}

/**
 * Pure: `pg_dumpall` argv to dump roles WITHOUT passwords (managed PG can't dump
 * them). `--quote-all-identifiers` so every role name is quoted in the output —
 * `filterSupabaseRoles` relies on that to match reserved roles reliably; `--no-comments`
 * keeps the dump clean so the re-enable step can't accidentally un-comment a real
 * comment line.
 */
export function dumpRolesCmd(sourceUrl: string, file: string): string[] {
  return [
    "pg_dumpall",
    "--roles-only",
    "--no-role-passwords",
    "--quote-all-identifiers",
    "--no-comments",
    "-d",
    sourceUrl,
    "-f",
    file,
  ];
}

/**
 * Pure: `pg_dump` argv for schema-only DDL. Strips the source's own
 * publications/subscriptions (pgmig creates its own) and ownership/ACLs so the
 * restore doesn't fail on roles that differ between projects.
 */
export function dumpSchemaCmd(
  sourceUrl: string,
  file: string,
  excludeSchemas: string[] = [],
  quoteAll = false,
): string[] {
  return [
    "pg_dump",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--no-publications",
    "--no-subscriptions",
    // quoted identifiers so filterSupabaseSchema's regexes match (Supabase path)
    ...(quoteAll ? ["--quote-all-identifiers"] : []),
    ...excludeSchemas.flatMap((s) => [`--exclude-schema=${s}`]),
    "-d",
    sourceUrl,
    "-f",
    file,
  ];
}

/**
 * Pure: `psql` argv to restore the ROLES dump. Deliberately lenient — NOT
 * single-transaction, NOT stop-on-error — because the dump re-declares roles
 * that already exist on any target cluster (notably the bootstrap superuser), and
 * those duplicate-object errors are benign. Roles are additive.
 */
export function restoreRolesCmd(targetUrl: string, file: string): string[] {
  return ["psql", "--variable", "ON_ERROR_STOP=0", "-d", targetUrl, "-f", file];
}

/**
 * Pure: `psql` argv to restore the SCHEMA dump atomically. Stop-on-error +
 * single-transaction so a partial/conflicting schema never lands on the target
 * (re-run against a fresh target after fixing the conflict).
 */
export function restoreSchemaCmd(targetUrl: string, file: string): string[] {
  return [
    "psql",
    "--variable",
    "ON_ERROR_STOP=1",
    "--single-transaction",
    "-d",
    targetUrl,
    "-f",
    file,
  ];
}

/**
 * Pure: `pg_dump` argv for the ROW DATA of the cross-schema dependency schemas a
 * replicated table FKs into (canonically `auth`). Logical replication does NOT
 * carry these rows, but `public.<t>.user_id -> auth.users` means they must exist
 * on the target BEFORE the initial copy or every child row is FK-rejected. Data-
 * only (the schema objects are Supabase-managed and already present). We do NOT
 * pass `--disable-triggers` (that needs table ownership/superuser on the managed
 * auth tables) - the restore session sets `session_replication_role = replica`
 * instead, which is what defers FK enforcement during the load.
 */
export function dumpAuthDataCmd(
  sourceUrl: string,
  file: string,
  schemas: string[] = ["auth"],
): string[] {
  return [
    "pg_dump",
    "--data-only",
    "--no-owner",
    "--no-privileges",
    // auth.schema_migrations is the one auth table where managed targets grant
    // the postgres role SELECT only (all others get full DML) - copying it
    // fails with "permission denied for table schema_migrations", and the
    // target already carries its own migration ledger. Never copy it.
    "--exclude-table-data=auth.schema_migrations",
    ...schemas.flatMap((s) => [`--schema=${s}`]),
    "-d",
    sourceUrl,
    "-f",
    file,
  ];
}

/**
 * Pure: `psql` argv to restore the auth ROW data atomically with FK/triggers
 * deferred. `--command 'SET session_replication_role = replica'` runs FIRST in
 * the same session (psql executes -c before -f), so the COPY/INSERT blocks that
 * follow don't trip cross-table FK triggers mid-load. Single-transaction +
 * stop-on-error so a partial auth load never lands.
 */
export function restoreAuthDataCmd(targetUrl: string, file: string): string[] {
  return [
    "psql",
    "--single-transaction",
    "--variable",
    "ON_ERROR_STOP=1",
    "--command",
    "SET session_replication_role = replica",
    "-f",
    file,
    "-d",
    targetUrl,
  ];
}

export interface BootstrapResult {
  ok: boolean;
  planned: number;
  applied: number;
}

interface SpawnStep {
  label: string;
  cmd: string[];
}

/** Run a dump/restore step, streaming its output. Throws on a non-zero exit. */
async function spawnStep(st: SpawnStep): Promise<void> {
  log.detail(`$ ${redactArgv(st.cmd)}`);
  const proc = Bun.spawn(st.cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${st.label} failed (exit ${code})`);
}

export async function bootstrap(
  source: Db,
  target: Db,
  cfg: Config,
  secrets: Secrets,
  opts: {
    confirm: boolean;
    outDir: string;
    allSchemas?: boolean;
    supabaseSource?: boolean;
    /** Also dump+restore the auth-schema ROW data (the auth.users FK pre-step). */
    withAuthData?: boolean;
  },
): Promise<BootstrapResult> {
  log.step(`bootstrap target ${cfg.target.ref}${opts.confirm ? "" : " (preview only)"}`);
  const result: BootstrapResult = { ok: true, planned: 0, applied: 0 };

  // For a Supabase source, exclude the schemas Supabase already provisions on the
  // target (auth/storage/extensions/...) — otherwise the atomic schema restore
  // aborts on `CREATE SCHEMA auth already exists`. `--all-schemas` forces a full
  // dump (use for a non-Supabase clone, or a truly empty target). Detection is by
  // hostname, overridable via `opts.supabaseSource` (escape hatch for tunnels /
  // custom domains / IP connections that hide the supabase host, and the test path).
  const supabaseSource = opts.supabaseSource ?? isSupabaseSource(secrets.SOURCE_DB_URL);
  const excludeSchemas = opts.allSchemas || !supabaseSource ? [] : SUPABASE_MANAGED_SCHEMAS;
  if (excludeSchemas.length > 0)
    log.detail(
      `Supabase source detected — excluding ${excludeSchemas.length} managed schemas from the ` +
        `schema dump (they already exist on the target). Their ROW data is a separate manual step.`,
    );

  // ── 1. extensions (do this FIRST: schema DDL may depend on them) ─────────
  log.info("--- Extensions ---");
  const [srcExt, tgtExt] = await Promise.all([
    source<{ extname: string }[]>`SELECT extname FROM pg_extension`,
    target<{ extname: string }[]>`SELECT extname FROM pg_extension`,
  ]);
  const missing = missingExtensions(
    srcExt.map((e) => String(e.extname)),
    tgtExt.map((e) => String(e.extname)),
  );
  const extSql = extensionStatements(missing);
  if (extSql.length === 0) {
    log.ok("target already has all source extensions");
  } else {
    result.planned += extSql.length;
    for (const s of extSql) log.detail(s);
    if (opts.confirm) {
      for (const s of extSql) {
        await target.unsafe(s);
        result.applied++;
      }
      log.ok(`enabled ${extSql.length} extension(s) on target`);
    }
  }

  // ── 2. roles + schema (pg_dump → psql) ───────────────────────────────────
  log.info("--- Roles + schema (pg_dumpall/pg_dump → psql) ---");
  mkdirSync(opts.outDir, { recursive: true });
  const rolesFile = `${opts.outDir}/bootstrap-roles.sql`;
  const schemaFile = `${opts.outDir}/bootstrap-schema.sql`;

  // A Supabase source carries managed roles (anon/authenticated/supabase_*/…) and
  // cluster-level objects (event triggers, the supabase_realtime publication,
  // COMMENT ON EXTENSION, …) that already exist on — or are write-protected by
  // supautils on — the target. We filter BOTH dumps the same way `supabase db dump`
  // does (--role-only + the schema sed pipeline) so only your app objects restore.
  // `--all-schemas` (non-Supabase clone) skips both filters and keeps raw dumps.
  const supabaseFilter = excludeSchemas.length > 0;

  const dumpSteps: SpawnStep[] = [
    { label: "dump roles", cmd: dumpRolesCmd(secrets.SOURCE_DB_URL, rolesFile) },
    {
      label: "dump schema",
      cmd: dumpSchemaCmd(secrets.SOURCE_DB_URL, schemaFile, excludeSchemas, supabaseFilter),
    },
  ];
  const restoreSteps: SpawnStep[] = [
    { label: "restore roles (lenient)", cmd: restoreRolesCmd(secrets.TARGET_DB_URL, rolesFile) },
    { label: "restore schema (atomic)", cmd: restoreSchemaCmd(secrets.TARGET_DB_URL, schemaFile) },
  ];
  // planned count is stable across preview/confirm: 2 dumps + (2 filters?) + 2 restores
  result.planned += dumpSteps.length + restoreSteps.length + (supabaseFilter ? 2 : 0);
  for (const st of dumpSteps) log.detail(`${st.label}: ${redactArgv(st.cmd)}`);
  if (supabaseFilter)
    log.detail(
      "filter dumps: drop Supabase-managed reserved roles + cluster objects (event triggers, etc.) in-place",
    );
  for (const st of restoreSteps) log.detail(`${st.label}: ${redactArgv(st.cmd)}`);

  if (opts.confirm) {
    for (const st of dumpSteps) {
      await spawnStep(st);
      result.applied++;
    }
    if (supabaseFilter) {
      writeFileSync(rolesFile, filterSupabaseRoles(readFileSync(rolesFile, "utf8")));
      result.applied++;
      writeFileSync(schemaFile, filterSupabaseSchema(readFileSync(schemaFile, "utf8")));
      result.applied++;
      log.ok("filtered Supabase-managed reserved roles + cluster objects from the dumps");
    }
    for (const st of restoreSteps) {
      await spawnStep(st);
      result.applied++;
    }
    log.ok("roles + schema restored onto target");
  }

  // ── 3. auth ROW data (opt-in: the auth.users cross-schema FK pre-step) ────
  if (opts.withAuthData) {
    log.info("--- Auth row data (auth.users FK pre-step) ---");
    const authFile = `${opts.outDir}/bootstrap-auth-data.sql`;
    const authDump: SpawnStep = {
      label: "dump auth data",
      cmd: dumpAuthDataCmd(secrets.SOURCE_DB_URL, authFile),
    };
    const authRestore: SpawnStep = {
      label: "restore auth data (triggers deferred)",
      cmd: restoreAuthDataCmd(secrets.TARGET_DB_URL, authFile),
    };
    result.planned += 2;
    log.detail(`${authDump.label}: ${redactArgv(authDump.cmd)}`);
    log.detail(`${authRestore.label}: ${redactArgv(authRestore.cmd)}`);
    if (opts.confirm) {
      await spawnStep(authDump);
      result.applied++;
      await spawnStep(authRestore);
      result.applied++;
      log.ok("auth row data restored onto target (FK prerequisite satisfied)");
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  if (result.planned === 0) {
    log.ok("bootstrap: nothing to do (target already prepared)");
  } else if (!opts.confirm) {
    const authNote = opts.withAuthData
      ? "restores roles + schema + auth row data"
      : "restores roles + schema (auth/storage ROW data is a separate step - re-run with " +
        "--with-auth-data, or see doctor's cross-schema FK hint)";
    log.warn(
      `${result.planned} action(s) planned. Re-run with --confirm to apply - this MUTATES THE TARGET ` +
        `(enables extensions, ${authNote}).`,
    );
  }
  return result;
}
