/**
 * Heterogeneous SQL Server integration harness (HETEROGENEOUS.md §6) — the SQL Server analogue of
 * harness.ts. Drives the REAL DebeziumEngine end-to-end against a live SQL Server (CDC) source +
 * Postgres target. Proves:
 *   1. seed     — CREATE DATABASE + sp_cdc_enable_db + dbo.customers + sp_cdc_enable_table + 4 rows;
 *   2. translate — draft the target schema from the T-SQL catalog, apply it, sign off (the gate);
 *   3. snapshot  — engine.replicate() launches Debezium; the 4 seeded rows land in Postgres;
 *   4. CDC       — a row INSERTed in SQL Server streams through the CDC change-tables to Postgres;
 *   5. reconcile — count + portable aggregates PASS (bracket-quoted, sqlserver dialect);
 *   6. cutover   — schema sign-off gate + CDC-max-LSN write-stop gate + drain + stop CDC;
 *   7. teardown  — engine.teardown() stops/removes the container + volume.
 *
 * Requires Docker. NOT part of `bun test` (no .test.ts suffix) and NOT runnable on the dev box per
 * the no-running-daemons safety rule — run it in a Docker-capable environment (CI / your machine).
 * See README.md. Exit 0 = PASS, non-zero = FAIL.
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { ConfigSchema } from "../../src/config.ts";
import { DebeziumEngine } from "../../src/engine/debezium.ts";
import { signOffSchema, translate } from "../../src/steps/translate.ts";

const COMPOSE = ["docker", "compose", "-f", "test/heterogeneous/docker-compose.sqlserver.yml"];
const NET = "pgmig-dbz-it-mssql";
const SA_PW = "Pgmig!Passw0rd";

// In-network connection strings: the rendered Debezium config runs INSIDE the container on the
// `it` network, so it addresses the services by their compose names. encrypt is off (self-signed).
const SOURCE_DB_URL = `sqlserver://sa:${SA_PW}@mssql:1433/inventory`;
const TARGET_DB_URL = "postgresql://postgres:postgres@postgres:5432/target";
const TARGET_HOST_URL = "postgresql://postgres:postgres@localhost:55433/target";

const cfg = ConfigSchema.parse({
  source: { engine: "sqlserver", databases: ["inventory"] },
  target: { ref: "harness-target-ref0" },
  replication: { tables: ["dbo.customers"], publication: "dbz" },
  reconcile: { tables: [{ name: "dbo.customers" }] },
  watchdog: {},
});
// biome-ignore lint/suspicious/noExplicitAny: harness secrets shape; only the two URLs are read
const secrets = { SOURCE_DB_URL, TARGET_DB_URL } as any;

process.env.PGMIG_DBZ_NETWORK = NET;
process.env.PGMIG_DBZ_METRICS_PORT = "18081"; // distinct from the MySQL harness's 18080
// reconcile/watch/cutover/translate run in THIS (host) process and read SOURCE_DB_URL to query
// SQL Server directly — they need the published host port, not the in-network name.
process.env.SOURCE_DB_URL = `sqlserver://sa:${SA_PW}@127.0.0.1:51433/inventory`;

const sh = (cmd: string[]) => execSync(cmd.join(" "), { stdio: "inherit" });

/** Run a T-SQL batch via sqlcmd inside the mssql container (-C trusts the self-signed cert). */
const sqlcmd = (sql: string, db = "master") =>
  sh([
    ...COMPOSE,
    "exec",
    "-T",
    "mssql",
    "/opt/mssql-tools18/bin/sqlcmd",
    "-S",
    "localhost",
    "-U",
    "sa",
    "-P",
    `"${SA_PW}"`,
    "-C",
    "-b",
    "-d",
    db,
    "-Q",
    `"${sql}"`,
  ]);

async function main() {
  console.log("── build the engine image ──");
  sh(["docker", "build", "-t", "pgmig/debezium-server:3.6.3.Final", "images/debezium-server/"]);

  console.log("── bring up SQL Server + Postgres ──");
  sh([...COMPOSE, "up", "-d", "--wait"]);

  console.log("── seed: create DB, enable CDC (db + table), seed 4 rows ──");
  sqlcmd("IF DB_ID('inventory') IS NULL CREATE DATABASE inventory;");
  sqlcmd("EXEC sys.sp_cdc_enable_db;", "inventory");
  sqlcmd(
    "CREATE TABLE dbo.customers (id INT IDENTITY(1001,1) PRIMARY KEY, " +
      "first_name NVARCHAR(255) NOT NULL, last_name NVARCHAR(255) NOT NULL, email NVARCHAR(255) NOT NULL);",
    "inventory",
  );
  sqlcmd(
    "EXEC sys.sp_cdc_enable_table @source_schema=N'dbo', @source_name=N'customers', " +
      "@role_name=NULL, @supports_net_changes=0;",
    "inventory",
  );
  sqlcmd(
    "INSERT INTO dbo.customers (first_name,last_name,email) VALUES " +
      "(N'Sally',N'Thomas',N'sally@pgmig.dev'),(N'George',N'Bailey',N'george@pgmig.dev')," +
      "(N'Edward',N'Walker',N'ed@pgmig.dev'),(N'Anne',N'Kretchmar',N'anne@pgmig.dev');",
    "inventory",
  );

  // biome-ignore lint/suspicious/noExplicitAny: Db sentinels — debezium ignores source/target
  const NODB = null as any;
  const pg = postgres(TARGET_HOST_URL, { idle_timeout: 5 });
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-harness-mssql-schema-"));
  let failed = false;
  try {
    console.log("── translate: draft + apply the target schema, then sign off (the gate) ──");
    const { draft } = await translate(cfg, { SOURCE_DB_URL: process.env.SOURCE_DB_URL } as never, {
      outDir,
      apply: true,
      target: pg,
    });
    console.log(draft.sql);
    if (draft.decisions.length > 0) {
      console.log("guided decisions (gate cutover until signed off):");
      for (const d of draft.decisions) console.log(`  - ${d.table}.${d.column}: ${d.review}`);
    }
    signOffSchema(outDir);
    console.log("target schema applied + signed off");

    console.log("── replicate: launch Debezium + wait healthy ──");
    await new DebeziumEngine().replicate(NODB, NODB, cfg, secrets);

    console.log("── assert snapshot (expect 4 rows) ──");
    const snap = await waitForCount(pg, 4, 60);
    assert(snap === 4, `snapshot rows = ${snap}, expected 4`);

    console.log("── CDC: insert a row in SQL Server ──");
    sqlcmd(
      "INSERT INTO dbo.customers (first_name,last_name,email) VALUES (N'Ada',N'Lovelace',N'ada@pgmig.dev');",
      "inventory",
    );
    const after = await waitForCount(pg, 5, 45);
    assert(after === 5, `post-insert rows = ${after}, expected 5`);
    const [row] = await pg`SELECT first_name,last_name FROM customers WHERE email='ada@pgmig.dev'`;
    assert(row?.first_name === "Ada" && row?.last_name === "Lovelace", "CDC row content mismatch");

    console.log("── reconcile: count + portable aggregates (expect PASS) ──");
    const ok = await new DebeziumEngine().reconcile(NODB, pg, cfg);
    assert(ok, "reconcile reported a mismatch");

    console.log("── watch: connector health + caught-up (resolves immediately) ──");
    await new DebeziumEngine().watch(NODB, pg, cfg);

    console.log("── cutover: schema sign-off gate + CDC-LSN write-stop gate + drain + stop CDC ──");
    await new DebeziumEngine().cutover(NODB, pg, cfg, { maxLagWaitSec: 45, outDir });
    const running = execSync("docker ps --format '{{.Names}}'", { encoding: "utf8" });
    assert(!/pgmig-dbz-dbz/.test(running), "cutover did not stop the Debezium container");

    console.log("\nHARNESS PASS ✓");
  } catch (e) {
    failed = true;
    console.error(`\nHARNESS FAIL ✗ — ${e instanceof Error ? e.message : String(e)}`);
    console.error("inspect: docker logs pgmig-dbz-dbz");
  } finally {
    await pg.end({ timeout: 5 });
    console.log("── teardown ──");
    try {
      await new DebeziumEngine().teardown(NODB, NODB, cfg);
    } catch (e) {
      console.error(`teardown error: ${e instanceof Error ? e.message : String(e)}`);
    }
    sh([...COMPOSE, "down", "-v"]);
  }
  process.exit(failed ? 1 : 0);
}

async function waitForCount(pg: postgres.Sql, want: number, tries: number): Promise<number> {
  for (let i = 0; i < tries; i++) {
    try {
      const reg = await pg`SELECT to_regclass('public.customers') AS t`;
      if (reg[0]?.t) {
        const [c] = await pg`SELECT count(*)::int AS n FROM customers`;
        const n = Number(c?.n ?? 0);
        if (n >= want) return n;
      }
    } catch {
      /* target not ready yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const [c] = await pg`SELECT count(*)::int AS n FROM customers`;
  return Number(c?.n ?? -1);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

await main();
