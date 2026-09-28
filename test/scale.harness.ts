/**
 * Scale harness — NOT a unit test. Builds a deliberately ANNOYING multi-table
 * schema (the kind that breaks naive tools), seeds it to volume, and runs the
 * real pipeline (preflight → replicate → watch → reconcile → cutover) with
 * per-phase wall-clock timing. The point is to stress every gotcha at scale:
 *
 *   - a STORED generated column (tsvector) — the copy CPU bottleneck
 *   - an IDENTITY pk (owned sequence via deptype 'i') + a COMPOSITE pk
 *     + a NO-PK table (REPLICA IDENTITY FULL)
 *   - inter-table FKs (child copied before parent — relies on the subscriber's
 *     replica-role FK suppression during initial sync)
 *   - GUC-sensitive types in row::text: numeric, double precision, timestamptz,
 *     interval, inet, bytea, jsonb, text[], citext, an enum
 *   - unicode + NULLs
 *
 * Run inside the test compose network (service-DNS source:/target:):
 *   docker compose -f docker-compose.test.yml run --rm \
 *     -e ROWS=1000000 runner \
 *     sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'
 *
 * ROWS sizes the documents (gen-column) table; users/events/audit scale off it.
 *
 * MODES (env flags):
 *   (default)             static insert-only bulk copy + reconcile + cutover.
 *   WRITE_LOAD=1          resilience test: a concurrent INSERT/UPDATE/DELETE
 *                         writer on `documents` (+ no-PK UPDATE/DELETE churn on
 *                         `audit`, REPLICA IDENTITY FULL) runs THROUGH the copy
 *                         and streaming apply; writes stop before cutover;
 *                         reconcile runs AFTER cutover at lag=0 with a ledger
 *                         check proving zero inflight loss.
 *   WATCHDOG_FIRE=1       NEGATIVE test: freeze apply + bloat source WAL; `watch`
 *                         MUST abort via the WAL watchdog. Exits non-zero if not.
 *   WRITE_THROUGH_CUTOVER=1  NEGATIVE test: keep writing through cutover; `cutover`
 *                         MUST refuse (lag never drains). Exits non-zero if not.
 *
 * Tunables: WATCHDOG_MB (default 2048 under load, 8 in WATCHDOG_FIRE),
 *   WRITE_INTERVAL_MS (default 4), WRITE_AFTER_SEC (default 5), BLOAT_ROWS (4000).
 */

import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { log } from "../src/log.ts";
import { writer } from "../src/rehearsal/writer.ts";
import { cutover } from "../src/steps/cutover.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";
import { createSchema, seedSource } from "./annoying-schema.ts";

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const WATCHDOG_FIRE = process.env.WATCHDOG_FIRE === "1";
const WRITE_THROUGH_CUTOVER = process.env.WRITE_THROUGH_CUTOVER === "1";
const WRITE_LOAD = process.env.WRITE_LOAD === "1";
const WATCHDOG_MB = Number(
  process.env.WATCHDOG_MB ?? (WATCHDOG_FIRE ? 8 : WRITE_LOAD ? 2048 : 50_000_000),
);
const WRITE_INTERVAL_MS = Number(process.env.WRITE_INTERVAL_MS ?? 4);
const WRITE_AFTER_SEC = Number(process.env.WRITE_AFTER_SEC ?? 5);
const BLOAT_ROWS = Number(process.env.BLOAT_ROWS ?? 4000);
const LEDGER_PATH = `ledger/scale-writer-${Date.now()}.log`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TABLES = ["public.users", "public.documents", "public.events", "public.audit"];

const cfg = ConfigSchema.parse({
  source: { ref: "a".repeat(20) },
  target: { ref: "b".repeat(20) },
  replication: {
    tables: TABLES,
    publication: "scale_pub",
    slot: "scale_slot",
    subscription: "scale_sub",
  },
  reconcile: {
    tables: TABLES.map((name) => ({ name })),
    ...(WRITE_LOAD
      ? { ledgerPath: LEDGER_PATH, ledgerTable: "public.documents", ledgerIdColumn: "id" }
      : {}),
  },
  watchdog: { maxRetainedWalMb: WATCHDOG_MB, pollIntervalSec: 2, syncTimeoutMin: 60 },
});

const secrets = SecretsSchema.parse({
  SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
  TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
});

const since = (t0: number) => (performance.now() - t0) / 1000;
const fmt = (s: number) => `${s.toFixed(1)}s`;

/**
 * Concurrent no-PK churn on `audit` (REPLICA IDENTITY FULL): INSERT unique rows,
 * then UPDATE/DELETE random ones by ctid. Unique `detail` keeps FULL-identity
 * apply unambiguous (no duplicate-row fan-out). Not ledger-tracked — reconcile's
 * full-table hash proves correctness.
 */
async function auditChurn(
  source: Db,
  signal: AbortSignal,
): Promise<{ ins: number; upd: number; del: number }> {
  let ins = 0;
  let upd = 0;
  let del = 0;
  let n = 0;
  while (!signal.aborted) {
    await source`INSERT INTO public.audit (actor, action, detail)
                 VALUES (gen_random_uuid(), 'churn', ${`d-${Date.now()}-${n++}`})`;
    ins++;
    if (Math.random() < 0.3) {
      await source`UPDATE public.audit SET action = 'edited'
                   WHERE ctid = (SELECT ctid FROM public.audit ORDER BY random() LIMIT 1)`;
      upd++;
    }
    if (Math.random() < 0.2) {
      await source`DELETE FROM public.audit
                   WHERE ctid IN (SELECT ctid FROM public.audit ORDER BY random() LIMIT 1)`;
      del++;
    }
    await sleep(15);
  }
  return { ins, upd, del };
}

/** Shared setup: clean slate → schema on both → seed source → preflight → replicate. */
async function prepare(source: Db, target: Db, seedRows: number): Promise<void> {
  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);
  await seedSource(source, seedRows);
  await preflight(source, target, cfg);
  await replicate(source, target, cfg, secrets);
}

/** Default + WRITE_LOAD path: full migration with optional concurrent write load. */
async function migration(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-annoying-${ROWS}-${Date.now()}.log`);
  log.step(`pgmig scale run (annoying schema) — documents=${ROWS.toLocaleString()}`);

  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);

  const tSeed = performance.now();
  await seedSource(source, ROWS);
  const [c] = await source.unsafe(
    `SELECT (SELECT count(*) FROM public.users)  +
            (SELECT count(*) FROM public.documents) +
            (SELECT count(*) FROM public.events) +
            (SELECT count(*) FROM public.audit)  AS n,
            (pg_total_relation_size('public.documents') + pg_total_relation_size('public.events')
             + pg_total_relation_size('public.users') + pg_total_relation_size('public.audit'))::bigint AS bytes`,
  );
  const rows = Number(c?.n ?? 0);
  const mib = Number(c?.bytes ?? 0) / 1_048_576;
  const seedS = since(tSeed);
  log.ok(
    `seeded ${rows.toLocaleString()} rows across 4 tables, ${mib.toFixed(0)} MiB in ${fmt(seedS)}`,
  );

  const tPre = performance.now();
  await preflight(source, target, cfg);
  const preS = since(tPre);

  const tRep = performance.now();
  await replicate(source, target, cfg, secrets);
  const repS = since(tRep);

  // WRITE_LOAD: start concurrent load right after the slot+subscription exist,
  // so it loads the source THROUGH the initial copy.
  const ac = new AbortController();
  const writerP = WRITE_LOAD
    ? writer(source, {
        ledgerPath: LEDGER_PATH,
        intervalMs: WRITE_INTERVAL_MS,
        signal: ac.signal,
        trackRatio: 0.7,
      })
    : null;
  const auditP = WRITE_LOAD ? auditChurn(source, ac.signal) : null;

  const tWatch = performance.now();
  await watch(source, target, cfg);
  const watchS = since(tWatch);

  let writeStats = "";
  if (writerP) {
    // keep writing after the copy completes to exercise pure streaming apply,
    // then stop writes ("app in read-only") BEFORE draining lag at cutover.
    await sleep(WRITE_AFTER_SEC * 1000);
    ac.abort();
    const w = await writerP;
    const a = (await auditP) ?? { ins: 0, upd: 0, del: 0 };
    writeStats =
      `documents ${w.inserts} ins / ${w.updates} upd / ${w.deletes} del (${w.tracked} tracked); ` +
      `audit(no-PK) ${a.ins} ins / ${a.upd} upd / ${a.del} del`;
  }

  // Under load, reconcile is only authoritative AFTER cutover (lag drained to 0);
  // statically, order doesn't matter — keep the original report layout.
  let ok: boolean;
  let recS: number;
  let cutS: number;
  if (WRITE_LOAD) {
    const tCut = performance.now();
    await cutover(source, target, cfg, { maxLagWaitSec: 120 });
    cutS = since(tCut);
    const tRec = performance.now();
    ok = await reconcile(source, target, cfg); // includes the ledger inflight-loss check
    recS = since(tRec);
  } else {
    const tRec = performance.now();
    ok = await reconcile(source, target, cfg);
    recS = since(tRec);
    const tCut = performance.now();
    await cutover(source, target, cfg, { maxLagWaitSec: 120 });
    cutS = since(tCut);
  }

  await teardown(source, target, cfg);
  await close();

  log.step("scale report (annoying schema)");
  log.info(`rows (4 tables)    ${rows.toLocaleString()}`);
  log.info(`on-disk            ${mib.toFixed(0)} MiB`);
  log.info(`seed               ${fmt(seedS)}  (${(rows / seedS).toFixed(0)} rows/s)`);
  log.info(`preflight          ${fmt(preS)}`);
  log.info(`replicate setup    ${fmt(repS)}`);
  log.info(
    `initial copy       ${fmt(watchS)}  (${(mib / watchS).toFixed(1)} MiB/s, ${(rows / watchS).toFixed(0)} rows/s)`,
  );
  log.info(`reconcile          ${fmt(recS)}  -> ${ok ? "PASSED" : "FAILED"}`);
  log.info(`cutover            ${fmt(cutS)}`);
  if (WRITE_LOAD) {
    log.info(`write load         ${writeStats}`);
    log.info(`watchdog armed     ${WATCHDOG_MB} MB maxRetainedWal`);
  }
  log.info(`total e2e          ${fmt(seedS + preS + repS + watchS + recS + cutS)}`);
  if (!ok) {
    log.err("RECONCILE FAILED at scale");
    process.exitCode = 1;
  } else {
    log.ok("scale run complete — annoying schema reconciles clean");
  }
}

/**
 * NEGATIVE test: freeze apply (DISABLE the subscription) and bloat the source
 * WAL, then assert `watch` aborts via the WAL watchdog. Proves the safety valve
 * actually fires, not just that it's configured.
 */
async function watchdogFireTest(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-watchdog-fire-${Date.now()}.log`);
  log.step(`WATCHDOG-FIRE test — watch must abort when slot retains > ${WATCHDOG_MB}MB`);

  await prepare(source, target, Math.min(ROWS, 1000));

  log.step("freeze apply (DISABLE subscription) + bloat source WAL with high-entropy rows");
  await target.unsafe(`ALTER SUBSCRIPTION ${cfg.replication.subscription} DISABLE`);
  // high-entropy payload (distinct md5s, not repeat()) so it does NOT TOAST-compress
  // away — that is what actually advances the WAL past the frozen slot's restart_lsn.
  await source.unsafe(
    `INSERT INTO public.documents (content)
     SELECT (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 400))
     FROM generate_series(1, $1)`,
    [BLOAT_ROWS],
  );

  let fired = false;
  try {
    await watch(source, target, cfg);
    log.err("watch returned WITHOUT firing the WAL watchdog (test FAILED)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fired = /WAL watchdog/i.test(msg);
    if (fired) log.ok(`watchdog fired as expected → ${msg}`);
    else log.err(`watch threw, but not the watchdog → ${msg}`);
  }

  await teardown(source, target, cfg);
  await close();
  if (fired) log.ok("WATCHDOG-FIRE test passed — watch aborts on WAL bloat");
  else process.exitCode = 1;
}

/**
 * NEGATIVE test: keep writing to the source THROUGH cutover; assert `cutover`
 * refuses (lag never drains within --max-lag-wait). Proves cutover fails closed
 * when application writes were not actually stopped.
 */
async function cutoverRefusesTest(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-cutover-refuses-${Date.now()}.log`);
  log.step("CUTOVER-REFUSES test — cutover must fail while source writes continue");

  await prepare(source, target, Math.min(ROWS, 50_000));

  const ac = new AbortController();
  // fast, continuous writes so confirmed_flush_lsn always trails current_wal_lsn
  const writerP = writer(source, {
    ledgerPath: LEDGER_PATH,
    intervalMs: 1,
    signal: ac.signal,
    trackRatio: 0.7,
  });

  await watch(source, target, cfg); // initial copy completes; writer keeps going

  let refused = false;
  try {
    // deliberately DO NOT stop the writer → lag cannot drain
    await cutover(source, target, cfg, { maxLagWaitSec: 8 });
    log.err("cutover COMPLETED despite ongoing source writes (test FAILED)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refused = /lag did not drain/i.test(msg);
    if (refused) log.ok(`cutover refused as expected → ${msg}`);
    else log.err(`cutover threw, but not the lag guard → ${msg}`);
  }

  ac.abort();
  await writerP;
  await teardown(source, target, cfg);
  await close();
  if (refused) log.ok("CUTOVER-REFUSES test passed — cutover fails closed under live writes");
  else process.exitCode = 1;
}

async function main(): Promise<void> {
  if (WATCHDOG_FIRE) await watchdogFireTest();
  else if (WRITE_THROUGH_CUTOVER) await cutoverRefusesTest();
  else await migration();
}

await main();
