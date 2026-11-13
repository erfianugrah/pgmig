import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { assertDirectReplicationConn, qi, sourceConnUrl, withNoStatementTimeout } from "../db.ts";
import { log } from "../log.ts";

// H-4: quote every identifier that comes from user config so names with hyphens,
// uppercase letters, or reserved words don't produce invalid SQL.
// Qualified table name — schema and table quoted separately.
const qt = (schemaTable: string) => {
  const [s, t] = schemaTable.split(".");
  return `${qi(s ?? schemaTable)}.${qi(t ?? "")}`;
};

/**
 * Schemas whose tables belong to a Supabase service and change with that service's own
 * migrations. They never go in a publication: a column added on the source stalls every
 * table in the subscription until the target has it too, and a lab subscription that
 * included auth.users + auth.identities between two projects never finished its initial
 * copy (supabase-lab edge-resilience W09/W14/W15, 2026-08). Their rows move by dump/restore
 * instead (`cutover --with-auth-data` for auth, `pgmig storage` for Storage objects).
 * Deliberately narrower than SUPABASE_MANAGED_SCHEMAS: pgmq queues or extension tables
 * can be legitimate data to replicate.
 */
export const SERVICE_OWNED_SCHEMAS = [
  "auth",
  "realtime",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  "vault",
];

/** Pure: the configured tables that live in a service-owned schema. */
export function serviceOwnedTables(tables: string[]): string[] {
  const owned = new Set(SERVICE_OWNED_SCHEMAS);
  return tables.filter((t) => owned.has(t.split(".")[0] ?? ""));
}

/** Postgres names each table's initial-copy slot pg_<sub oid>_sync_<table oid>_<system id>. */
const SYNC_SLOT_RE = /^pg_\d+_sync_\d+_\d+$/;

/** Pure: is this a subscription's initial-copy (tablesync) slot? */
export const isSyncSlot = (name: string): boolean => SYNC_SLOT_RE.test(name);

/**
 * Pure: refusal message when the source holds another subscription's initial-copy slots,
 * else null. Two new projects subscribing at once can compute the SAME slot name (new
 * Supabase projects share a system_identifier and often the same OIDs), and the first to
 * finish drops the slot the other still needs: that target's table stays in state 'f',
 * row count equal, never streaming (supabase-lab replica-routing RR11, 2026-11-10).
 */
export function syncSlotConflict(slots: { slot_name: string; active: boolean }[]): string | null {
  const sync = slots.filter((s) => isSyncSlot(s.slot_name));
  if (sync.length === 0) return null;
  const list = sync.map((s) => `${s.slot_name} (${s.active ? "active" : "inactive"})`).join(", ");
  return (
    `the source holds initial-copy slots from another subscription: ${list}. A target ` +
    "copying at the same time can collide on the slot name and stop streaming without an " +
    "error, so start targets one at a time: wait until the other target shows every table " +
    "'r' in pg_subscription_rel (Postgres drops these slots then), and re-run replicate. If " +
    "no other target is copying, the slot is stale: check it stays inactive, then " +
    "SELECT pg_drop_replication_slot('<slot_name>'); on the source."
  );
}

/**
 * Stand up logical replication SOURCE -> TARGET using the native, Supabase-documented path:
 *   1. CREATE PUBLICATION (explicit table list - FOR ALL TABLES needs superuser)
 *   2. pg_create_logical_replication_slot (SQL function, postgres role)
 *   3. CREATE SUBSCRIPTION on target with copy_data=true, create_slot=false
 *
 * Idempotent-ish: skips objects that already exist. Use teardown() to reset.
 */
export async function replicate(
  source: Db,
  target: Db,
  cfg: Config,
  secrets: Secrets,
): Promise<void> {
  log.step("replicate: publication + slot + subscription");
  const { publication, slot, subscription, tables, copyData } = cfg.replication;

  // 0. service-owned tables never go in the publication on a Supabase-shaped source
  //    (supabase_admin exists on hosted and self-hosted Supabase alike).
  const owned = serviceOwnedTables(tables);
  if (owned.length > 0) {
    const [sb] = await source<{ yes: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') AS yes`;
    if (sb?.yes)
      throw new Error(
        `replication.tables lists service-owned tables: ${owned.join(", ")}. Their schemas ` +
          "belong to Supabase services and change with those services' migrations, so they " +
          "are not replicated. Remove them; copy auth rows inside the write stop with " +
          "`pgmig cutover --with-auth-data` and Storage objects with `pgmig storage`.",
      );
  }

  // 1. publication (empty, then add tables - avoids the FOR ALL TABLES superuser requirement)
  const [pub] = await source`SELECT 1 FROM pg_publication WHERE pubname = ${publication}`;
  if (pub) {
    log.warn(`publication ${publication} exists — leaving as-is`);
  } else {
    await source.unsafe(`CREATE PUBLICATION ${qi(publication)}`);
    log.ok(`created publication ${publication}`);
  }
  for (const table of tables) {
    const [schema, tbl] = table.split(".");
    const [present] = await source`
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = ${publication} AND schemaname = ${schema ?? ""} AND tablename = ${tbl ?? ""}`;
    if (present) {
      log.detail(`${table} already in publication`);
    } else {
      await source.unsafe(`ALTER PUBLICATION ${qi(publication)} ADD TABLE ${qt(table)}`);
      log.ok(`added ${table} to publication`);
    }
  }

  // 2. replication slot (pgoutput, the native logical decoding plugin)
  const [existingSlot] = await source`SELECT 1 FROM pg_replication_slots WHERE slot_name = ${slot}`;
  if (existingSlot) {
    log.warn(`slot ${slot} exists — leaving as-is`);
  } else {
    await source`SELECT pg_create_logical_replication_slot(${slot}, 'pgoutput')`;
    log.ok(`created replication slot ${slot}`);
  }

  // 3. subscription on target, bound to the pre-created slot
  const [existingSub] = await target`SELECT 1 FROM pg_subscription WHERE subname = ${subscription}`;
  if (existingSub) {
    // Subscription already exists. If the publication's table list changed since it
    // was created (e.g. you edited cfg.replication.tables and re-ran), the new tables
    // are NOT picked up automatically — the subscription must REFRESH PUBLICATION,
    // which starts an initial copy for the added tables (copy_data defaults true).
    // Safe and idempotent: a no-op when nothing changed.
    log.warn(`subscription ${subscription} already exists on target — refreshing publication`);
    try {
      await target.unsafe(`ALTER SUBSCRIPTION ${qi(subscription)} REFRESH PUBLICATION`);
      log.ok(`refreshed subscription ${subscription} (picks up any newly published tables)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`REFRESH PUBLICATION failed (${msg}) — run watch to check sync state`);
    }
    return;
  }

  // C-2: use the URL directly — PostgreSQL's CREATE SUBSCRIPTION CONNECTION accepts URL format,
  // avoiding the libpq keyword=value quoting problem (unquoted passwords with spaces break
  // tokenisation before any escaping layer can fix it). Percent-encoding in the URL is clean.
  const replUrl = sourceConnUrl(secrets);
  assertDirectReplicationConn(replUrl); // hard-stop: never issue a subscription over a pooler
  // statement_timeout=0: Supabase caps the postgres role at a 2 min global timeout, which
  // cancels any initial COPY longer than that (see withNoStatementTimeout).
  const conn = withNoStatementTimeout(replUrl).replaceAll("'", "''");

  // Another target's initial copy in flight on this source -> refuse (see syncSlotConflict).
  const slots = await source<{ slot_name: string; active: boolean }[]>`
    SELECT slot_name, active FROM pg_replication_slots`;
  const conflict = syncSlotConflict(slots);
  if (conflict) throw new Error(conflict);

  // CREATE SUBSCRIPTION is DDL, and new Supabase projects log DDL (log_statement=ddl), so
  // the CONNECTION string with its password lands in the target's Postgres logs. SET
  // log_statement = 'none' in the SAME session keeps it out (3 of 3 managed targets,
  // 2026-11-10; plain 17.11 2026-11-13). A reserved connection guarantees the same session;
  // CREATE SUBSCRIPTION cannot share a multi-statement string (implicit transaction).
  const session = await target.reserve();
  try {
    const quiet = await session.unsafe(`SET log_statement = 'none'`).then(
      () => true,
      (e: unknown) => {
        log.warn(
          `could not turn off statement logging for CREATE SUBSCRIPTION (${e instanceof Error ? e.message : String(e)}) ` +
            "- if the target logs DDL, its Postgres logs will hold the source password",
        );
        return false;
      },
    );
    await session.unsafe(
      `CREATE SUBSCRIPTION ${qi(subscription)}
         CONNECTION '${conn}'
         PUBLICATION ${qi(publication)}
         WITH (copy_data = ${copyData}, create_slot = false, slot_name = '${slot}')`,
    );
    if (quiet) await session.unsafe("RESET log_statement").catch(() => {});
  } finally {
    session.release();
  }
  log.ok(`created subscription ${subscription} (copy_data=${copyData})`);
  log.info("initial sync started — run `pgmig watch` to track it");
}
