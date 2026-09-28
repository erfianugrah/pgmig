/**
 * End-to-end pgmig validation against a REAL throwaway Supabase project pair.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... bun run test/live.harness.ts <org-id> [rows]
 *
 * Creates two throwaway projects (source + target, cross-region), loads the
 * annoying schema on both, seeds the source, runs the full pgmig pipeline
 * (doctor → preflight → replicate → watch → reconcile → cutover), asserts that
 * the resynced sequence prevents a post-cutover id collision, then DELETES both
 * projects. One command, repeatable, self-tearing-down.
 *
 * Costs real money while the projects exist (a few minutes). The finally block
 * tears them down on any exit. Requires: SUPABASE_ACCESS_TOKEN in env.
 */
import { randomBytes } from "node:crypto";
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { log } from "../src/log.ts";
import { MgmtApi } from "../src/mgmt.ts";
import { bootstrap } from "../src/steps/bootstrap.ts";
import { cutover } from "../src/steps/cutover.ts";
import { doctor } from "../src/steps/doctor.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { watch } from "../src/steps/watch.ts";
import { createSchema, seedSource } from "./annoying-schema.ts";

const ORG_ID = process.argv[2] ?? "";
if (!ORG_ID) {
  console.error("usage: bun run test/live.harness.ts <org-id> [rows]");
  process.exit(1);
}
const ROWS = Number(process.argv[3] ?? 50_000);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOKEN.startsWith("sbp_")) {
  console.error("SUPABASE_ACCESS_TOKEN (sbp_…) is required");
  process.exit(1);
}

const SRC_REGION = process.env.SRC_REGION ?? "eu-central-1";
const TGT_REGION = process.env.TGT_REGION ?? "eu-west-1";

function randPw(): string {
  return randomBytes(21).toString("base64").replace(/[/+=]/g, "").slice(0, 28);
}

const TABLES = ["public.users", "public.documents", "public.events", "public.audit"];

async function main(): Promise<void> {
  const api = new MgmtApi(TOKEN);
  let srcRef = "";
  let tgtRef = "";

  try {
    log.step(`creating projects (src=${SRC_REGION} tgt=${TGT_REGION})`);
    const srcPw = randPw();
    const tgtPw = randPw();
    [srcRef, tgtRef] = await Promise.all([
      api.createProject("pgmig-livetest-src", ORG_ID, srcPw, SRC_REGION),
      api.createProject("pgmig-livetest-tgt", ORG_ID, tgtPw, TGT_REGION),
    ]);
    log.ok(`src=${srcRef}  tgt=${tgtRef}`);

    log.step("waiting for ACTIVE_HEALTHY (~2-4 min)");
    await api.waitHealthy([srcRef, tgtRef], { pollSec: 15, timeoutMin: 10 });
    await new Promise((r) => setTimeout(r, 20_000));

    const [srcPooler, tgtPooler] = await Promise.all([
      api.getPooler(srcRef),
      api.getPooler(tgtRef),
    ]);
    const srcPool = `postgresql://${srcPooler.user}:${srcPw}@${srcPooler.host}:5432/postgres?sslmode=require`;
    const tgtPool = `postgresql://${tgtPooler.user}:${tgtPw}@${tgtPooler.host}:5432/postgres?sslmode=require`;
    const srcDirect = `postgresql://postgres:${srcPw}@db.${srcRef}.supabase.co:5432/postgres?sslmode=require`;

    const secrets = SecretsSchema.parse({
      SOURCE_DB_URL: srcPool,
      TARGET_DB_URL: tgtPool,
      SOURCE_REPLICATION_URL: srcDirect,
      SUPABASE_ACCESS_TOKEN: TOKEN || undefined,
    });

    const cfg = ConfigSchema.parse({
      source: { ref: srcRef },
      target: { ref: tgtRef },
      replication: {
        publication: "pgmig_pub",
        slot: "pgmig_slot",
        subscription: "pgmig_sub",
        copyData: true,
        tables: TABLES,
      },
      reconcile: { tables: TABLES.map((name) => ({ name })) },
      watchdog: { maxRetainedWalMb: 4096, pollIntervalSec: 5, syncTimeoutMin: 30 },
    });

    const { source, target, close } = connect(secrets);

    try {
      log.step("loading annoying schema on the SOURCE");
      await createSchema(source);

      // Prepare the target via the REAL bootstrap pre-step (not a direct
      // createSchema) so the Supabase-aware path — exclude managed schemas,
      // filter reserved roles, enable citext — is exercised end-to-end against
      // a real Supabase target. Schema-only; replicate carries the rows.
      log.step("bootstrap target (extensions + roles + schema, Supabase-aware)");
      const boot = await bootstrap(source, target, cfg, secrets, {
        confirm: true,
        outDir: "/tmp/pgmig-live-bootstrap",
      });
      if (!boot.ok) throw new Error("bootstrap FAILED");
      const [tgtHasUsers] = await target`SELECT to_regclass('public.users') IS NOT NULL AS ok`;
      if (!tgtHasUsers?.ok) throw new Error("bootstrap did not create public.users on target");
      log.ok(`bootstrap applied ${boot.applied}/${boot.planned} steps; target schema present`);

      log.step(`seeding source (${ROWS.toLocaleString()} documents + deps)`);
      await seedSource(source, ROWS);
      const [counts] = await source.unsafe(
        `SELECT (SELECT count(*) FROM public.users)  +
                (SELECT count(*) FROM public.documents) +
                (SELECT count(*) FROM public.events) +
                (SELECT count(*) FROM public.audit)  AS n`,
      );
      log.ok(`source has ${Number(counts?.n ?? 0).toLocaleString()} total rows`);

      log.step("doctor");
      await doctor(cfg, secrets);

      log.step("preflight");
      await preflight(source, target, cfg);

      log.step("replicate");
      await replicate(source, target, cfg, secrets);

      log.step("watch");
      await watch(source, target, cfg);

      log.step("reconcile");
      const ok = await reconcile(source, target, cfg);
      if (!ok) throw new Error("reconcile FAILED — data mismatch");

      log.step("cutover");
      await cutover(source, target, cfg, { maxLagWaitSec: 120 });

      log.step("post-cutover sequence-collision check");
      const [row] = await target.unsafe(
        `INSERT INTO public.documents (content) VALUES ('post-cutover') RETURNING id`,
      );
      const newId = Number(row?.id);
      const expected = ROWS + 1;
      if (newId === expected) {
        log.ok(
          `new document id=${newId} (expected ${expected}) ✓ sequence resync prevented collision`,
        );
      } else {
        throw new Error(
          `sequence collision: got id=${newId} but expected ${expected} — resync failed`,
        );
      }

      log.ok("LIVE TEST PASSED — pipeline clean end-to-end against real Supabase");
    } finally {
      await close();
    }
  } finally {
    log.step("teardown — deleting throwaway projects");
    await Promise.allSettled(
      [srcRef, tgtRef]
        .filter(Boolean)
        .map((ref) => api.deleteProject(ref).then(() => log.ok(`deleted ${ref}`))),
    );
  }
}

await main();
