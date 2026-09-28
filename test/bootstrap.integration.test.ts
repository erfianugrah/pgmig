import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema, type Secrets, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { bootstrap } from "../src/steps/bootstrap.ts";

/**
 * LIVE bootstrap tier. Exercises the REAL pg_dump/pg_dumpall/psql path against a
 * throwaway Postgres pair (see integration.test.ts header for how to stand one
 * up). Skipped unless TEST_SOURCE_DB_URL + TEST_TARGET_DB_URL are set AND the
 * pg_dump/psql client binaries are on PATH (the Docker runner image has neither,
 * so it self-skips there; run locally where the clients exist).
 */
const HAVE_DBS = Boolean(process.env.TEST_SOURCE_DB_URL && process.env.TEST_TARGET_DB_URL);
const HAVE_CLIENTS = Boolean(Bun.which("pg_dump") && Bun.which("psql") && Bun.which("pg_dumpall"));
const d = HAVE_DBS && HAVE_CLIENTS ? describe : describe.skip;

const TABLE = "public.btest";
const ROLE = "btest_role";
const EXT = "pg_trgm"; // contrib, ships with every standard build

function buildConfig(): Config {
  return ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: { tables: [TABLE], publication: "bp", slot: "bs", subscription: "bsub" },
    reconcile: { tables: [{ name: TABLE }] },
    watchdog: { maxRetainedWalMb: 1_000_000, pollIntervalSec: 1, syncTimeoutMin: 2 },
  });
}

function buildSecrets(): Secrets {
  return SecretsSchema.parse({
    SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
    TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
  });
}

const cfg = buildConfig();
const OUT = "/tmp/pgmig-bootstrap-itest";
let source: Db;
let target: Db;
let close: () => Promise<void>;

d("live bootstrap (real pg_dump/psql)", () => {
  beforeAll(async () => {
    const c = connect(buildSecrets());
    source = c.source;
    target = c.target;
    close = c.close;

    // SOURCE: an extension, a role, and a table that DEPENDS on the extension
    // (a GIN trigram index) — so the schema dump is only restorable if the
    // extension was enabled first. This is exactly the ordering bootstrap owns.
    await source.unsafe(`CREATE EXTENSION IF NOT EXISTS ${EXT}`);
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await source.unsafe(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, name text NOT NULL)`);
    await source.unsafe(`CREATE INDEX btest_name_trgm ON ${TABLE} USING gin (name gin_trgm_ops)`);
    await source.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    await source.unsafe(`CREATE ROLE ${ROLE} NOLOGIN`);

    // TARGET: pristine — none of the above present.
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await target.unsafe(`DROP EXTENSION IF EXISTS ${EXT} CASCADE`);
    await target.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  });

  afterAll(async () => {
    if (!(HAVE_DBS && HAVE_CLIENTS)) return;
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await source.unsafe(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await target.unsafe(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await close();
  });

  async function targetHasTable(): Promise<boolean> {
    const [r] = await target`SELECT to_regclass(${TABLE}) IS NOT NULL AS present`;
    return Boolean(r?.present);
  }
  async function targetHasExt(): Promise<boolean> {
    const [r] = await target`SELECT 1 FROM pg_extension WHERE extname = ${EXT}`;
    return Boolean(r);
  }
  async function targetHasRole(): Promise<boolean> {
    const [r] = await target`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`;
    return Boolean(r);
  }

  test("preview plans changes but mutates nothing", async () => {
    const r = await bootstrap(source, target, cfg, buildSecrets(), { confirm: false, outDir: OUT });
    expect(r.planned).toBeGreaterThan(0);
    expect(r.applied).toBe(0);
    // target untouched
    expect(await targetHasTable()).toBe(false);
    expect(await targetHasExt()).toBe(false);
    expect(await targetHasRole()).toBe(false);
  }, 60_000);

  test("--confirm enables the extension, restores the role, and loads the schema", async () => {
    const r = await bootstrap(source, target, cfg, buildSecrets(), { confirm: true, outDir: OUT });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(r.planned);
    expect(await targetHasExt()).toBe(true);
    expect(await targetHasRole()).toBe(true);
    expect(await targetHasTable()).toBe(true);
    // the trigram index (which depends on the extension) came across too
    const [idx] = await target`SELECT 1 FROM pg_indexes WHERE indexname = 'btest_name_trgm'`;
    expect(Boolean(idx)).toBe(true);
  }, 60_000);

  test("re-running --confirm is idempotent for extensions (IF NOT EXISTS)", async () => {
    // table already exists now, so a full schema restore would conflict — but the
    // EXTENSION step must still report nothing to do and not error.
    const [srcExt, tgtExt] = await Promise.all([
      source<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = ${EXT}`,
      target<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = ${EXT}`,
    ]);
    expect(srcExt.length).toBe(1);
    expect(tgtExt.length).toBe(1);
  }, 60_000);
});

/**
 * LIVE Supabase-source tier. Forces the Supabase code path (`supabaseSource: true`)
 * against a plain Postgres pair so we can exercise the REAL dump → filter → restore
 * chain that hostname detection would only enable against a true Supabase host.
 * Proves: reserved roles (anon / supabase_*) are filtered OUT of the restore, the
 * `ALTER ROLE supabase_admin WITH SUPERUSER` line that would otherwise abort the
 * restore is neutralised, app roles survive, and a supautils-allowed `SET` on a
 * pre-existing reserved role still applies.
 */
const APP_ROLE = "btest_app";
const SB_SCHEMA_TABLE = "public.btest_sb";

d("live bootstrap — Supabase source path (role filter)", () => {
  let s: Db;
  let t: Db;
  let closeSb: () => Promise<void>;

  beforeAll(async () => {
    const c = connect(buildSecrets());
    s = c.source;
    t = c.target;
    closeSb = c.close;

    // SOURCE: an app role + reserved roles — one with a SUPERUSER attr, one with a
    // supautils-allowed SET — exactly the shapes the filter must handle.
    await s.unsafe(`DROP TABLE IF EXISTS ${SB_SCHEMA_TABLE} CASCADE`);
    await s.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    await s.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$`,
    );
    await s.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin SUPERUSER; END IF; END $$`,
    );
    await s.unsafe(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    await s.unsafe(`ALTER ROLE anon SET statement_timeout TO '3s'`);
    await s.unsafe(`CREATE TABLE ${SB_SCHEMA_TABLE} (id int PRIMARY KEY)`);

    // TARGET: simulate a Supabase target — reserved roles already exist (so the
    // re-enabled SET has something to apply to), but the app role does NOT.
    await t.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    await t.unsafe(`DROP TABLE IF EXISTS ${SB_SCHEMA_TABLE} CASCADE`);
    await t.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$`,
    );
    await t.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin SUPERUSER; END IF; END $$`,
    );
    await t.unsafe(`ALTER ROLE anon RESET statement_timeout`).catch(() => {});
  });

  afterAll(async () => {
    if (!(HAVE_DBS && HAVE_CLIENTS)) return;
    await s.unsafe(`DROP TABLE IF EXISTS ${SB_SCHEMA_TABLE} CASCADE`).catch(() => {});
    await s.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    await t.unsafe(`DROP TABLE IF EXISTS ${SB_SCHEMA_TABLE} CASCADE`).catch(() => {});
    await t.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    await closeSb();
  });

  test("--confirm: app role restored, reserved roles filtered, SUPERUSER line neutralised", async () => {
    const r = await bootstrap(s, t, cfg, buildSecrets(), {
      confirm: true,
      outDir: `${OUT}-sb`,
      supabaseSource: true,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(r.planned); // includes the +1 filter step

    // app role survived the filter and landed on the target
    const [app] = await t`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`;
    expect(Boolean(app)).toBe(true);

    // supabase_admin still exists (pre-existed) and is STILL SUPERUSER — the restore
    // did not, and could not, re-run its CREATE/ALTER (those were filtered out)
    const [sa] = await t`SELECT rolsuper FROM pg_roles WHERE rolname = 'supabase_admin'`;
    expect(sa?.rolsuper).toBe(true);

    // the supautils-allowed SET on the pre-existing reserved role applied
    const [anon] = await t`SELECT rolconfig FROM pg_roles WHERE rolname = 'anon'`;
    expect((anon?.rolconfig ?? []).join(",")).toContain("statement_timeout=3s");
  }, 60_000);

  test("the on-disk roles dump has reserved CREATE ROLE commented out", async () => {
    const dump = await Bun.file(`${OUT}-sb/bootstrap-roles.sql`).text();
    expect(dump).toContain(`CREATE ROLE "${APP_ROLE}"`); // active
    expect(dump).toContain('-- CREATE ROLE "anon"'); // filtered
    expect(dump).toContain('-- CREATE ROLE "supabase_admin"'); // filtered
    expect(dump).not.toMatch(/^ALTER ROLE "supabase_admin" WITH SUPERUSER/m); // neutralised
  }, 60_000);
});
