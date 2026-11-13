import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema, type Secrets, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { cutover } from "../src/steps/cutover.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";

/**
 * LIVE `cutover --with-auth-data` tier: the real pg_dump/psql path on a throwaway pair
 * with a Supabase-shaped `auth` schema (plain Postgres, superuser - Supabase's grants are
 * not exercised here). Needs the pg clients on PATH, so it self-skips in the Docker runner;
 * run it from a host that has them, with the pair on one Docker network so the target can
 * dial the source:
 *
 *   docker network create pgmig-auth
 *   docker run -d --name pgm-src --network pgmig-auth -p 55432:5432 -e POSTGRES_PASSWORD=pw \
 *     postgres:15 -c wal_level=logical
 *   docker run -d --name pgm-tgt --network pgmig-auth -p 55433:5432 -e POSTGRES_PASSWORD=pw postgres:17
 *   TEST_SOURCE_DB_URL='postgresql://postgres:pw@localhost:55432/postgres?sslmode=disable' \
 *   TEST_TARGET_DB_URL='postgresql://postgres:pw@localhost:55433/postgres?sslmode=disable' \
 *   TEST_SOURCE_REPLICATION_URL='postgresql://postgres:pw@pgm-src:5432/postgres?sslmode=disable' \
 *   bun test test/cutover-auth.integration.test.ts
 */
const HAVE_DBS = Boolean(
  process.env.TEST_SOURCE_DB_URL &&
    process.env.TEST_TARGET_DB_URL &&
    process.env.TEST_SOURCE_REPLICATION_URL,
);
const HAVE_CLIENTS = Boolean(Bun.which("pg_dump") && Bun.which("psql"));
const d = HAVE_DBS && HAVE_CLIENTS ? describe : describe.skip;

const PROFILES = "public.catest_profiles";

const cfg: Config = ConfigSchema.parse({
  source: { ref: "a".repeat(20) },
  target: { ref: "b".repeat(20) },
  replication: {
    tables: [PROFILES],
    publication: "catest_pub",
    slot: "catest_slot",
    subscription: "catest_sub",
  },
  reconcile: { tables: [{ name: PROFILES }] },
  watchdog: { maxRetainedWalMb: 1_000_000, pollIntervalSec: 1, syncTimeoutMin: 2 },
});

const secrets = (): Secrets =>
  SecretsSchema.parse({
    SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
    TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
    SOURCE_REPLICATION_URL: process.env.TEST_SOURCE_REPLICATION_URL,
  });

/** A small Supabase-shaped auth schema plus an app table that FKs into auth.users. */
async function authSchema(db: Db): Promise<void> {
  await db.unsafe(`DROP TABLE IF EXISTS ${PROFILES} CASCADE`);
  await db.unsafe("DROP SCHEMA IF EXISTS auth CASCADE");
  await db.unsafe("CREATE SCHEMA auth");
  await db.unsafe("CREATE TABLE auth.users (id uuid PRIMARY KEY, email text NOT NULL)");
  await db.unsafe(
    "CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE)",
  );
  await db.unsafe(
    "CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, token text NOT NULL, user_id varchar(255))",
  );
  await db.unsafe("CREATE TABLE auth.schema_migrations (version text PRIMARY KEY)");
  await db.unsafe(
    `CREATE TABLE ${PROFILES} (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, name text)`,
  );
}

const U1 = "00000000-0000-0000-0000-000000000001";
const U2 = "00000000-0000-0000-0000-000000000002";
const U3 = "00000000-0000-0000-0000-000000000003";

async function addUser(db: Db, id: string, token: string): Promise<void> {
  await db.unsafe("INSERT INTO auth.users VALUES ($1, $2)", [id, `${id.slice(-1)}@example.com`]);
  await db.unsafe("INSERT INTO auth.identities VALUES (gen_random_uuid(), $1)", [id]);
  await db.unsafe("INSERT INTO auth.refresh_tokens (token, user_id) VALUES ($1, $2)", [token, id]);
}

// holds a real (test) auth dump; created in beforeAll, removed in afterAll
let DUMP_DIR = "";

let source: Db;
let target: Db;
let close: () => Promise<void>;

d("live cutover --with-auth-data (real pg_dump/psql)", () => {
  beforeAll(async () => {
    DUMP_DIR = mkdtempSync(join(tmpdir(), "pgmig-cutover-auth-it-"));
    const c = connect(secrets());
    source = c.source;
    target = c.target;
    close = c.close;
    await teardown(source, target, cfg);
    await authSchema(source);
    await authSchema(target);
    await source.unsafe("INSERT INTO auth.schema_migrations VALUES ('source-1'), ('source-2')");
    await target.unsafe("INSERT INTO auth.schema_migrations VALUES ('target-own')");
    await addUser(source, U1, "tok-1");
    await addUser(source, U2, "tok-2");
    await source.unsafe(`INSERT INTO ${PROFILES} VALUES ($1, 'one'), ($2, 'two')`, [U1, U2]);
    // an earlier bootstrap snapshot left U1 on the target, with a stale token row
    await addUser(target, U1, "tok-1-stale");
  });

  afterAll(async () => {
    if (DUMP_DIR) rmSync(DUMP_DIR, { recursive: true, force: true });
    if (!source) return;
    await teardown(source, target, cfg).catch(() => {});
    for (const db of [source, target]) {
      await db.unsafe(`DROP TABLE IF EXISTS ${PROFILES} CASCADE`).catch(() => {});
      await db.unsafe("DROP SCHEMA IF EXISTS auth CASCADE").catch(() => {});
    }
    await close();
  });

  test("auth rows written after the snapshot arrive, app rows survive, target ledger untouched", async () => {
    await replicate(source, target, cfg, secrets());
    await watch(source, target, cfg);
    // after the snapshot: a new sign-up and a refreshed session on the source
    await addUser(source, U3, "tok-3");
    await source.unsafe(`INSERT INTO ${PROFILES} VALUES ($1, 'three')`, [U3]);
    await source.unsafe("INSERT INTO auth.refresh_tokens (token, user_id) VALUES ('tok-1b', $1)", [
      U1,
    ]);

    await cutover(source, target, cfg, {
      maxLagWaitSec: 30,
      authData: {
        sourceUrl: secrets().SOURCE_DB_URL,
        targetUrl: secrets().TARGET_DB_URL,
        outDir: DUMP_DIR,
      },
    });

    const ids = async (db: Db, sql: string) =>
      (await db.unsafe(sql)).map((r) => String(Object.values(r)[0]));
    expect(await ids(target, "SELECT id FROM auth.users ORDER BY id")).toEqual([U1, U2, U3]);
    expect(await ids(target, "SELECT token FROM auth.refresh_tokens ORDER BY token")).toEqual([
      "tok-1",
      "tok-1b",
      "tok-2",
      "tok-3",
    ]);
    // the DELETE ran under replica role: no ON DELETE CASCADE into the replicated table
    expect(await ids(target, `SELECT user_id FROM ${PROFILES} ORDER BY user_id`)).toEqual([
      U1,
      U2,
      U3,
    ]);
    // the target Auth's own migration ledger is neither emptied nor overwritten
    expect(await ids(target, "SELECT version FROM auth.schema_migrations")).toEqual(["target-own"]);
    // the token sequence came across, so the next token cannot collide
    const [s] = await source.unsafe("SELECT last_value FROM auth.refresh_tokens_id_seq");
    const [t] = await target.unsafe("SELECT last_value FROM auth.refresh_tokens_id_seq");
    expect(Number(t?.last_value)).toBe(Number(s?.last_value));
    const [sub] =
      await target`SELECT 1 FROM pg_subscription WHERE subname = ${cfg.replication.subscription}`;
    expect(sub).toBeUndefined();
  }, 120_000);
});
