import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema, type Secrets, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { runChaos } from "../src/rehearsal/chaos.ts";
import { cutover } from "../src/steps/cutover.ts";
import { doctor } from "../src/steps/doctor.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";

/**
 * LIVE integration tier. Opt-in: skipped unless TEST_SOURCE_DB_URL and
 * TEST_TARGET_DB_URL point at two THROWAWAY Postgres 15+ databases where the
 * source has wal_level=logical and the role can CREATE SUBSCRIPTION.
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16 -c wal_level=logical
 *   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=pw postgres:16
 *   TEST_SOURCE_DB_URL=postgresql://postgres:pw@localhost:5432/postgres \
 *   TEST_TARGET_DB_URL=postgresql://postgres:pw@localhost:5433/postgres bun test
 *
 * This is the only tier that proves the replication + reconcile SQL actually
 * works against a real engine, and that each fault is caught.
 */

const HAVE_DBS = Boolean(process.env.TEST_SOURCE_DB_URL && process.env.TEST_TARGET_DB_URL);
const d = HAVE_DBS ? describe : describe.skip;
const TABLE = "public.itest";
const TABLE2 = "public.itest2";
const FK_PARENT = "public.itest_fk_parent";
const FK_CHILD = "public.itest_fk_child";

function buildConfig(): Config {
  return ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: {
      tables: [TABLE],
      publication: "itest_pub",
      slot: "itest_slot",
      subscription: "itest_sub",
    },
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

async function createSchema(db: Db): Promise<void> {
  await db.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  // includes a STORED generated column to exercise the reconcile exclusion path.
  // seq_id + seq_id2 (bigserial) give the table TWO owned sequences so the cutover
  // resync path is exercised with N>1 (it must discover + setval EVERY sequence
  // owned by a replicated table, not just the first).
  await db.unsafe(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq_id bigserial,
    seq_id2 bigserial,
    content text,
    n int,
    g tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED
  )`);
}

const cfg = buildConfig();
const secrets = HAVE_DBS ? buildSecrets() : (null as unknown as Secrets);
let source: Db;
let target: Db;
let close: () => Promise<void>;

/** Full reset: tear down replication, recreate schema both sides, seed, replicate, sync. */
async function resetAndSync(rows: number): Promise<void> {
  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);
  await source.unsafe(
    `INSERT INTO ${TABLE} (content, n) SELECT 'row ' || g, g FROM generate_series(1, $1) g`,
    [rows],
  );
  await replicate(source, target, cfg, secrets);
  await watch(source, target, cfg);
}

d("live replication + reconciliation", () => {
  beforeAll(async () => {
    const c = connect(secrets);
    source = c.source;
    target = c.target;
    close = c.close;
    const [w] = await source`SHOW wal_level`;
    if (w?.wal_level !== "logical")
      throw new Error("TEST_SOURCE_DB_URL must have wal_level=logical");
  });

  afterAll(async () => {
    if (!HAVE_DBS) return;
    await teardown(source, target, cfg);
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`).catch(() => {});
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`).catch(() => {});
    for (const db of [source, target])
      await db.unsafe(`DROP TABLE IF EXISTS ${FK_CHILD}, ${FK_PARENT} CASCADE`).catch(() => {});
    await close();
  });

  test("happy path: identical source/target reconcile clean", async () => {
    await resetAndSync(200);
    expect(await reconcile(source, target, cfg)).toBe(true);
  }, 60_000);

  test("lose-row: a row dropped on target is caught", async () => {
    await resetAndSync(200);
    await runChaos({ source, target, arg: TABLE }, "lose-row");
    expect(await reconcile(source, target, cfg)).toBe(false);
  }, 60_000);

  test("corrupt-row: silent content drift on target is caught", async () => {
    await resetAndSync(200);
    await runChaos({ source, target, arg: TABLE }, "corrupt-row");
    expect(await reconcile(source, target, cfg)).toBe(false);
  }, 60_000);

  test("generated column is excluded — tsvector differences do not cause false mismatch", async () => {
    await resetAndSync(200);
    // The generated column (tsvector) is recomputed on the subscriber and is
    // excluded from the hash; a clean dataset must still reconcile true.
    expect(await reconcile(source, target, cfg)).toBe(true);
  }, 60_000);

  test("drop-replica-identity: preflight rejects a table with REPLICA IDENTITY NOTHING", async () => {
    await createSchema(source);
    await createSchema(target);
    await runChaos({ source, target, arg: TABLE }, "drop-replica-identity");
    await expect(preflight(source, target, cfg)).rejects.toThrow(); // L-14: was missing await
  }, 60_000);

  test("doctor: clean synced pair reports zero failures", async () => {
    await resetAndSync(50);
    const r = await doctor(cfg, secrets);
    expect(r.fail).toBe(0);
  }, 60_000);

  test("doctor: missing target schema is a failure", async () => {
    await teardown(source, target, cfg);
    await createSchema(source);
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    const r = await doctor(cfg, secrets);
    expect(r.fail).toBeGreaterThan(0);
  }, 60_000);

  test("cutover: EVERY owned sequence is resynced to the source value on the target", async () => {
    await resetAndSync(200);
    // Both source seqs advanced to 200 on insert; replicated rows carry literal
    // values so the TARGET sequences never advanced. Confirm the gap exists on both...
    const seqNames = [`${TABLE}_seq_id_seq`, `${TABLE}_seq_id2_seq`];
    for (const seqName of seqNames) {
      const [tBefore] = await target.unsafe(`SELECT last_value, is_called FROM ${seqName}`);
      expect(tBefore?.is_called === false || Number(tBefore?.last_value) < 200).toBe(true);
    }
    // ...then cutover (writes are stopped, lag drains) must setval BOTH forward.
    await cutover(source, target, cfg, { maxLagWaitSec: 30 });
    for (const seqName of seqNames) {
      const [s] = await source.unsafe(`SELECT last_value FROM ${seqName}`);
      const [t] = await target.unsafe(`SELECT last_value, is_called FROM ${seqName}`);
      expect(Number(t?.last_value)).toBe(Number(s?.last_value));
      expect(t?.is_called).toBe(true);
    }
  }, 60_000);

  test("subscriber skips FK checks: child rows arrive with the parent table empty on the target", async () => {
    const fkCfg = ConfigSchema.parse({
      ...cfg,
      replication: {
        tables: [FK_CHILD],
        publication: "itest_fk_pub",
        slot: "itest_fk_slot",
        subscription: "itest_fk_sub",
      },
      reconcile: { tables: [{ name: FK_CHILD }] },
    });
    await teardown(source, target, fkCfg);
    for (const db of [source, target]) {
      await db.unsafe(`DROP TABLE IF EXISTS ${FK_CHILD}, ${FK_PARENT} CASCADE`);
      await db.unsafe(`CREATE TABLE ${FK_PARENT} (id int PRIMARY KEY)`);
      await db.unsafe(
        `CREATE TABLE ${FK_CHILD} (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES ${FK_PARENT}(id) ON DELETE CASCADE)`,
      );
    }
    await source.unsafe(`INSERT INTO ${FK_PARENT} SELECT g FROM generate_series(1, 5) g`);
    await source.unsafe(`INSERT INTO ${FK_CHILD} SELECT g, g FROM generate_series(1, 5) g`);
    await replicate(source, target, fkCfg, secrets);
    await watch(source, target, fkCfg);
    const count = async (t: string) =>
      Number((await target.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]?.n);
    expect(await count(FK_PARENT)).toBe(0);
    expect(await count(FK_CHILD)).toBe(5); // initial copy
    await source.unsafe(`INSERT INTO ${FK_PARENT} VALUES (6)`);
    await source.unsafe(`INSERT INTO ${FK_CHILD} VALUES (6, 6)`);
    let n = 5;
    for (let i = 0; i < 30 && n < 6; i++) {
      n = await count(FK_CHILD);
      if (n < 6) await new Promise((res) => setTimeout(res, 500));
    }
    expect(n).toBe(6); // streamed
    // control: the same FK DOES reject a direct insert on the target
    await expect(target.unsafe(`INSERT INTO ${FK_CHILD} VALUES (99, 99)`)).rejects.toThrow(
      /foreign key/,
    );
    await teardown(source, target, fkCfg);
  }, 60_000);

  test("replicate refuses to start while another subscription's initial-copy slot is on the source", async () => {
    await teardown(source, target, cfg);
    const fake = "pg_99999_sync_1_1";
    await source`SELECT pg_create_logical_replication_slot(${fake}, 'pgoutput')`;
    try {
      await expect(replicate(source, target, cfg, secrets)).rejects.toThrow(
        /initial-copy slots from another subscription: pg_99999_sync_1_1/,
      );
      const [sub] =
        await target`SELECT 1 FROM pg_subscription WHERE subname = ${cfg.replication.subscription}`;
      expect(sub).toBeUndefined();
    } finally {
      await source`SELECT pg_drop_replication_slot(${fake})`;
      await teardown(source, target, cfg);
    }
  }, 60_000);

  test("replicate refuses service-owned tables on a Supabase-shaped source", async () => {
    const authCfg = ConfigSchema.parse({
      ...cfg,
      replication: { ...cfg.replication, tables: [TABLE, "auth.users"] },
    });
    await source.unsafe("CREATE ROLE supabase_admin NOLOGIN");
    try {
      await expect(replicate(source, target, authCfg, secrets)).rejects.toThrow(
        /service-owned tables: auth\.users/,
      );
    } finally {
      await source.unsafe("DROP ROLE supabase_admin");
    }
  }, 60_000);

  test("replicate: REFRESH PUBLICATION picks up a table added after the subscription", async () => {
    await resetAndSync(50);
    // A second table, created + published AFTER the subscription exists.
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
    await source.unsafe(`CREATE TABLE ${TABLE2} (id int PRIMARY KEY, v text)`);
    await target.unsafe(`CREATE TABLE ${TABLE2} (id int PRIMARY KEY, v text)`);
    await source.unsafe(`INSERT INTO ${TABLE2} SELECT g, 'v' || g FROM generate_series(1, 10) g`);
    await source.unsafe(`ALTER PUBLICATION ${cfg.replication.publication} ADD TABLE ${TABLE2}`);
    // Re-running replicate sees the existing subscription and issues REFRESH
    // PUBLICATION, which starts an initial copy for the newly published table.
    await replicate(source, target, cfg, secrets);
    // Poll until the new table's rows land on the target (tablesync is async).
    let copied = 0;
    for (let i = 0; i < 30 && copied < 10; i++) {
      const [r] = await target.unsafe(`SELECT count(*)::int AS n FROM ${TABLE2}`);
      copied = Number(r?.n ?? 0);
      if (copied < 10) await new Promise((res) => setTimeout(res, 500));
    }
    expect(copied).toBe(10);
  }, 60_000);

  // Last on purpose: reads the target's whole DDL log after every replicate above.
  test.if(process.env.TEST_TARGET_LOGS_DDL === "1")(
    "no subscription password in the target's DDL log (log_statement=ddl)",
    async () => {
      const [r] = await target.unsafe(`SELECT pg_read_file('log/postgresql.log') AS log`);
      const text = String(r?.log ?? "");
      expect(text).toContain(`CREATE TABLE ${FK_CHILD}`); // control: DDL IS being logged
      expect(text).not.toContain(":pw@");
      expect(text).not.toMatch(/CREATE SUBSCRIPTION/i);
    },
  );
});
