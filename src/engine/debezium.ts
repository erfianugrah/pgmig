import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { assertSchemaSignedOff } from "../steps/translate.ts";
import { debeziumPlanFromConfig, renderDebeziumServerConfig } from "./debezium-config.ts";
import {
  debeziumContainerName,
  debeziumDataVolume,
  debeziumRmArgv,
  debeziumRunSpec,
  debeziumStopArgv,
  debeziumVolumeRmArgv,
} from "./debezium-runspec.ts";
import { DEBEZIUM_IMAGE, debeziumRuntimePin } from "./debezium-runtime.ts";
import { connectMySql, type MySqlConn } from "./mysql.ts";
import {
  type AggColumn,
  categorizePgType,
  parseAggregateRow,
  reconcileAggregateReport,
  renderAggregateQuery,
} from "./reconcile-aggregate.ts";
import { connectSqlServer, type SqlServerConn } from "./sqlserver.ts";
import type { CutoverOpts, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * A heterogeneous source connection. MySqlConn and SqlServerConn are structurally identical
 * (`query` + `end`), so the engine drives both through this shape; only the rendered SQL + the
 * write-stop gate differ per flavour.
 */
type SourceConn = {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  end(): Promise<void>;
};

/** Retention-watchdog verdict for one poll of the heterogeneous initial sync. */
export type RetentionVerdict =
  | { level: "ok" }
  | { level: "warn"; message: string }
  | { level: "abort"; message: string };

/**
 * Pure: compare elapsed initial-sync time against the SOURCE change-log retention window (the CDC
 * analogue of the native WAL watchdog, HETEROGENEOUS.md §6). `retentionSec === null` means the
 * window is unbounded/unknown, so the watchdog no-ops. Warn once elapsed reaches `warnFraction`
 * of the window; hard-abort once it meets/exceeds the full window -- past that point the source
 * cleanup job (MySQL binlog purge / SQL Server CDC cleanup) may already be deleting change rows
 * the JDBC sink has not consumed, which the downgraded reconcile cannot detect => silent data loss.
 */
export function evaluateRetentionHeadroom(args: {
  elapsedSec: number;
  retentionSec: number | null;
  warnFraction: number;
  engineLabel: string;
}): RetentionVerdict {
  const { elapsedSec, retentionSec, warnFraction, engineLabel } = args;
  if (retentionSec === null || retentionSec <= 0) return { level: "ok" };
  const used = elapsedSec / retentionSec;
  const mins = (s: number) => `${Math.round(s / 60)}min`;
  if (used >= 1) {
    return {
      level: "abort",
      message:
        `retention watchdog: initial sync has run ${mins(elapsedSec)}, at or past the source ` +
        `${engineLabel} window (${mins(retentionSec)}). Change rows may already be purged before ` +
        `the sink consumed them; aborting to avoid silent data loss. Raise ${engineLabel} at the ` +
        `source and re-run, or migrate a smaller table set.`,
    };
  }
  if (used >= warnFraction) {
    return {
      level: "warn",
      message:
        `retention watchdog: initial sync at ${mins(elapsedSec)} of the ${mins(retentionSec)} ` +
        `source ${engineLabel} window (${Math.round(used * 100)}%). If the snapshot outruns ` +
        `retention, change rows are purged before the sink reads them. Raise ${engineLabel}.`,
    };
  }
  return { level: "ok" };
}

/**
 * The IO seam the DebeziumEngine drives — Docker process control + an HTTP health probe + file
 * staging. Injected so the orchestration logic (right argv, polls health, fails on timeout,
 * idempotent teardown) is unit-testable with mocks; the default impl is the real Bun/node IO.
 * The container spawn + Debezium itself are validated end-to-end by the Docker harness
 * (test/heterogeneous/), which the dev-box safety rule keeps out of the unit suite.
 */
export interface DebeziumIO {
  /** Run a command to completion, capturing stdout/stderr + exit code (never throws on non-zero). */
  exec(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** True iff a GET to `url` returns a 2xx (the Quarkus /q/health readiness probe). */
  httpOk(url: string): Promise<boolean>;
  /** GET returning status + body, or null on a network error (for parsing /q/health JSON). */
  httpText(url: string): Promise<{ ok: boolean; status: number; body: string } | null>;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  sleep(ms: number): Promise<void>;
}

export const defaultDebeziumIO: DebeziumIO = {
  async exec(argv) {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
  async httpOk(url) {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  },
  async httpText(url) {
    try {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch {
      return null;
    }
  },
  writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Operational knobs resolved from the environment (an operational concern, not migration config). */
export interface DebeziumRuntimeOpts {
  stageDir: string;
  configPath: string;
  dataVolume: string;
  metricsPort: number;
  network?: string;
  image: string;
}

/** Pure: resolve the runtime opts for a migration from env + the topic prefix. */
export function resolveRuntimeOpts(
  env: Record<string, string | undefined>,
  topicPrefix: string,
): DebeziumRuntimeOpts {
  const stageDir = env.PGMIG_DBZ_STAGE_DIR ?? join(tmpdir(), `pgmig-dbz-${topicPrefix}`);
  const portRaw = env.PGMIG_DBZ_METRICS_PORT;
  const metricsPort = portRaw ? Number(portRaw) : 8080;
  if (!Number.isInteger(metricsPort) || metricsPort <= 0) {
    throw new Error(`PGMIG_DBZ_METRICS_PORT must be a positive integer, got '${portRaw}'`);
  }
  return {
    stageDir,
    configPath: join(stageDir, "application.properties"),
    dataVolume: env.PGMIG_DBZ_DATA_VOLUME ?? debeziumDataVolume(topicPrefix),
    metricsPort,
    network: env.PGMIG_DBZ_NETWORK || undefined,
    image: env.PGMIG_DBZ_IMAGE ?? DEBEZIUM_IMAGE,
  };
}

/**
 * The heterogeneous data-plane engine (HETEROGENEOUS.md §3, impl B): wraps a Debezium Server
 * process (MySQL binlog → JDBC sink → Postgres, no Kafka). The delivery vehicle is pinned
 * (debezium-runtime.ts) and the config + run-spec + reconcile renderers are unit-tested.
 *
 * Full lifecycle implemented + harness-verified (test/heterogeneous/, PASS) against real Debezium
 * 3.6.0.CR1 + MySQL 8.2 + Postgres 16: `replicate` (stage config + run the container + wait for
 * health), `watch` (connector health + row-count convergence), `reconcile` (count + portable
 * aggregates, downgrade caveat logged loud), `cutover` (translated-schema sign-off gate + binlog
 * write-stop gate + identity resync), `teardown` (stop/rm + drop the offset volume). Debezium
 * connects to MySQL itself for `replicate`/`teardown`, so those never touch the `source` Db (which
 * `connect()` builds as a Postgres client, useless for a MySQL source); the other three open their
 * own `mysql2` connection from SOURCE_DB_URL. Orchestration is unit-tested via the injected
 * {@link DebeziumIO} + MySQL seam; the end-to-end path is the Docker harness's job.
 *
 * Heterogeneous source support spans both `mysql` (binlog) and `sqlserver` (CDC change-tables):
 * the lifecycle methods fork on `cfg.source.engine` for the source client (mysql2 vs mssql), the
 * rendered SQL (backtick `db`.`table` vs bracket [schema].[table]), the reconcile dialect, and the
 * write-stop gate (binlog position vs CDC max LSN). The MySQL path is harness-verified
 * (test/heterogeneous/, PASS); the SQL Server path is exercised by its own harness.
 */
export class DebeziumEngine implements ReplicationEngine {
  readonly kind = "debezium" as const;

  constructor(
    private readonly io: DebeziumIO = defaultDebeziumIO,
    /** Injected for tests; defaults to the real mysql2-backed connector. */
    private readonly mysqlConnect: (url: string) => Promise<MySqlConn> = connectMySql,
    /** Injected for tests; defaults to the real mssql-backed connector. */
    private readonly sqlServerConnect: (url: string) => Promise<SqlServerConn> = connectSqlServer,
  ) {}

  /** Open the source connection for the configured engine (mysql2 or mssql). */
  private openSource(engine: "mysql" | "sqlserver", url: string): Promise<SourceConn> {
    return engine === "sqlserver" ? this.sqlServerConnect(url) : this.mysqlConnect(url);
  }

  /**
   * SOURCE change-log retention window in seconds, or null if unbounded/unknown, for the watch()
   * retention watchdog:
   *  - mysql: `@@binlog_expire_logs_seconds` (0 => no automatic purge => unbounded).
   *  - sqlserver: the CDC cleanup job's `retention` (minutes) from `msdb.dbo.cdc_jobs` for this DB.
   * A probe failure (e.g. the login lacks msdb access) is NON-fatal: log + return null so the
   * watchdog no-ops rather than blocking a migration on a diagnostic query.
   */
  private async sourceRetentionSeconds(
    engine: "mysql" | "sqlserver",
    conn: SourceConn,
  ): Promise<number | null> {
    try {
      if (engine === "mysql") {
        const [r] = await conn.query<{ s: number | string | null }>(
          "SELECT @@binlog_expire_logs_seconds AS s",
        );
        const s = r?.s == null ? 0 : Number(r.s);
        return Number.isFinite(s) && s > 0 ? s : null;
      }
      const [r] = await conn.query<{ retention: number | string | null }>(
        "SELECT retention FROM msdb.dbo.cdc_jobs WHERE job_type = 'cleanup' AND database_id = DB_ID()",
      );
      const min = r?.retention == null ? 0 : Number(r.retention);
      return Number.isFinite(min) && min > 0 ? min * 60 : null;
    } catch (e) {
      log.warn(
        `retention watchdog: could not read source ${engine} change-log retention ` +
          `(${e instanceof Error ? e.message : String(e)}); watchdog disabled for this run`,
      );
      return null;
    }
  }

  /** Stage the rendered config, launch the Debezium container, and wait for it to report healthy. */
  async replicate(_source: Db, _target: Db, cfg: Config, secrets: Secrets): Promise<void> {
    const plan = debeziumPlanFromConfig(cfg, secrets); // throws for non-mysql sources
    const rt = resolveRuntimeOpts(process.env, plan.topicPrefix);
    const properties = renderDebeziumServerConfig(plan);

    log.step(`replicate (debezium) — ${debeziumRuntimePin()}`);
    this.io.mkdirp(rt.stageDir);
    this.io.writeFile(rt.configPath, properties); // contains secrets — 0600, never logged

    const spec = debeziumRunSpec({
      plan,
      configPath: rt.configPath,
      dataVolume: rt.dataVolume,
      metricsPort: rt.metricsPort,
      network: rt.network,
      image: rt.image,
    });
    log.detail(`launching ${spec.name} (${spec.image})`);
    const res = await this.io.exec(spec.argv);
    if (res.exitCode !== 0) {
      throw new Error(
        `docker run failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }

    await this.waitHealthy(spec.healthUrl, spec.name);
    log.ok(`${spec.name} healthy — snapshot + CDC streaming to the target`);
  }

  /** Poll the Quarkus health endpoint until 2xx, or throw after the budget elapses. */
  private async waitHealthy(
    healthUrl: string,
    name: string,
    attempts = 60,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (await this.io.httpOk(healthUrl)) return;
      await this.io.sleep(intervalMs);
    }
    throw new Error(
      `${name} did not become healthy at ${healthUrl} within ${(attempts * intervalMs) / 1000}s — ` +
        `inspect 'docker logs ${name}'.`,
    );
  }

  /**
   * Watch the heterogeneous initial sync to completion. With this image there is NO HTTP metrics
   * endpoint (/q/metrics is 404) — only /q/health, which carries a `debezium` connector check.
   * So watch resolves on the two OBSERVABLE signals: the connector stays healthy (abort loud if it
   * goes DOWN or the endpoint is unreachable), and source/target row counts converge (the
   * catch-up analogue of the native "reach srsubstate='r' + lag~0"). Bounded by
   * watchdog.syncTimeoutMin; polls every watchdog.pollIntervalSec.
   */
  async watch(_source: Db, target: Db, cfg: Config): Promise<void> {
    const engine = heterogeneousEngine(cfg);
    const url = process.env.SOURCE_DB_URL;
    if (!url) throw new Error("watch (debezium): SOURCE_DB_URL is required");
    const name = debeziumContainerName(cfg.replication.publication);
    const rt = resolveRuntimeOpts(process.env, cfg.replication.publication);
    const healthUrl = `http://localhost:${rt.metricsPort}/q/health`;
    const interval = cfg.watchdog.pollIntervalSec * 1000;
    const deadline = Date.now() + cfg.watchdog.syncTimeoutMin * 60_000;
    log.step("watch (debezium) — connector health + initial-sync catch-up");

    const my = await this.openSource(engine, url);
    const started = Date.now();
    const warnFraction = cfg.watchdog.retentionWarnFraction;
    const retentionLabel = engine === "sqlserver" ? "CDC cleanup retention" : "binlog expiry";
    const retentionSec = await this.sourceRetentionSeconds(engine, my);
    if (retentionSec !== null) {
      log.detail(
        `retention watchdog armed: source ${retentionLabel} = ${Math.round(retentionSec / 60)}min ` +
          `(warn at ${Math.round(warnFraction * 100)}%, abort at 100%)`,
      );
    }
    let retentionWarned = false;
    let unreachable = 0;
    try {
      for (;;) {
        const verdict = evaluateRetentionHeadroom({
          elapsedSec: (Date.now() - started) / 1000,
          retentionSec,
          warnFraction,
          engineLabel: retentionLabel,
        });
        if (verdict.level === "abort") throw new Error(verdict.message);
        if (verdict.level === "warn" && !retentionWarned) {
          log.warn(verdict.message);
          retentionWarned = true;
        }

        const res = await this.io.httpText(healthUrl);
        if (!res) {
          if (++unreachable >= 5) {
            throw new Error(
              `Debezium health endpoint ${healthUrl} unreachable ${unreachable}x — is the ` +
                `container running? (docker logs ${name})`,
            );
          }
        } else {
          unreachable = 0;
          const h = parseDebeziumHealth(res.body);
          if (!h.debeziumUp) {
            throw new Error(
              `Debezium connector reports DOWN (${healthUrl}) — the connector has failed; ` +
                `inspect: docker logs ${name}`,
            );
          }
        }

        let caughtUp = true;
        const progress: string[] = [];
        for (const t of cfg.reconcile.tables) {
          const [, tbl] = t.name.split(".") as [string, string];
          const [s] = await my.query<{ n: string }>(
            `SELECT count(*) AS n FROM ${sourceRelation(engine, t.name)}`,
          );
          const [tg] = (await target.unsafe(
            `SELECT count(*)::bigint AS n FROM "public"."${tbl}"`,
          )) as { n: string }[];
          progress.push(`${t.name} ${tg?.n ?? "?"}/${s?.n ?? "?"}`);
          if (String(s?.n) !== String(tg?.n)) caughtUp = false;
        }
        if (caughtUp) {
          log.ok(`initial sync caught up (${progress.join(", ")})`);
          return;
        }
        log.info(`syncing: ${progress.join(", ")}`);
        if (Date.now() > deadline) {
          throw new Error("initial sync did not catch up within watchdog.syncTimeoutMin");
        }
        await this.io.sleep(interval);
      }
    } finally {
      await my.end();
    }
  }

  /**
   * Cross-engine reconcile (HETEROGENEOUS.md §2 item 7): count + portable per-column aggregates
   * computed on the MySQL source and the PG target in each dialect, then diffed. NOT byte-exact —
   * the report carries that caveat and it is logged loudly. Columns + categories are introspected
   * from the TARGET (the post-migration source of truth); source uses `<db>.<table>`, target uses
   * `public.<table>` (the bare name Debezium's RegexRouter lands rows under).
   */
  async reconcile(
    _source: Db,
    target: Db,
    cfg: Config,
    opts: ReconcileOpts = {},
  ): Promise<boolean> {
    const engine = heterogeneousEngine(cfg);
    const url = process.env.SOURCE_DB_URL;
    if (!url)
      throw new Error(
        `reconcile (debezium): SOURCE_DB_URL is required to scan the ${engine} source`,
      );

    log.step("reconcile (debezium — count + portable aggregates, NOT a byte-exact row hash)");
    const my = await this.openSource(engine, url);
    const reports = [];
    try {
      for (const t of cfg.reconcile.tables) {
        const [srcSchema, tbl] = t.name.split(".") as [string, string];
        const cols = await targetAggColumns(target, "public", tbl);
        if (cols.length === 0) {
          log.err(`${t.name}: no non-generated columns on target public.${tbl}`);
          return false;
        }
        const myRows = await my.query(renderAggregateQuery(engine, srcSchema, tbl, cols));
        const pgRows = (await target.unsafe(
          renderAggregateQuery("postgres", "public", tbl, cols),
        )) as Record<string, unknown>[];
        const report = reconcileAggregateReport(
          t.name,
          parseAggregateRow(myRows[0] ?? {}, cols),
          parseAggregateRow(pgRows[0] ?? {}, cols),
        );
        reports.push(report);
        const head = `${t.name}: src=${report.sourceRows} tgt=${report.targetRows}`;
        if (report.match) {
          log.ok(head);
        } else {
          log.err(`${head} | ${report.mismatches.length} mismatch(es)`);
          for (const m of report.mismatches) log.detail(JSON.stringify(m));
        }
      }
    } finally {
      await my.end();
    }

    if (reports[0]) log.warn(reports[0].caveat); // say the downgrade out loud
    const outDir = opts.outDir ?? "ledger";
    this.io.mkdirp(outDir);
    this.io.writeFile(
      `${outDir}/reconcile-debezium-${Date.now()}.json`,
      JSON.stringify(reports, null, 2),
    );

    const allMatch = reports.every((r) => r.match);
    allMatch
      ? log.ok(
          "RECONCILE PASSED — source and target aggregates match (within the downgrade caveat)",
        )
      : log.err("RECONCILE FAILED — see mismatches above");
    return allMatch;
  }

  /**
   * Fail-closed cutover (mirrors the native LSN gate): (0) confirm the MySQL source is
   * write-stopped by checking the binlog position is stable; (1) drain — poll until source/target
   * row counts converge (writes are stopped, so CDC will catch up); (2) resync any target
   * identity/serial sequence to the source's MAX (Debezium upserts explicit PKs, so a stuck
   * sequence would collide on the next local insert); (3) stop the Debezium container (the
   * analogue of dropping the subscription). Caller MUST have already stopped application writes.
   *
   * Before any of that it enforces the translated-schema sign-off gate (GUIDED-MIGRATION.md §7):
   * cutover refuses to flip traffic onto a schema the operator never reviewed + ratified via
   * `pgmig translate --sign-off`.
   */
  async cutover(_source: Db, target: Db, cfg: Config, opts: CutoverOpts): Promise<void> {
    const engine = heterogeneousEngine(cfg);
    // Schema sign-off gate (the `guided` heart) — must pass before we touch the source/target.
    assertSchemaSignedOff(opts.outDir ?? "ledger");
    const url = process.env.SOURCE_DB_URL;
    if (!url) throw new Error("cutover (debezium): SOURCE_DB_URL is required");
    const posLabel = engine === "sqlserver" ? "CDC max LSN" : "binlog position";
    log.step(`cutover (debezium) — ${engine} write-stop gate + identity resync`);
    log.warn(
      `Assuming application writes to the SOURCE ${engine} are already stopped. If not, stop them now.`,
    );

    const my = await this.openSource(engine, url);
    try {
      // 0. write-stop gate: the source commit position must be stable across a short window.
      const pos1 = await sourceCommitPosition(engine, my);
      await this.io.sleep(2000);
      const pos2 = await sourceCommitPosition(engine, my);
      if (pos1 !== pos2) {
        throw new Error(
          `source ${posLabel} still advancing (${pos1} -> ${pos2}) — writes to the ${engine} source ` +
            "are NOT stopped. Stop them before cutover; any write after this point would be LOST.",
        );
      }
      log.ok(`source ${posLabel} stable at ${pos1} — writes appear stopped`);

      // 1. drain: poll until row counts converge (no precise offset needed once writes are stopped).
      const deadline = Date.now() + (opts.maxLagWaitSec ?? 300) * 1000;
      for (;;) {
        let converged = true;
        for (const t of cfg.reconcile.tables) {
          const [, tbl] = t.name.split(".") as [string, string];
          const [s] = await my.query<{ n: string }>(
            `SELECT count(*) AS n FROM ${sourceRelation(engine, t.name)}`,
          );
          const [tg] = (await target.unsafe(
            `SELECT count(*)::bigint AS n FROM "public"."${tbl}"`,
          )) as { n: string }[];
          if (String(s?.n) !== String(tg?.n)) {
            converged = false;
            log.info(`${t.name}: src=${s?.n} tgt=${tg?.n} (draining)`);
            break;
          }
        }
        if (converged) {
          log.ok("source/target row counts converged — CDC drained");
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            "row counts did not converge before deadline — are writes really stopped?",
          );
        }
        await this.io.sleep(2000);
      }

      // 2. identity/sequence resync (no-op for explicit-PK schemas with no owned sequences).
      await resyncTargetSequences(engine, my, target, cfg);
    } finally {
      await my.end();
    }

    // 3. stop CDC (the analogue of dropping the subscription). teardown removes the container.
    const name = debeziumContainerName(cfg.replication.publication);
    const stop = await this.io.exec(debeziumStopArgv(name));
    if (stop.exitCode !== 0) {
      throw new Error(
        `docker stop ${name} failed (exit ${stop.exitCode}): ${stop.stderr.trim() || stop.stdout.trim()} - ` +
          "CDC may still be running; do not repoint traffic until this is resolved (check 'docker ps').",
      );
    }
    log.ok(`stopped CDC (${name})`);
    log.warn(
      "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
    );
  }

  /** Stop + remove the container and drop the persistent offset/schema-history volume. Idempotent. */
  async teardown(_source: Db, _target: Db, cfg: Config): Promise<void> {
    const name = debeziumContainerName(cfg.replication.publication);
    const volume = debeziumDataVolume(cfg.replication.publication);
    log.step(`teardown (debezium) — ${name}`);
    // stop is best-effort (container may already be stopped); rm -f tolerates a missing container.
    await this.io.exec(debeziumStopArgv(name));
    const rm = await this.io.exec(debeziumRmArgv(name));
    if (rm.exitCode !== 0 && !/no such container/i.test(rm.stderr)) {
      log.warn(`docker rm ${name} exit ${rm.exitCode}: ${rm.stderr.trim()}`);
    }
    const vol = await this.io.exec(debeziumVolumeRmArgv(volume));
    if (vol.exitCode !== 0 && !/no such volume/i.test(vol.stderr)) {
      log.warn(`docker volume rm ${volume} exit ${vol.exitCode}: ${vol.stderr.trim()}`);
    }
    log.ok(`torn down ${name} + volume ${volume}`);
  }
}

/** Introspect a target table's non-generated columns + their portable aggregate categories. */
async function targetAggColumns(target: Db, schema: string, table: string): Promise<AggColumn[]> {
  const rows = await target`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table} AND is_generated = 'NEVER'
    ORDER BY ordinal_position`;
  return rows.map((r) => ({
    name: String(r.column_name),
    category: categorizePgType(String(r.data_type)),
  }));
}

/** Narrow a config's source to the heterogeneous engines (the only ones the DebeziumEngine drives). */
function heterogeneousEngine(cfg: Config): "mysql" | "sqlserver" {
  if (cfg.source.engine === "postgres") {
    throw new Error(
      "DebeziumEngine received a postgres source — engineFor routes postgres to NativePgEngine. " +
        "This is an internal dispatch bug.",
    );
  }
  return cfg.source.engine;
}

/**
 * Quote a single source identifier per engine, escaping an embedded quote char by doubling it.
 * Callers pass columns discovered live from the target's catalog (not just ident-validated
 * config), so an embedded backtick/bracket must not be able to break out of the identifier.
 */
function sourceIdent(engine: "mysql" | "sqlserver", ident: string): string {
  return engine === "sqlserver"
    ? `[${ident.replace(/]/g, "]]")}]`
    : `\`${ident.replace(/`/g, "``")}\``;
}

/** The fully-quoted source relation for a `schema.table` (mysql `db.table`) name, per engine. */
function sourceRelation(engine: "mysql" | "sqlserver", qualifiedName: string): string {
  const [a, b] = qualifiedName.split(".") as [string, string];
  return `${sourceIdent(engine, a)}.${sourceIdent(engine, b)}`;
}

/** Quote a single source column identifier per engine. */
function sourceCol(engine: "mysql" | "sqlserver", col: string): string {
  return sourceIdent(engine, col);
}

/** Read the source commit position (the write-stop gate's stability probe), per engine. */
function sourceCommitPosition(engine: "mysql" | "sqlserver", conn: SourceConn): Promise<string> {
  return engine === "sqlserver" ? sqlServerMaxLsn(conn) : binlogPosition(conn);
}

/**
 * Read the SQL Server CDC max LSN as a hex string. A stable value across a window means no new
 * committed change has been captured (the CDC analogue of a stable binlog position). NULL (no CDC
 * activity / capture not yet run) is itself stable, which is the correct read once writes stop.
 */
async function sqlServerMaxLsn(conn: SourceConn): Promise<string> {
  const [r] = await conn.query<{ lsn: unknown }>("SELECT sys.fn_cdc_get_max_lsn() AS lsn");
  const v = r?.lsn;
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  return String(v);
}

/** Read the MySQL binlog position as `file:pos`. Handles the 8.4 rename of SHOW MASTER STATUS. */
async function binlogPosition(my: SourceConn): Promise<string> {
  for (const stmt of ["SHOW BINARY LOG STATUS", "SHOW MASTER STATUS"]) {
    try {
      const [r] = await my.query<{ File?: string; Position?: string | number }>(stmt);
      if (r?.File) return `${r.File}:${r.Position}`;
    } catch {
      /* try the other spelling */
    }
  }
  throw new Error(
    "could not read MySQL binlog position (SHOW BINARY LOG STATUS / SHOW MASTER STATUS) — " +
      "the CDC user needs REPLICATION CLIENT (MySQL ≤8.0) / BINLOG MONITOR (8.4+) grant.",
  );
}

/**
 * Resync target identity/serial sequences to the source's MAX(owning column). Debezium upserts
 * explicit PK values, so any target sequence is stuck at its schema-load value and the next LOCAL
 * insert would collide. No-op when the schema has no owned sequences (explicit-PK / uuid tables).
 */
async function resyncTargetSequences(
  engine: "mysql" | "sqlserver",
  my: SourceConn,
  target: Db,
  cfg: Config,
): Promise<void> {
  for (const t of cfg.reconcile.tables) {
    const [, tbl] = t.name.split(".") as [string, string];
    const seqs = await target`
      SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname) AS seq, a.attname AS col
      FROM pg_class s
      JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class rt ON rt.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = rt.relnamespace
      JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND tn.nspname = 'public' AND rt.relname = ${tbl}`;
    if (seqs.length === 0) {
      log.detail(`${t.name}: no owned target sequences — nothing to resync`);
      continue;
    }
    for (const row of seqs) {
      const seq = String(row.seq);
      const col = String(row.col);
      try {
        const [mx] = await my.query<{ m: string | null }>(
          `SELECT max(${sourceCol(engine, col)}) AS m FROM ${sourceRelation(engine, t.name)}`,
        );
        const maxVal = mx?.m ?? null;
        if (maxVal === null) {
          log.detail(`${seq}: source MAX(${col}) is NULL — leaving sequence as-is`);
          continue;
        }
        await target.unsafe(`SELECT setval($1, $2, true)`, [seq, String(maxVal)]);
        log.ok(`sequence ${seq} set to ${maxVal} (from source MAX(${col}))`);
      } catch (e) {
        log.warn(
          `sequence ${seq} resync failed (${e instanceof Error ? e.message : String(e)}) — set it manually`,
        );
      }
    }
  }
}

/** Parse the Quarkus /q/health JSON: overall UP + the `debezium` connector check status. */
export function parseDebeziumHealth(body: string): { up: boolean; debeziumUp: boolean } {
  try {
    const j = JSON.parse(body) as {
      status?: string;
      checks?: { name?: string; status?: string }[];
    };
    const up = j.status === "UP";
    const check = Array.isArray(j.checks) ? j.checks.find((c) => c.name === "debezium") : undefined;
    // if there's no named debezium check, fall back to the overall status
    return { up, debeziumUp: check ? check.status === "UP" : up };
  } catch {
    return { up: false, debeziumUp: false };
  }
}
