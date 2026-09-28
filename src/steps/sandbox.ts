/**
 * `pgmig sandbox` — stand up (and tear down) a throwaway Supabase SOURCE+TARGET
 * project pair for a hands-on rehearsal of the migration pipeline, without
 * touching any real project.
 *
 *   pgmig sandbox up --org <id>      # create pair, seed source, write sandbox config + env
 *   pgmig sandbox status             # show the current sandbox
 *   pgmig sandbox down               # delete both projects + remove generated files
 *
 * `up` writes three files (all gitignored):
 *   - migrate.sandbox.yaml   the migration config pointing at the pair
 *   - .env.sandbox           SOURCE/TARGET pooler URLs + SOURCE_REPLICATION_URL + token
 *   - .pgmig-sandbox.json  state (refs/regions) so `down`/`status` need no args
 *
 * Then drive the pipeline against it (the file is authoritative over your shell):
 *   pgmig -c migrate.sandbox.yaml --env-file .env.sandbox doctor
 *   ... bootstrap --confirm / replicate / watch / reconcile / cutover
 *
 * The pair costs real money while it exists — run `sandbox down` when finished.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseEnvFile } from "../config.ts";
import { connect, type Db } from "../db.ts";
import { log } from "../log.ts";
import type { MgmtApi } from "../mgmt.ts";
// Text import (not a runtime read of a source-relative path) so `bun build
// --compile` embeds the schema into the single-file binary.
import SCHEMA_SQL from "../rehearsal/schema.sql" with { type: "text" };
import { seed } from "../rehearsal/seed.ts";

const STATE_FILE = ".pgmig-sandbox.json";
const CONFIG_FILE = "migrate.sandbox.yaml";
const ENV_FILE = ".env.sandbox";

const TABLES = [
  "public.documents",
  "public.aliases",
  "public.items",
  "public.tags",
  "public.audit_log",
];

export interface SandboxState {
  srcRef: string;
  tgtRef: string;
  srcRegion: string;
  tgtRegion: string;
  createdAt: string;
}

export interface SandboxUpOpts {
  org: string;
  rows: number;
  payloadBytes: number;
  srcRegion: string;
  tgtRegion: string;
}

function randPw(): string {
  return randomBytes(21).toString("base64").replace(/[/+=]/g, "").slice(0, 28);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Conns = { SOURCE_DB_URL: string; TARGET_DB_URL: string; SOURCE_REPLICATION_URL?: string };

/**
 * Acquire a working SOURCE connection, retrying ONLY the connection probe. A
 * project can report ACTIVE_HEALTHY before the Supavisor pooler has registered
 * its tenant (`tenant/user postgres.<ref> not found` / ENOTFOUND), so the pooler
 * URL is briefly unusable. We retry the probe — recreating the client each time,
 * since a client bound to a not-yet-ready tenant can stay poisoned — and return
 * the first live connection. Seeding then runs ONCE on it (NOT inside the retry),
 * so a transient mid-seed error can never double-insert.
 */
async function acquireSource(
  conns: Conns,
  token: string,
): Promise<{ source: Db; close: () => Promise<void> }> {
  const maxAttempts = 18; // ~3 min of 10s polls
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { source, close } = connect({ ...conns, SUPABASE_ACCESS_TOKEN: token });
    try {
      await source`SELECT 1`; // fails until the pooler tenant resolves
      return { source, close };
    } catch (e) {
      await close();
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /not found|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|terminating|starting up/i.test(
        msg,
      );
      if (!transient || attempt === maxAttempts) throw e;
      log.detail(`source not reachable yet (${msg}); retry ${attempt}/${maxAttempts} in 10s`);
      await sleep(10_000);
    }
  }
  throw new Error("unreachable");
}

/** Load the sandbox schema + seed it. Runs EXACTLY ONCE on a live connection. */
async function seedSource(
  conns: Conns,
  token: string,
  rows: number,
  payloadBytes: number,
): Promise<void> {
  const { source, close } = await acquireSource(conns, token);
  try {
    log.step("loading sandbox schema on the SOURCE");
    await source.unsafe(SCHEMA_SQL);
    log.step(`seeding source (${rows.toLocaleString()} documents)`);
    await seed(source, rows, payloadBytes);
    // Seed the IDENTITY table too so its owned sequence advances — this is what
    // makes the cutover sequence-resync observable.
    await source.unsafe(
      `INSERT INTO public.items (title) SELECT 'item ' || g FROM generate_series(1, $1) g`,
      [Math.max(1, Math.floor(rows / 10))],
    );
    const [c] = await source`SELECT count(*)::bigint AS n FROM public.items`;
    log.ok(`seeded documents + ${c?.n} items (IDENTITY sequence ready for the cutover demo)`);
  } finally {
    await close();
  }
}

function connsFromEnvFile(): Conns {
  const env = parseEnvFile(readFileSync(ENV_FILE, "utf8"));
  if (!env.SOURCE_DB_URL || !env.TARGET_DB_URL)
    throw new Error(`${ENV_FILE} is missing SOURCE_DB_URL/TARGET_DB_URL`);
  return {
    SOURCE_DB_URL: env.SOURCE_DB_URL,
    TARGET_DB_URL: env.TARGET_DB_URL,
    SOURCE_REPLICATION_URL: env.SOURCE_REPLICATION_URL,
  };
}

function readState(): SandboxState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SandboxState;
}

function writeState(state: SandboxState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function renderConfig(state: SandboxState): string {
  const tableList = TABLES.map((t) => `    - ${t}`).join("\n");
  const reconcileList = TABLES.map((t) => `    - name: ${t}`).join("\n");
  return `# pgmig SANDBOX config — throwaway pair, safe to delete (pgmig sandbox down).
source:
  ref: ${state.srcRef} # sandbox source (${state.srcRegion})
target:
  ref: ${state.tgtRef} # sandbox target (${state.tgtRegion})

replication:
  publication: pgmig_sandbox_pub
  slot: pgmig_sandbox_slot
  subscription: pgmig_sandbox_sub
  copyData: true
  tables:
${tableList}

reconcile:
  tables:
${reconcileList}

watchdog:
  maxRetainedWalMb: 4096
  pollIntervalSec: 5
  syncTimeoutMin: 30

configSync:
  auth: true
  realtime: true
  postgrest: true
  storage: true
  dbPooler: true
  dbPostgres: false

storage:
  buckets: []
functions:
  enabled: false
`;
}

function renderEnv(srcPool: string, tgtPool: string, srcDirect: string, token: string): string {
  return `# pgmig SANDBOX secrets — throwaway pair (pgmig sandbox down removes this).
SOURCE_DB_URL=${srcPool}
TARGET_DB_URL=${tgtPool}
SOURCE_REPLICATION_URL=${srcDirect}
SUPABASE_ACCESS_TOKEN=${token}
`;
}

export async function sandboxUp(api: MgmtApi, token: string, opts: SandboxUpOpts): Promise<void> {
  const existing = readState();
  let state: SandboxState;
  let conns: Conns;

  if (existing) {
    if (!existing.tgtRef) {
      throw new Error(
        `a previous \`sandbox up\` was interrupted before the target was created ` +
          `(only src=${existing.srcRef} exists). Run \`pgmig sandbox down\` to delete it, ` +
          `then \`sandbox up\` again.`,
      );
    }
    // Resume: a prior `up` created the pair but didn't finish seeding (e.g. the
    // pooler tenant wasn't ready). Reuse the projects + generated files.
    log.step(`sandbox up — resuming src=${existing.srcRef} tgt=${existing.tgtRef}`);
    state = existing;
    await api.waitHealthy([state.srcRef, state.tgtRef], { pollSec: 15, timeoutMin: 12 });
    conns = connsFromEnvFile();
  } else {
    log.step(`sandbox up — creating throwaway pair (src=${opts.srcRegion} tgt=${opts.tgtRegion})`);
    const srcPw = randPw();
    const tgtPw = randPw();
    const createdAt = new Date().toISOString();
    // Create SEQUENTIALLY and persist state after EACH ref is known, so
    // `sandbox down` can always delete whatever exists — even if the second
    // create (or a crash) follows the first. Promise.all would reject both-or-
    // nothing and orphan a created project with no state file.
    const srcRef = await api.createProject("pgmig-sandbox-src", opts.org, srcPw, opts.srcRegion);
    writeState({
      srcRef,
      tgtRef: "",
      srcRegion: opts.srcRegion,
      tgtRegion: opts.tgtRegion,
      createdAt,
    });
    const tgtRef = await api.createProject("pgmig-sandbox-tgt", opts.org, tgtPw, opts.tgtRegion);
    state = { srcRef, tgtRef, srcRegion: opts.srcRegion, tgtRegion: opts.tgtRegion, createdAt };
    writeState(state);
    log.ok(`src=${srcRef}  tgt=${tgtRef}`);

    log.step("waiting for ACTIVE_HEALTHY (~2-4 min)");
    await api.waitHealthy([srcRef, tgtRef], { pollSec: 15, timeoutMin: 12 });

    const [srcPooler, tgtPooler] = await Promise.all([
      api.getPooler(srcRef),
      api.getPooler(tgtRef),
    ]);
    const srcPool = `postgresql://${srcPooler.user}:${srcPw}@${srcPooler.host}:5432/postgres?sslmode=require`;
    const tgtPool = `postgresql://${tgtPooler.user}:${tgtPw}@${tgtPooler.host}:5432/postgres?sslmode=require`;
    const srcDirect = `postgresql://postgres:${srcPw}@db.${srcRef}.supabase.co:5432/postgres?sslmode=require`;

    writeFileSync(CONFIG_FILE, renderConfig(state));
    writeFileSync(ENV_FILE, renderEnv(srcPool, tgtPool, srcDirect, token), { mode: 0o600 });
    log.ok(`wrote ${CONFIG_FILE} + ${ENV_FILE}`);
    conns = { SOURCE_DB_URL: srcPool, TARGET_DB_URL: tgtPool, SOURCE_REPLICATION_URL: srcDirect };
  }

  await seedSource(conns, token, opts.rows, opts.payloadBytes);

  log.ok("SANDBOX READY");
  printDriveSteps(state);
}

function printDriveSteps(state: SandboxState): void {
  console.log(
    [
      "",
      `  src ${state.srcRef} (${state.srcRegion})  ->  tgt ${state.tgtRef} (${state.tgtRegion})`,
      "",
      "  Drive the pipeline (read each gate before continuing):",
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} doctor      # target schema MISSING is expected`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} bootstrap --confirm`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} doctor      # now READY`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} replicate`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} watch`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} reconcile`,
      `    bun start -c ${CONFIG_FILE} --env-file ${ENV_FILE} cutover`,
      "",
      "  When done:  bun start sandbox down",
      "",
    ].join("\n"),
  );
}

export function sandboxStatus(): void {
  const state = readState();
  if (!state) {
    log.info("no sandbox (run `pgmig sandbox up --org <id>`)");
    return;
  }
  log.ok(`sandbox up since ${state.createdAt}`);
  printDriveSteps(state);
}

export async function sandboxDown(api: MgmtApi): Promise<void> {
  const state = readState();
  if (!state) {
    log.info("no sandbox to tear down");
    return;
  }
  const refs = [state.srcRef, state.tgtRef].filter(Boolean);
  log.step(`sandbox down — deleting ${refs.join(" + ")}`);
  const results = await Promise.allSettled(
    refs.map((ref) => api.deleteProject(ref).then(() => log.ok(`deleted ${ref}`))),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") log.warn(`delete ${refs[i]} failed: ${String(r.reason)}`);
  });
  for (const f of [STATE_FILE, CONFIG_FILE, ENV_FILE]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      log.ok(`removed ${f}`);
    }
  }
  log.ok("SANDBOX TORN DOWN");
}
