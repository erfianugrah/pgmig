/**
 * Real-cloud rehearsal harness for the heterogeneous DebeziumEngine (HETEROGENEOUS.md §6,
 * GUIDED-MIGRATION.md "Real-cloud rehearsal"). The cloud analogue of harness.ts /
 * harness-sqlserver.ts: instead of `docker compose`-ing a throwaway source + target, it drives the
 * REAL engine against endpoints YOU prepared -- a live cloud source (Azure SQL Database / Azure
 * SQL Managed Instance, or Amazon RDS / Aurora MySQL) and a real Postgres target -- so you get
 * production-representative evidence that the beta path works end to end before you trust it.
 *
 * SAFETY: this is a REHEARSAL. It NEVER stops source writes and NEVER cuts over. It runs the
 * read-plus-replicate portion of the lifecycle and then tears the Debezium container down, leaving
 * your source untouched. The cutover write-stop gate is deliberately not called.
 *
 * What it does (exit 0 = PASS):
 *   1. (optional) translate --apply  -- draft the target DDL from the live source catalog and apply
 *      it to the target. Skipped when PGMIG_REHEARSE_SKIP_TRANSLATE=1 (you already applied it).
 *      NEVER signed off -- sign-off is a cutover gate, and this rehearsal does not cut over.
 *   2. replicate  -- launch Debezium Server (the pinned image) pointed at the cloud source.
 *   3. watch      -- connector health + initial-sync catch-up + the retention watchdog.
 *   4. reconcile  -- count + portable aggregates (the cross-engine downgrade, logged loud).
 *   5. teardown   -- stop/remove the container + offset volume. NO cutover.
 *
 * Config + secrets are loaded EXACTLY as the CLI loads them, so what you rehearse is what you run:
 *   - config:  $PGMIG_CONFIG (default ./migrate.config.yaml)   -- source.engine, tables, reconcile
 *   - secrets: $SOURCE_DB_URL / $TARGET_DB_URL (env or your .env) -- the live endpoints
 *
 * For Azure SQL, put `?encrypt=true` on SOURCE_DB_URL (the engine flips TLS on for it). The
 * Debezium container runs on YOUR machine and connects OUT to the cloud source, so the source
 * firewall must allow your egress IP, and SOURCE_DB_URL must be the PUBLIC endpoint (the same URL
 * the host-process reconcile/watch use).
 *
 * Requires Docker on the machine you run this from. NOT part of `bun test` (no .test.ts suffix) and
 * NOT runnable on the dev box per the no-running-daemons safety rule -- run it yourself, with your
 * cloud credentials, from a Docker-capable machine. See test/heterogeneous/README.md.
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { loadConfig, loadSecrets } from "../../src/config.ts";
import { DebeziumEngine } from "../../src/engine/debezium.ts";
import { DEBEZIUM_IMAGE } from "../../src/engine/debezium-runtime.ts";
import { translate } from "../../src/steps/translate.ts";

const sh = (cmd: string[]) => execSync(cmd.join(" "), { stdio: "inherit" });

async function main() {
  const configPath = process.env.PGMIG_CONFIG ?? "migrate.config.yaml";
  const cfg = loadConfig(configPath);
  const secrets = loadSecrets();

  if (cfg.source.engine !== "mysql" && cfg.source.engine !== "sqlserver") {
    console.error(
      `rehearse-cloud is for the heterogeneous engines (mysql | sqlserver); ` +
        `source.engine=${cfg.source.engine ?? "postgres"}. For PG->PG use \`pgmig rehearse run\`.`,
    );
    process.exit(2);
  }

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" pgmig REAL-CLOUD REHEARSAL (heterogeneous)");
  console.log(`   source engine : ${cfg.source.engine}`);
  console.log(`   config        : ${configPath}`);
  console.log(`   tables        : ${cfg.reconcile.tables.map((t) => t.name).join(", ")}`);
  console.log("   SAFETY        : source writes are NEVER stopped; this NEVER cuts over.");
  console.log("═══════════════════════════════════════════════════════════════════════");

  console.log("── build the engine image (cached if already built) ──");
  sh(["docker", "build", "-t", DEBEZIUM_IMAGE, "images/debezium-server/"]);

  const pg = postgres(secrets.TARGET_DB_URL, { idle_timeout: 5 });
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-rehearse-cloud-"));
  // biome-ignore lint/suspicious/noExplicitAny: Db sentinels -- debezium ignores source/target here
  const NODB = null as any;
  const engine = new DebeziumEngine();
  let failed = false;
  try {
    if (process.env.PGMIG_REHEARSE_SKIP_TRANSLATE === "1") {
      console.log("── translate: SKIPPED (PGMIG_REHEARSE_SKIP_TRANSLATE=1) ──");
    } else {
      console.log(
        "── translate: draft the target schema from the live source + apply (NO sign-off) ──",
      );
      const { draft } = await translate(cfg, secrets, { outDir, apply: true, target: pg });
      console.log(draft.sql);
      if (draft.decisions.length > 0) {
        console.log(
          "guided decisions you must review before a REAL cutover (rehearsal skips sign-off):",
        );
        for (const d of draft.decisions) console.log(`  - ${d.table}.${d.column}: ${d.review}`);
      }
    }

    console.log("── replicate: launch Debezium against the cloud source + wait healthy ──");
    await engine.replicate(NODB, NODB, cfg, secrets);

    console.log("── watch: connector health + initial-sync catch-up + retention watchdog ──");
    await engine.watch(NODB, pg, cfg);

    console.log("── reconcile: count + portable aggregates (cross-engine downgrade) ──");
    const ok = await engine.reconcile(NODB, pg, cfg);
    if (!ok) throw new Error("reconcile reported a mismatch");

    console.log(
      "\nREHEARSAL PASS - snapshot + streaming + reconcile healthy against the cloud source.",
    );
    console.log(
      "Source untouched, no cutover performed. Review the guided decisions before a real run.",
    );
  } catch (e) {
    failed = true;
    console.error(`\nREHEARSAL FAIL - ${e instanceof Error ? e.message : String(e)}`);
    console.error("inspect: docker logs pgmig-dbz-<publication>");
  } finally {
    await pg.end({ timeout: 5 });
    console.log(
      "── teardown: stop/remove the Debezium container + offset volume (source untouched) ──",
    );
    try {
      await engine.teardown(NODB, NODB, cfg);
    } catch (e) {
      console.error(`teardown error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
