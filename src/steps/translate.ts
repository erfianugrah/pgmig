/**
 * `pgmig translate` — the guided MySQL→Postgres schema-translation gate (GUIDED-MIGRATION.md §7,
 * HETEROGENEOUS.md §2 item 4). Wraps the pure translator (`src/engine/schema-translate.ts`) in the
 * production workflow the KB item `mysql.schema_translation` promises:
 *
 *   1. DRAFT  — read the MySQL `information_schema` for the migrated tables, render the target
 *               Postgres DDL, and collect every type decision a human must ratify.
 *   2. WRITE  — persist `<out-dir>/target-schema.sql` + `<out-dir>/target-schema.decisions.json`.
 *               NEVER auto-applies (§9 caveat 1 — schema translation cannot be fully automated).
 *   3. SIGN-OFF — the operator reviews the SQL, applies it to the target, then ratifies the draft
 *               (`pgmig translate --sign-off`), flipping `signedOff` in the manifest.
 *   4. GATE   — `cutover` refuses to drain unless the manifest exists AND is signed off
 *               (`assertSchemaSignedOff`), so a migration can never flip traffic onto an
 *               unreviewed translated schema.
 *
 * Heterogeneous-only: a `postgres` source needs no translation (the schema is dumped verbatim by
 * `bootstrap`). Both `mysql` (information_schema) and `sqlserver` (T-SQL catalog) are supported,
 * forking on `cfg.source.engine`; a postgres source fails loud here rather than silently no-op.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { connectMySql, type MySqlConn } from "../engine/mysql.ts";
import { draftTargetSchema, type SchemaDraft } from "../engine/schema-translate.ts";
import { connectSqlServer, type SqlServerConn } from "../engine/sqlserver.ts";
import { draftTargetSchemaSqlServer } from "../engine/sqlserver-schema-translate.ts";
import { log } from "../log.ts";

const SQL_FILE = "target-schema.sql";
const MANIFEST_FILE = "target-schema.decisions.json";

/** A single guided type decision carried in the manifest. */
export interface SchemaDecision {
  table: string;
  column: string;
  review: string;
}

/**
 * The persisted record of a translation draft + its sign-off state. `cutover` reads this to
 * enforce the gate; the operator edits nothing by hand — `--sign-off` flips `signedOff`.
 */
export interface SchemaManifest {
  generatedAt: string;
  source: { engine: string; databases: string[] };
  /** schema.table list the draft covers (the migrated tables). */
  tables: string[];
  /** Every per-column decision a human must ratify before cutover. */
  decisions: SchemaDecision[];
  /** True once the operator has reviewed the SQL and ratified it (`translate --sign-off`). */
  signedOff: boolean;
  signedOffAt?: string;
}

/** The two artifact paths under an out-dir (the SQL draft + its decisions manifest). */
export function schemaArtifactPaths(outDir: string): { sql: string; manifest: string } {
  return { sql: join(outDir, SQL_FILE), manifest: join(outDir, MANIFEST_FILE) };
}

/**
 * Group `schema.table` idents by their schema part. For a MySQL source the schema part IS the
 * MySQL database, so this yields the `information_schema` query scope per database. Pure.
 */
export function groupTablesByDatabase(qualifiedTables: readonly string[]): Map<string, string[]> {
  const byDb = new Map<string, string[]>();
  for (const qt of qualifiedTables) {
    const [db, table] = qt.split(".") as [string, string];
    byDb.set(db, [...(byDb.get(db) ?? []), table]);
  }
  return byDb;
}

/** Assemble the (unsigned) manifest from a draft + the config it was drafted for. Pure. */
export function buildManifest(cfg: Config, draft: SchemaDraft): SchemaManifest {
  return {
    generatedAt: new Date().toISOString(),
    source: {
      engine: cfg.source.engine,
      databases: [...groupTablesByDatabase(cfg.replication.tables).keys()],
    },
    tables: [...cfg.replication.tables],
    decisions: draft.decisions,
    signedOff: false,
  };
}

export interface TranslateOpts {
  /** Directory the artifacts are written to (mirrors reconcile/verify/bootstrap). */
  outDir: string;
  /** Apply the drafted DDL to the target (MUTATES it). Default false — write for review only. */
  apply?: boolean;
  /** Target Db, required only when `apply` is true. */
  target?: Db;
  /** Injected for tests; defaults to the real mysql2-backed connector. */
  mysqlConnect?: (url: string) => Promise<MySqlConn>;
  /** Injected for tests; defaults to the real mssql-backed connector. */
  sqlServerConnect?: (url: string) => Promise<SqlServerConn>;
}

export interface TranslateResult {
  draft: SchemaDraft;
  manifest: SchemaManifest;
  paths: { sql: string; manifest: string };
}

/**
 * Draft the target schema from the live MySQL source and write the artifacts. A fresh draft is
 * always written UNSIGNED — re-translating invalidates any prior sign-off, because the source
 * schema may have changed under it. Returns the draft + manifest for the caller to render.
 */
export async function translate(
  cfg: Config,
  secrets: Secrets,
  opts: TranslateOpts,
): Promise<TranslateResult> {
  if (cfg.source.engine === "postgres") {
    throw new Error(
      "translate: source.engine is 'postgres' — a native-PG migration needs no schema translation " +
        "(the schema is dumped verbatim by `pgmig bootstrap`). This command is for heterogeneous " +
        "(mysql) sources only.",
    );
  }
  if (opts.apply && !opts.target) {
    throw new Error(
      "translate: --apply requires a target connection (internal: opts.target unset)",
    );
  }

  const url = secrets.SOURCE_DB_URL;
  const byDb = groupTablesByDatabase(cfg.replication.tables);
  const engine = cfg.source.engine;
  log.step(`translate (${engine}→postgres) — drafting ${cfg.replication.tables.length} table(s)`);

  // Both source clients share the query/end shape; the drafter (information_schema vs T-SQL
  // catalog) is what forks. For MySQL the byDb key is the database; for SQL Server it is the schema
  // (e.g. `dbo`) — groupTablesByDatabase splits on `.` either way.
  const conn =
    engine === "sqlserver"
      ? await (opts.sqlServerConnect ?? connectSqlServer)(url)
      : await (opts.mysqlConnect ?? connectMySql)(url);
  let draft: SchemaDraft;
  try {
    const parts: SchemaDraft[] = [];
    for (const [scope, tables] of byDb) {
      parts.push(
        engine === "sqlserver"
          ? await draftTargetSchemaSqlServer(conn as SqlServerConn, scope, tables)
          : await draftTargetSchema(conn as MySqlConn, scope, tables),
      );
    }
    draft = {
      sql: parts.map((p) => p.sql).join("\n\n"),
      decisions: parts.flatMap((p) => p.decisions),
    };
  } finally {
    await conn.end();
  }

  const manifest = buildManifest(cfg, draft);
  const paths = schemaArtifactPaths(opts.outDir);
  mkdirSync(opts.outDir, { recursive: true });
  const header =
    `-- pgmig target schema — DRAFTED ${manifest.generatedAt} from ${engine} ${manifest.source.databases.join(", ")}\n` +
    "-- REVIEW the type decisions below, apply to the target, then `pgmig translate --sign-off`.\n" +
    "-- pgmig NEVER auto-applies this (GUIDED-MIGRATION.md §7); cutover is gated on sign-off.\n\n";
  writeFileSync(paths.sql, `${header}${draft.sql}\n`, { mode: 0o644 });
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  log.ok(`wrote ${paths.sql}`);
  log.ok(`wrote ${paths.manifest} (signedOff: false)`);

  if (opts.apply && opts.target) {
    log.step("translate --apply — applying drafted DDL to the TARGET");
    await opts.target.unsafe(draft.sql);
    log.ok("target schema applied (still UNSIGNED — review + `--sign-off` before cutover)");
  }

  return { draft, manifest, paths };
}

/** Render the draft + its decisions for a human (the non-JSON CLI output). */
export function renderTranslate(result: TranslateResult): void {
  const { draft, manifest } = result;
  log.info(`drafted DDL for ${manifest.tables.join(", ")}:`);
  for (const line of draft.sql.split("\n")) log.detail(`  ${line}`);
  if (draft.decisions.length === 0) {
    log.ok("no guided decisions — every column mapped to a documented default");
  } else {
    log.warn(`${draft.decisions.length} guided decision(s) need human review before cutover:`);
    for (const d of draft.decisions) log.detail(`  - ${d.table}.${d.column}: ${d.review}`);
  }
  log.info(
    "Next: review the SQL, apply it to the target (or re-run with --apply), then ratify with " +
      "`pgmig translate --sign-off`. cutover refuses to run until you do.",
  );
}

/** Read the manifest from an out-dir, or throw a clear error if it is missing. */
function readManifest(outDir: string): SchemaManifest {
  const { manifest: path } = schemaArtifactPaths(outDir);
  if (!existsSync(path)) {
    throw new Error(
      `translate: no schema manifest at ${path} — run \`pgmig translate\` first to draft the ` +
        "target schema.",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as SchemaManifest;
}

/**
 * Ratify an existing draft: re-read the manifest, flip `signedOff`, stamp the time, write it back.
 * Throws if no draft exists. This is the operator's explicit assertion that they reviewed the SQL
 * and applied it to the target.
 */
export function signOffSchema(outDir: string): SchemaManifest {
  const manifest = readManifest(outDir);
  if (manifest.signedOff) {
    log.info(`schema draft already signed off at ${manifest.signedOffAt}`);
    return manifest;
  }
  const signed: SchemaManifest = {
    ...manifest,
    signedOff: true,
    signedOffAt: new Date().toISOString(),
  };
  const { manifest: path } = schemaArtifactPaths(outDir);
  writeFileSync(path, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644 });
  log.ok(`schema draft signed off (${signed.decisions.length} decision(s) ratified) — ${path}`);
  return signed;
}

/**
 * Cutover gate (GUIDED-MIGRATION.md §7, §9 caveat 1): throw unless a translated schema has been
 * drafted AND signed off. Called at the top of the heterogeneous cutover so traffic can never flip
 * onto an unreviewed schema.
 */
export function assertSchemaSignedOff(outDir: string): void {
  const manifest = readManifest(outDir);
  if (!manifest.signedOff) {
    throw new Error(
      `translate: the target schema draft at ${schemaArtifactPaths(outDir).manifest} is NOT signed ` +
        "off. Review target-schema.sql, apply it to the target, then run `pgmig translate " +
        "--sign-off` before cutover. (cutover will not flip traffic onto an unreviewed schema.)",
    );
  }
  log.ok(
    `schema draft signed off at ${manifest.signedOffAt} (${manifest.decisions.length} decision(s)) — gate passed`,
  );
}
