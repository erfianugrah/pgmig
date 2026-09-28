#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  applyEnvFile,
  type Config,
  loadConfig,
  loadSecrets,
  loadToken,
  nonEmptyEnv,
  SecretsSchema,
  supabaseSourceRef,
} from "./config.ts";
import { connect, type Db } from "./db.ts";
import { engineFor } from "./engine/index.ts";
import { allDriftableItems, DEFAULT_MAX_AGE_DAYS, kbDrift, renderDrift } from "./kb/drift.ts";
import { buildEngineGuide, preppableEngines, renderEngineGuide } from "./kb/engine-prep.ts";
import { buildGuide, guidableProviders, renderGuide } from "./kb/guide.ts";
import { log } from "./log.ts";
import { MgmtApi } from "./mgmt.ts";
import { runChaos, SCENARIOS, type ScenarioName } from "./rehearsal/chaos.ts";
import { integration } from "./rehearsal/integration.ts";
import { rehearseRun } from "./rehearsal/orchestrate.ts";
import { seed, seedToSize } from "./rehearsal/seed.ts";
import { writer } from "./rehearsal/writer.ts";
import { bootstrap } from "./steps/bootstrap.ts";
import { claim } from "./steps/claim.ts";
import { transferFunctions, transferStorage } from "./steps/cli-wrappers.ts";
import { configSync } from "./steps/config-sync.ts";
import { doctor } from "./steps/doctor.ts";
import { preflight } from "./steps/preflight.ts";
import { provision } from "./steps/provision.ts";
import { PHASES, type Phase, run } from "./steps/run.ts";
import { sandboxDown, sandboxStatus, sandboxUp } from "./steps/sandbox.ts";
import { printStatus, status } from "./steps/status.ts";
import { renderTranslate, signOffSchema, translate } from "./steps/translate.ts";
import { type FailOn, verify } from "./steps/verify.ts";
import { upgradeCapture } from "./upgrade/capture.ts";
import { upgradeDoctor } from "./upgrade/doctor.ts";
import { upgradeLab } from "./upgrade/lab.ts";
import { connectSourceOnly, resolveSourceUrl } from "./upgrade/source.ts";
import { upgradeVerify } from "./upgrade/verify.ts";

// JSON import (not a runtime readFileSync of ../package.json) so `bun build
// --compile` inlines the version into the single-file binary.
const { version } = pkg;

const program = new Command();
program
  .name("pgmig")
  .version(version, "-V, --version")
  .description(
    "Near-zero-downtime Postgres-to-Postgres migration orchestrator (logical replication).\n" +
      "Generic PG15+; Supabase-aware. Step-by-step runbook: docs/RUNBOOK.md. Start with `pgmig doctor`.",
  )
  .option("-c, --config <path>", "path to migrate.config.yaml", "migrate.config.yaml")
  .option(
    "--env-file <path>",
    "secrets file to load, authoritative over inherited env (default: .env if present)",
  )
  .option("--no-env-file", "do not load any secrets file; use the inherited environment as-is")
  .option(
    "--log-file <path>",
    "mirror all logs to this append-only file (default: logs/pgmig-<command>-<ts>.log)",
  )
  .option("--no-log-file", "disable the durable log file (terminal only)");

// Open the durable log sink before any command runs, unless --no-log-file.
// A migration spans hours; the terminal/SSH session dies but the file persists.
program.hook("preAction", (thisCommand, actionCommand) => {
  const opts = thisCommand.opts();
  // Resolve secrets BEFORE any loadSecrets in the action. The file is
  // authoritative over inherited env (a leaked shell SOURCE_DB_URL must not
  // silently shadow it), and any override of a *differing* inherited value is
  // surfaced loudly. `--no-env-file` opts out entirely.
  if (opts.envFile !== false) {
    const explicit = typeof opts.envFile === "string";
    const path = explicit ? (opts.envFile as string) : ".env";
    if (existsSync(path)) {
      const { applied, conflicts } = applyEnvFile(path);
      log.detail(`loaded ${applied.length} var(s) from ${path}`);
      if (conflicts.length)
        log.warn(
          `${path} overrode ${conflicts.length} inherited env var(s): ${conflicts.join(", ")} ` +
            `(the file wins — pass --no-env-file to use the inherited values instead)`,
        );
    } else if (explicit) {
      // single throw — parseAsync's .catch logs it (no double log.err here)
      throw new Error(`--env-file ${path} not found`);
    }
  }
  if (opts.logFile === false) return; // --no-log-file
  const cmd = actionCommand.name();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = typeof opts.logFile === "string" ? opts.logFile : `logs/pgmig-${cmd}-${ts}.log`;
  const resolved = log.toFile(path);
  log.detail(`logging to ${resolved}`);
});

/** Run a step that needs DB connections, ensuring clients are always closed. */
async function withDb(
  fn: (db: { source: Db; target: Db }, cfg: Config) => Promise<void>,
): Promise<void> {
  const cfg = loadConfig(program.opts().config);
  const secrets = loadSecrets();
  const { source, target, close } = connect(secrets);
  try {
    await fn({ source, target }, cfg);
  } catch (e) {
    // L-7: surface the stack trace in DEBUG mode so implementation bugs don't
    // look identical to user-facing errors in logs.
    if (process.env.DEBUG && e instanceof Error && e.stack) log.detail(e.stack);
    log.err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await close();
  }
}

program
  .command("run")
  .description(
    "autonomously run the pipeline (preflight→replicate→watch→reconcile) — for CI/Lambda",
  )
  .option("--through <phase>", `stop after: ${PHASES.join(" | ")}`, "reconcile")
  .option("--json", "emit NDJSON events on stdout (human logs → stderr)", false)
  .option("--confirm-writes-stopped", "required to allow --through cutover", false)
  .option("--max-lag-wait <sec>", "cutover lag-drain wait", "300")
  .action((o) => {
    const through = o.through as Phase;
    if (!PHASES.includes(through)) {
      log.err(`unknown --through '${through}' (valid: ${PHASES.join(", ")})`);
      process.exitCode = 1;
      return;
    }
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const r = await run(source, target, cfg, loadSecrets(), {
        through,
        json: Boolean(o.json),
        confirmWritesStopped: Boolean(o.confirmWritesStopped),
        maxLagWaitSec: Number(o.maxLagWait),
      });
      if (!r.ok) process.exitCode = 1;
    });
  });

program
  .command("status")
  .description("poll-once replication snapshot (sync state, WAL, lag) — for a scheduled watcher")
  .option("--json", "emit a single JSON object on stdout", false)
  .option("--require-synced", "exit non-zero unless all tables are ready", false)
  .action((o) => {
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const snap = await status(source, target, cfg);
      if (o.json) process.stdout.write(`${JSON.stringify(snap)}\n`);
      else printStatus(snap);
      if (o.requireSynced && !snap.tables.allReady) process.exitCode = 1;
    });
  });

program
  .command("doctor")
  .description("automated readiness checklist (config, connectivity, schema, reconcile, target)")
  .option("--source-only", "skip target probing (target not created yet)", false)
  .action((o) => {
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets();
    doctor(cfg, secrets, { sourceOnly: Boolean(o.sourceOnly) })
      .then((r) => {
        if (r.fail > 0) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("bootstrap")
  .description(
    "prepare the TARGET before replicate: enable extensions + restore roles + schema from source (preview unless --confirm)",
  )
  .option(
    "--confirm",
    "actually apply (MUTATES THE TARGET: enables extensions, restores roles + schema); default: preview only",
    false,
  )
  .option("--out-dir <path>", "directory for the dumped roles/schema SQL", "ledger")
  .option(
    "--all-schemas",
    "dump EVERY schema (default: a Supabase source excludes auth/storage/etc., which already exist on the target)",
    false,
  )
  .option(
    "--with-auth-data",
    "also dump+restore the auth-schema ROW data (the auth.users FK pre-step) with FK triggers deferred",
    false,
  )
  .action((o) =>
    withDb(async ({ source, target }, cfg) => {
      const r = await bootstrap(source, target, cfg, loadSecrets(), {
        confirm: Boolean(o.confirm),
        outDir: o.outDir,
        allSchemas: Boolean(o.allSchemas),
        withAuthData: Boolean(o.withAuthData),
      });
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command("preflight")
  .description("read-only checks: versions, wal_level, subscribe grant, replica identity")
  .action(() => withDb(({ source, target }, cfg) => preflight(source, target, cfg)));

program
  .command("replicate")
  .description("create publication + slot + subscription (starts initial sync)")
  .action(() =>
    withDb(({ source, target }, cfg) =>
      engineFor(cfg).replicate(source, target, cfg, loadSecrets()),
    ),
  );

program
  .command("watch")
  .description("poll initial-sync state + WAL bloat watchdog until all tables ready")
  .action(() => withDb(({ source, target }, cfg) => engineFor(cfg).watch(source, target, cfg)));

program
  .command("reconcile")
  .description("chunked checksum reconciliation (run after writes stop & lag drains)")
  .option("--mode <mode>", "chunked | full", "chunked")
  .option("--buckets <n>", "bucket count for chunked mode", "256")
  .option("--max-examples <n>", "max divergent rows to report", "20")
  // L-17: expose outDir so operators can redirect the JSON report from the CLI
  .option("--out-dir <path>", "directory for the reconcile JSON report", "ledger")
  .action((o) =>
    withDb(async ({ source, target }, cfg) => {
      const ok = await engineFor(cfg).reconcile(source, target, cfg, {
        mode: o.mode === "full" ? "full" : "chunked",
        buckets: Number(o.buckets),
        maxExamples: Number(o.maxExamples),
        outDir: o.outDir,
      });
      if (!ok) process.exitCode = 1;
    }),
  );

program
  .command("cutover")
  .description("drain lag to zero then drop the subscription (stop app writes FIRST)")
  .option("--max-lag-wait <sec>", "seconds to wait for lag to drain", "300")
  .option(
    "--out-dir <path>",
    "directory holding the translated-schema sign-off manifest (heterogeneous sources)",
    "ledger",
  )
  .action((o) =>
    withDb(({ source, target }, cfg) =>
      engineFor(cfg).cutover(source, target, cfg, {
        maxLagWaitSec: Number(o.maxLagWait),
        outDir: o.outDir,
      }),
    ),
  );

program
  .command("translate")
  .description(
    "guided MySQL→Postgres schema translation: draft target DDL + surface the type decisions a " +
      "human must ratify (never auto-applies; cutover gates on `--sign-off`)",
  )
  .option("--out-dir <path>", "directory for target-schema.sql + the decisions manifest", "ledger")
  .option(
    "--apply",
    "also apply the drafted DDL to the TARGET (MUTATES it); default: write only",
    false,
  )
  .option(
    "--sign-off",
    "ratify the existing draft (review + apply done) so cutover may proceed",
    false,
  )
  .option("--json", "emit the draft + decisions manifest as JSON on stdout", false)
  .action((o) => {
    if (o.signOff) {
      // Sign-off needs no DB — it only flips the on-disk manifest.
      try {
        const manifest = signOffSchema(o.outDir);
        if (o.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      } catch (e) {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
      return;
    }
    if (o.json) log.toStderr();
    return withDb(async ({ target }, cfg) => {
      const result = await translate(cfg, loadSecrets(), {
        outDir: o.outDir,
        apply: Boolean(o.apply),
        target,
      });
      if (o.json) process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
      else renderTranslate(result);
    });
  });

program
  .command("teardown")
  .description("drop subscription/slot/publication safely (idempotent)")
  .action(() => withDb(({ source, target }, cfg) => engineFor(cfg).teardown(source, target, cfg)));

program
  .command("config-sync")
  .description("copy Auth/Realtime/Storage/etc config via Management API (secrets stripped)")
  .option("--dry-run", "diff only, do not apply", false)
  .action((o) => {
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    api
      .assertAccess([supabaseSourceRef(cfg), cfg.target.ref])
      .then(() => configSync(api, cfg, { dryRun: Boolean(o.dryRun) }))
      .then((r) => {
        if (r.err > 0) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("verify")
  .description("post-migration health gate: run Supabase advisors on the TARGET, fail on lints")
  .option("--fail-on <level>", "gate threshold: error | warn | info", "error")
  .option("--out-dir <path>", "directory for the verify JSON report", "ledger")
  .option("--json", "emit a single JSON result object on stdout", false)
  .action((o) => {
    const failOn = String(o.failOn).toLowerCase();
    if (!["error", "warn", "info"].includes(failOn)) {
      log.err(`unknown --fail-on '${o.failOn}' (valid: error, warn, info)`);
      process.exitCode = 1;
      return;
    }
    if (o.json) log.toStderr();
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    api
      .assertAccess([cfg.target.ref])
      .then(() =>
        verify(api, cfg, { failOn: failOn as FailOn, outDir: o.outDir, json: Boolean(o.json) }),
      )
      .then((r) => {
        if (!r.ok) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("provision")
  .description(
    "copy billable infra (compute size, PITR/IPv4, disk, backup schedule) to the target (preview unless --confirm)",
  )
  .option("--confirm", "actually apply (changes the target's BILL); default: preview only", false)
  .action((o) => {
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    api
      .assertAccess([supabaseSourceRef(cfg), cfg.target.ref])
      .then(() => provision(api, cfg, { confirm: Boolean(o.confirm) }))
      .then((r) => {
        if (!r.ok) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("claim <orgSlug> <token>")
  .description(
    "org-level: move a project INTO another org via a claim token (preview unless --confirm)",
  )
  .option("--confirm", "actually perform the claim (default: preview + gate only)", false)
  .action((orgSlug, token, o) => {
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    claim(api, log, { slug: orgSlug, token, confirm: Boolean(o.confirm) })
      .then((r) => {
        if (!r.ok) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("functions")
  .description("transfer Edge Functions via the supabase CLI")
  .option("--dry-run", "print commands only", false)
  .action((o) =>
    transferFunctions(loadConfig(program.opts().config), { dryRun: Boolean(o.dryRun) }),
  );

program
  .command("storage <localDir>")
  .description("push downloaded storage objects to target buckets via the supabase CLI")
  .option("--dry-run", "print commands only", false)
  .action((dir, o) =>
    transferStorage(loadConfig(program.opts().config), dir, { dryRun: Boolean(o.dryRun) }),
  );

// --- knowledge base ---
program
  .command("guide <target>")
  .description(
    "enablement playbook for a migration source. managed-Postgres provider " +
      `(${guidableProviders().join(" | ")}) or heterogeneous engine (${preppableEngines().join(" | ")})`,
  )
  .option("--role <role>", "limit to the 'source' or 'target' role (PG providers only)")
  .option("--json", "emit the guide as JSON on stdout", false)
  .action((target, o) => {
    // Heterogeneous source engines (mysql/sqlserver) route to the engine-prep playbook; managed
    // Postgres providers route to the provider-hint guide. Disjoint id spaces, so dispatch on
    // membership.
    const engines = preppableEngines();
    if (engines.includes(target)) {
      const guide = buildEngineGuide(target);
      if (o.json) {
        log.toStderr();
        process.stdout.write(`${JSON.stringify(guide, null, 2)}\n`);
      } else {
        renderEngineGuide(guide);
      }
      return;
    }
    const known = guidableProviders();
    if (!known.includes(target)) {
      log.err(`no guide for '${target}'. available: ${[...known, ...engines].join(", ")}`);
      process.exitCode = 1;
      return;
    }
    if (o.role && o.role !== "source" && o.role !== "target") {
      log.err("--role must be 'source' or 'target'");
      process.exitCode = 1;
      return;
    }
    const guide = buildGuide(target, { role: o.role });
    if (o.json) {
      log.toStderr();
      process.stdout.write(`${JSON.stringify(guide, null, 2)}\n`);
    } else {
      renderGuide(guide);
    }
  });

const kb = program
  .command("kb")
  .description("knowledge base maintenance (provider hints + provenance)");

kb.command("drift")
  .description("flag KB items whose guidance hasn't been re-verified against its source recently")
  .option("--max-age-days <n>", "staleness threshold in days", String(DEFAULT_MAX_AGE_DAYS))
  .option("--json", "emit the drift report as JSON on stdout", false)
  .action((o) => {
    const report = kbDrift(allDriftableItems(), { maxAgeDays: Number(o.maxAgeDays) });
    if (o.json) {
      log.toStderr();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      renderDrift(report);
    }
    if (report.staleCount > 0) process.exitCode = 1;
  });

// --- rehearsal harness ---
const rehearse = program.command("rehearse").description("rehearsal data harness (test rig)");

rehearse
  .command("integration")
  .description("live integration tier: throwaway Docker Postgres pair + bun test (self-contained)")
  .action(async () => {
    const code = await integration();
    if (code !== 0) process.exitCode = code;
  });

rehearse
  .command("seed")
  .description("seed the source documents table")
  .option("--rows <n>", "row count", "100000")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .action((o) => withDb(({ source }, _cfg) => seed(source, Number(o.rows), Number(o.payload))));

rehearse
  .command("seed-size")
  .description("seed to a target ON-DISK SIZE to emulate prod scale (e.g. --gib 200)")
  .option("--gib <n>", "target table size in GiB", "10")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .option("--batch <rows>", "rows per insert batch", "50000")
  .option("--concurrency <n>", "parallel insert batches", "4")
  .action((o) =>
    withDb(({ source }, _cfg) =>
      seedToSize(source, {
        targetBytes: Number(o.gib) * 1_073_741_824,
        payloadBytes: Number(o.payload),
        batchRows: Number(o.batch),
        concurrency: Number(o.concurrency),
      }),
    ),
  );

rehearse
  .command("run")
  .description("full scale rehearsal in-tool: seed → run → fault gate → teardown (THROWAWAY pair)")
  .option("--gib <n>", "target source size in GiB", "10")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .option("--batch <rows>", "rows per insert batch", "1000")
  .option("--concurrency <n>", "parallel insert batches", "4")
  .option(
    "--chaos <scenario>",
    `inject a fault after sync, expect reconcile to catch it: ${Object.keys(SCENARIOS).join(" | ")}`,
  )
  .option("--chaos-arg <value>", "argument for the chaos scenario (e.g. public.documents)")
  .action((o) => {
    if (o.chaos && !(o.chaos in SCENARIOS)) {
      log.err(`unknown --chaos '${o.chaos}' (valid: ${Object.keys(SCENARIOS).join(", ")})`);
      process.exitCode = 1;
      return;
    }
    return withDb(async ({ source, target }, cfg) => {
      const ok = await rehearseRun(source, target, cfg, loadSecrets(), {
        targetBytes: Number(o.gib) * 1_073_741_824,
        payloadBytes: Number(o.payload),
        batchRows: Number(o.batch),
        concurrency: Number(o.concurrency),
        chaos: o.chaos as ScenarioName | undefined,
        chaosArg: o.chaosArg,
      });
      if (!ok) process.exitCode = 1;
    });
  });

rehearse
  .command("chaos <scenario>")
  .description(`inject a failure mode: ${Object.keys(SCENARIOS).join(" | ")}`)
  .option("--arg <value>", "scenario argument (table / subscription name)")
  .action((scenario, o) => {
    if (!(scenario in SCENARIOS)) {
      log.err(`unknown scenario '${scenario}'. options: ${Object.keys(SCENARIOS).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    return withDb(({ source, target }, _cfg) =>
      runChaos({ source, target, arg: o.arg }, scenario as ScenarioName),
    );
  });

rehearse
  .command("writer")
  .description("continuous insert/update load with an append-only id ledger")
  .option("--ledger <path>", "ledger file path", "ledger/written_ids.log")
  .option("--interval <ms>", "ms between inserts", "50")
  .option("--duration <sec>", "stop after N seconds (default: run until Ctrl-C)")
  .action((o) =>
    withDb(async ({ source }, _cfg) => {
      await writer(source, {
        ledgerPath: o.ledger,
        intervalMs: Number(o.interval),
        durationSec: o.duration ? Number(o.duration) : undefined,
      });
    }),
  );

// --- sandbox: throwaway Supabase pair for a hands-on rehearsal ---
const sandbox = program
  .command("sandbox")
  .description("throwaway Supabase source+target pair for a hands-on pipeline rehearsal");

sandbox
  .command("up")
  .description(
    "create a throwaway pair, seed the source, write migrate.sandbox.yaml + .env.sandbox",
  )
  .requiredOption("--org <id>", "Supabase organization id to create the projects in")
  .option("--rows <n>", "documents to seed on the source", "3000")
  .option("--payload <bytes>", "approx payload bytes per document", "2000")
  .option("--src-region <r>", "source region", "eu-central-1")
  .option("--tgt-region <r>", "target region", "eu-west-1")
  .action(async (o) => {
    const token = loadToken();
    await sandboxUp(new MgmtApi(token), token, {
      org: o.org,
      rows: Number(o.rows),
      payloadBytes: Number(o.payload),
      srcRegion: o.srcRegion,
      tgtRegion: o.tgtRegion,
    });
  });

sandbox
  .command("status")
  .description("show the current sandbox (refs + drive-the-pipeline commands)")
  .action(() => sandboxStatus());

sandbox
  .command("down")
  .description("delete both throwaway projects and remove the generated sandbox files")
  .action(async () => {
    await sandboxDown(new MgmtApi(loadToken()));
  });

/**
 * `upgrade` command group - PG major-version upgrade rehearsal (pg_upgrade path).
 * Registered THREE ways by design: top-level `upgrade`, top-level alias
 * `pgupgrade`, and nested under the rehearsal rig as `rehearse upgrade`.
 * Unlike the migration pipeline, these commands need NO migrate.config.yaml -
 * everything comes from flags + SOURCE/TARGET_DB_URL env.
 */
function registerUpgradeGroup(parent: Command, alias?: string): void {
  const g = parent
    .command("upgrade")
    .description(
      "PG major-version upgrade rehearsal: doctor | capture | lab | verify (pg_upgrade path)",
    );
  if (alias) g.alias(alias);

  g.command("doctor")
    .description(
      "read-only major-upgrade readiness audit of the source (extensions, blockers, downtime estimate)",
    )
    .option("--to <major>", "target Postgres major version", "17")
    .option("--db-url <url>", "source connection string (default: SOURCE_DB_URL)")
    .option("--copy-mbps <n>", "assumed disk copy throughput for the downtime estimate", "100")
    .option("--fixed-overhead-sec <n>", "assumed fixed platform overhead (seconds)", "900")
    .action(async (o) => {
      const sourceUrl = resolveSourceUrl(o.dbUrl);
      const db = connectSourceOnly(sourceUrl);
      try {
        const r = await upgradeDoctor(db, {
          to: Number(o.to),
          sourceUrl,
          copyMbps: Number(o.copyMbps),
          fixedOverheadSec: Number(o.fixedOverheadSec),
        });
        if (r.fail > 0) process.exitCode = 1;
      } catch (e) {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally {
        await db.end({ timeout: 5 });
      }
    });

  g.command("capture")
    .description(
      "dump roles + schema + data of the source into a local dir (input for `upgrade lab`)",
    )
    .option("--db-url <url>", "source connection string (default: SOURCE_DB_URL)")
    .option("--out-dir <path>", "capture output directory", "capture")
    .option("--max-gb <n>", "refuse to capture above this size unless --force", "10")
    .option("--force", "capture even above --max-gb", false)
    .option(
      "--all-schemas",
      "include Supabase-managed schemas (auth/storage/...) in the dumps",
      false,
    )
    .option(
      "--with-auth-data",
      "also dump the auth schema row data separately (deferred-FK restore)",
      false,
    )
    .action(async (o) => {
      const url = resolveSourceUrl(o.dbUrl);
      const db = connectSourceOnly(url);
      try {
        const r = await upgradeCapture(db, url, {
          outDir: o.outDir,
          maxCaptureGb: Number(o.maxGb),
          force: Boolean(o.force),
          allSchemas: Boolean(o.allSchemas),
          withAuthData: Boolean(o.withAuthData),
        });
        if (!r.ok) process.exitCode = 1;
      } catch (e) {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally {
        await db.end({ timeout: 5 });
      }
    });

  g.command("lab")
    .description(
      "Docker lab: time a real `pg_upgrade --link` N times on production-like data " +
        "(--capture-dir from `upgrade capture`, or --seed-gib for fixture+seed)",
    )
    .option("--from <major>", "source Postgres major version", "15")
    .option("--to <major>", "target Postgres major version", "17")
    .option("--runs <n>", "pg_upgrade timing runs", "3")
    .option("--capture-dir <path>", "capture directory from `upgrade capture`")
    .option("--seed-gib <n>", "fixture + size-targeted seed instead of a capture (GiB)")
    .option(
      "--image <flavor>",
      "lab image flavor: auto | pgdg | supabase (auto = supabase for Supabase captures)",
      "auto",
    )
    .option("--from-image <ref>", "supabase/postgres image for the old major (supabase flavor)")
    .option("--to-image <ref>", "supabase/postgres image for the new major (supabase flavor)")
    .option("--prod-bytes <n>", "production DB size in bytes (extrapolated downtime estimate)")
    .option("--keep", "keep lab containers running afterwards (for `upgrade verify`)", false)
    .option("--clean", "tear down the lab containers and exit", false)
    .option("--work-dir <path>", "lab scratch directory (dumps, report)", ".upgrade-lab")
    .action(async (o) => {
      try {
        await upgradeLab({
          from: Number(o.from),
          to: Number(o.to),
          runs: Number(o.runs),
          captureDir: o.captureDir,
          seedGib: o.seedGib ? Number(o.seedGib) : undefined,
          image: o.image,
          fromImage: o.fromImage,
          toImage: o.toImage,
          prodBytes: o.prodBytes ? Number(o.prodBytes) : undefined,
          keep: Boolean(o.keep),
          clean: Boolean(o.clean),
          workDir: o.workDir,
        });
      } catch (e) {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  g.command("verify")
    .description(
      "prove the upgraded cluster is data-identical: chunked-checksum reconcile " +
        "(SOURCE_DB_URL = pre-upgrade copy, TARGET_DB_URL = upgraded cluster)",
    )
    .option("--include-managed", "also diff Supabase-managed schemas (auth/storage/...)", false)
    .option("--out-dir <path>", "directory for the reconcile JSON report", "ledger")
    .option("--max-examples <n>", "max divergent rows to report per table", "20")
    .action(async (o) => {
      // Deliberately NOT loadSecrets(): upgrade verify needs exactly two DB
      // URLs. A stale/placeholder SOURCE_REPLICATION_URL or PAT in the
      // inherited env / auto-loaded .env must not block a lab verify.
      // Use nonEmptyEnv so SOURCE_DB_URL='' errors as 'Required'.
      const pair = SecretsSchema.pick({ SOURCE_DB_URL: true, TARGET_DB_URL: true }).parse(
        nonEmptyEnv(process.env),
      );
      const { source, target, close } = connect(pair);
      try {
        const ok = await upgradeVerify(source, target, {
          includeManaged: Boolean(o.includeManaged),
          outDir: o.outDir,
          maxExamples: Number(o.maxExamples),
        });
        if (!ok) process.exitCode = 1;
      } catch (e) {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });
}

registerUpgradeGroup(program, "pgupgrade");
registerUpgradeGroup(rehearse);

program
  .parseAsync()
  .catch((e) => {
    // Surface a clean one-line error instead of Bun's raw stack dump for any
    // synchronous throw in an action handler (missing token, bad config, etc.).
    log.err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => log.closeFile());
