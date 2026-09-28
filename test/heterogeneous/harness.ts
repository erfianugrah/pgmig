/**
 * Heterogeneous integration harness (HETEROGENEOUS.md §5) — drives the REAL DebeziumEngine
 * end-to-end against a live MySQL source + Postgres target, the production analogue of the
 * spike's verify.sh. Proves:
 *   1. snapshot — engine.replicate() launches Debezium; the 4 seeded inventory.customers rows
 *      land in the Postgres target;
 *   2. CDC      — a row INSERTed in MySQL streams through the binlog and appears in Postgres;
 *   3. teardown — engine.teardown() stops/removes the container + volume.
 *
 * Requires Docker. NOT part of `bun test` (no .test.ts suffix) and NOT runnable on the dev box
 * per the no-running-daemons safety rule — run it in a Docker-capable environment (CI / your own
 * machine). See README.md for the full sequence.
 *
 * Exit 0 = PASS, non-zero = FAIL.
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { ConfigSchema } from "../../src/config.ts";
import { DebeziumEngine } from "../../src/engine/debezium.ts";
import { signOffSchema, translate } from "../../src/steps/translate.ts";

const COMPOSE = ["docker", "compose", "-f", "test/heterogeneous/docker-compose.yml"];
const NET = "pgmig-dbz-it";

// In-network connection strings: the rendered Debezium config runs INSIDE the container on the
// `it` network, so it addresses the services by their compose names.
const SOURCE_DB_URL = "mysql://debezium:dbz@mysql:3306/inventory";
const TARGET_DB_URL = "postgresql://postgres:postgres@postgres:5432/target";
// Host-side string for the harness's OWN assertions (published port from docker-compose.yml).
const TARGET_HOST_URL = "postgresql://postgres:postgres@localhost:55432/target";

const cfg = ConfigSchema.parse({
  source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
  target: { ref: "harness-target-ref0" },
  replication: { tables: ["inventory.customers"], publication: "dbz" },
  reconcile: { tables: [{ name: "inventory.customers" }] },
  watchdog: {},
});
// biome-ignore lint/suspicious/noExplicitAny: harness secrets shape; only the two URLs are read
const secrets = { SOURCE_DB_URL, TARGET_DB_URL } as any;

process.env.PGMIG_DBZ_NETWORK = NET;
process.env.PGMIG_DBZ_METRICS_PORT = "18080"; // published 8080 → host:18080 for the health probe
// reconcile/watch/cutover run in THIS (host) process and read SOURCE_DB_URL to query MySQL
// directly — they need the published host port, not the in-network name the rendered config uses.
process.env.SOURCE_DB_URL = "mysql://debezium:dbz@127.0.0.1:53306/inventory";

const sh = (cmd: string[]) => execSync(cmd.join(" "), { stdio: "inherit" });
const mysql = (sql: string) =>
  sh([
    ...COMPOSE,
    "exec",
    "-T",
    "mysql",
    "mysql",
    "-uroot",
    "-pdebezium",
    "-N",
    "inventory",
    "-e",
    `"${sql}"`,
  ]);

async function main() {
  console.log("── build the engine image ──");
  sh(["docker", "build", "-t", "pgmig/debezium-server:3.6.3.Final", "images/debezium-server/"]);

  console.log("── bring up MySQL + Postgres ──");
  sh([...COMPOSE, "up", "-d", "--wait"]);

  // biome-ignore lint/suspicious/noExplicitAny: Db sentinels — debezium ignores source/target
  const NODB = null as any;
  const pg = postgres(TARGET_HOST_URL, { idle_timeout: 5 });
  // Production schema-translation out-dir: translate() writes target-schema.sql + the decisions
  // manifest here, and cutover's assertSchemaSignedOff() reads it back. A throwaway temp dir keeps
  // the harness self-contained. cutover is passed { outDir } so the gate finds this manifest.
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-harness-schema-"));
  let failed = false;
  try {
    console.log(
      "── translate: draft + apply the target schema, then sign off (the production gate) ──",
    );
    // SOURCE_DB_URL (set above to the host-published MySQL port) is what translate() reads.
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
    signOffSchema(outDir); // operator's explicit ratification — cutover refuses without it
    console.log("target schema applied + signed off");

    console.log("── replicate: launch Debezium + wait healthy ──");
    await new DebeziumEngine().replicate(NODB, NODB, cfg, secrets);

    console.log("── assert snapshot (expect 4 rows) ──");
    const snap = await waitForCount(pg, 4, 40);
    assert(snap === 4, `snapshot rows = ${snap}, expected 4`);

    console.log("── CDC: insert a row in MySQL ──");
    mysql(
      "INSERT INTO customers (first_name,last_name,email) VALUES ('Ada','Lovelace','ada@pgmig.dev')",
    );
    const after = await waitForCount(pg, 5, 30);
    assert(after === 5, `post-insert rows = ${after}, expected 5`);
    const [row] = await pg`SELECT first_name,last_name FROM customers WHERE email='ada@pgmig.dev'`;
    assert(row?.first_name === "Ada" && row?.last_name === "Lovelace", "CDC row content mismatch");

    console.log("── reconcile: count + portable aggregates (expect PASS) ──");
    const ok = await new DebeziumEngine().reconcile(NODB, pg, cfg);
    assert(ok, "reconcile reported a mismatch");

    console.log("── watch: connector health + caught-up (resolves immediately) ──");
    await new DebeziumEngine().watch(NODB, pg, cfg);

    console.log("── cutover: schema sign-off gate + write-stop gate + drain + stop CDC ──");
    await new DebeziumEngine().cutover(NODB, pg, cfg, { maxLagWaitSec: 30, outDir });
    // cutover stops the container — confirm it is gone from the running set
    const running = execSync("docker ps --format '{{.Names}}'", { encoding: "utf8" });
    assert(!/pgmig-dbz-dbz/.test(running), "cutover did not stop the Debezium container");

    console.log("\nHARNESS PASS ✓");
  } catch (e) {
    failed = true;
    console.error(`\nHARNESS FAIL ✗ — ${e instanceof Error ? e.message : String(e)}`);
    console.error("inspect: docker logs pgmig-dbz-dbz");
    // Teardown removes the container, so print its log before it goes.
    try {
      console.error(execSync("docker logs --tail 120 pgmig-dbz-dbz 2>&1", { encoding: "utf8" }));
    } catch {
      /* container may never have started */
    }
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
