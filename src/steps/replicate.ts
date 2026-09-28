import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { assertDirectReplicationConn, qi, sourceConnUrl } from "../db.ts";
import { log } from "../log.ts";

// H-4: quote every identifier that comes from user config so names with hyphens,
// uppercase letters, or reserved words don't produce invalid SQL.
// Qualified table name — schema and table quoted separately.
const qt = (schemaTable: string) => {
  const [s, t] = schemaTable.split(".");
  return `${qi(s ?? schemaTable)}.${qi(t ?? "")}`;
};

/**
 * Stand up logical replication SOURCE -> TARGET using the native, Supabase-documented path:
 *   1. CREATE PUBLICATION (explicit table list — FOR ALL TABLES needs superuser)
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

  // 1. publication (empty, then add tables — avoids the FOR ALL TABLES superuser requirement)
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
  const conn = replUrl.replaceAll("'", "''");
  await target.unsafe(
    `CREATE SUBSCRIPTION ${qi(subscription)}
       CONNECTION '${conn}'
       PUBLICATION ${qi(publication)}
       WITH (copy_data = ${copyData}, create_slot = false, slot_name = '${slot}')`,
  );
  log.ok(`created subscription ${subscription} (copy_data=${copyData})`);
  log.info("initial sync started — run `pgmig watch` to track it");
}
