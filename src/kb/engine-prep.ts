import { log } from "../log.ts";
import {
  type Phase,
  type SourcePrepEngine,
  type SourcePrepItem,
  SourcePrepItems,
} from "./schema.ts";

/**
 * Source-prep playbooks for the heterogeneous engines (HETEROGENEOUS.md §5 priority order:
 * MySQL first, then SQL Server / Azure SQL). Each item is the §7 / §7b worked playbook
 * promoted to validated data: what an operator must do to a MySQL / SQL Server source before a
 * Debezium ReplicationEngine can stream it into Postgres/Supabase.
 *
 * `detect`/`verify` SQL is source-engine SQL (MySQL / T-SQL) and is documentation-grade today
 * — `pgmig guide <engine>` prints these; nothing executes them until the DebeziumEngine
 * runtime ships a driver. Provenance is the Debezium connector reference + vendor docs (the
 * authoritative CDC-out-of-engine source), so `kb drift` can age-check them like every other
 * KB item.
 */
const MYSQL: SourcePrepItem[] = [
  {
    id: "mysql.user_grants",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL CDC user grants",
    guidance:
      "Create a dedicated CDC user with the minimum grants the Debezium connector needs:\n" +
      "  CREATE USER 'pgmig'@'%' IDENTIFIED BY '<pw>';\n" +
      "  GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT\n" +
      "    ON *.* TO 'pgmig'@'%';\n" +
      "  FLUSH PRIVILEGES;",
    detect: { sql: "SHOW GRANTS FOR CURRENT_USER" },
    verify: {
      sql: "SHOW GRANTS FOR CURRENT_USER",
      expect: "includes REPLICATION SLAVE + REPLICATION CLIENT",
    },
    assert: {
      sql: "SHOW GRANTS FOR CURRENT_USER",
      rules: [
        {
          kind: "contains",
          all: ["REPLICATION SLAVE", "REPLICATION CLIENT"],
          label: "REPLICATION SLAVE + REPLICATION CLIENT granted",
        },
      ],
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_enabled",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL binlog enabled (ROW + FULL)",
    guidance:
      "Enable row-based binary logging (my.cnf, requires a server restart):\n" +
      "  server-id        = <unique-id>   # SELECT @@server_id; must be unique in the cluster\n" +
      "  log_bin          = mysql-bin\n" +
      "  binlog_format    = ROW\n" +
      "  binlog_row_image = FULL",
    detect: { sql: "SELECT @@log_bin, @@binlog_format, @@binlog_row_image" },
    verify: {
      sql: "SELECT @@log_bin, @@binlog_format, @@binlog_row_image",
      expect: "1, ROW, FULL",
    },
    assert: {
      sql: "SELECT @@log_bin AS log_bin, @@binlog_format AS binlog_format, @@binlog_row_image AS binlog_row_image",
      rules: [
        { kind: "eq", column: "log_bin", value: "1", label: "log_bin enabled" },
        { kind: "eq", column: "binlog_format", value: "ROW", label: "binlog_format=ROW" },
        { kind: "eq", column: "binlog_row_image", value: "FULL", label: "binlog_row_image=FULL" },
      ],
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.gtid_mode",
    engine: "mysql",
    phase: "source-prep",
    severity: "warn",
    klass: "assisted",
    title: "MySQL GTID mode",
    guidance:
      "GTIDs let the connector fail over to a replica and enable read-only incremental " +
      "snapshots:\n" +
      "  SET @@GLOBAL.enforce_gtid_consistency = ON;\n" +
      "  SET @@GLOBAL.gtid_mode = ON;   -- on a live server, ramp OFF→OFF_PERMISSIVE→ON_PERMISSIVE→ON",
    detect: { sql: "SELECT @@gtid_mode, @@enforce_gtid_consistency" },
    verify: { sql: "SELECT @@gtid_mode, @@enforce_gtid_consistency", expect: "ON, ON" },
    assert: {
      sql: "SELECT @@gtid_mode AS gtid_mode, @@enforce_gtid_consistency AS enforce_gtid_consistency",
      rules: [
        { kind: "eq", column: "gtid_mode", value: "ON", label: "gtid_mode=ON" },
        {
          kind: "eq",
          column: "enforce_gtid_consistency",
          value: "ON",
          label: "enforce_gtid_consistency=ON",
        },
      ],
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_retention",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL binlog retention",
    guidance:
      "Binlogs must survive long enough to cover the snapshot + catch-up window.\n" +
      "  Self-hosted: set binlog_expire_logs_seconds ≥ expected snapshot duration.\n" +
      "  RDS / Aurora MySQL: automated backups must be ON (binlog requires them), then\n" +
      "    CALL mysql.rds_set_configuration('binlog retention hours', 168);",
    detect: { sql: "SELECT @@binlog_expire_logs_seconds" },
    verify: {
      sql: "SELECT @@binlog_expire_logs_seconds   -- or CALL mysql.rds_show_configuration (RDS)",
      expect: "≥ expected snapshot duration",
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_row_value_options",
    engine: "mysql",
    phase: "source-prep",
    severity: "warn",
    klass: "assisted",
    title: "MySQL binlog_row_value_options empty",
    guidance:
      "binlog_row_value_options must be empty, not PARTIAL_JSON — otherwise the connector " +
      "cannot see full JSON column changes.",
    detect: { sql: "SELECT @@binlog_row_value_options" },
    verify: { sql: "SELECT @@binlog_row_value_options", expect: "'' (empty)" },
    assert: {
      sql: "SELECT @@binlog_row_value_options AS binlog_row_value_options",
      rules: [
        {
          kind: "empty",
          column: "binlog_row_value_options",
          label: "binlog_row_value_options empty (not PARTIAL_JSON)",
        },
      ],
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.schema_translation",
    engine: "mysql",
    phase: "snapshot",
    severity: "fail",
    klass: "guided",
    title: "MySQL → Postgres schema translation",
    guidance:
      "Draft target Postgres DDL from the MySQL information_schema and ratify the type " +
      "decisions a human must make (defaults are the documented Debezium mappings):\n" +
      "  TINYINT(1)     → boolean (Debezium converter) — but 0–127 storage should stay smallint; ASK\n" +
      "  UNSIGNED INT   → bigint (widen);  UNSIGNED BIGINT → numeric\n" +
      "  ENUM / SET     → text + optional CHECK; flag for review\n" +
      "  zero-dates     → NULL (Debezium zero-date fallback); confirm per column\n" +
      "  DATETIME/TIMESTAMP → timestamptz with the source session tz pinned\n" +
      "  DECIMAL        → numeric(p,s) preserved; warn on decimal.handling.mode rounding\n" +
      "Run `pgmig translate`: it never auto-applies — it writes <out-dir>/target-schema.sql + " +
      "target-schema.decisions.json (out-dir defaults to ledger/), records each decision, and " +
      "cutover refuses to run until you review + `pgmig translate --sign-off`.",
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.identity_resync",
    engine: "mysql",
    phase: "cutover",
    severity: "fail",
    klass: "auto",
    title: "MySQL AUTO_INCREMENT → Postgres identity resync",
    guidance:
      "AUTO_INCREMENT values do not replicate. After CDC catch-up, set each Postgres " +
      "IDENTITY/sequence to MAX(pk)+1 before traffic flips (the heterogeneous analogue of the " +
      "native sequence-resync in cutover).",
    verify: {
      sql: "SELECT last_value FROM pg_sequences   -- target",
      expect: "last_value ≥ max(pk) per mapped table",
    },
    provenance: {
      // the remediation is a Postgres setval on the target identity, same as native cutover
      source: "/docs/postgres/view-pg-sequences.md",
      lastSynced: "2026-06-24",
    },
  },
];

/**
 * SQL Server / Azure SQL (HETEROGENEOUS.md §6, GUIDED-MIGRATION.md §7b) — the harder second
 * engine: capture is via SQL Server CDC change-tables (read by the Debezium SQL Server
 * connector), not a binlog, so source-prep must enable CDC first; and T-SQL → PL/pgSQL is a
 * larger rewrite than MySQL's, so the schema-translation gate carries more weight. The
 * preflight `flavour` item is also the customer-discovery questionnaire's first question.
 */
const SQLSERVER: SourcePrepItem[] = [
  {
    id: "sqlserver.flavour",
    engine: "sqlserver",
    phase: "preflight",
    severity: "fail",
    klass: "informed",
    title: "SQL Server flavour (CDC + reachability differ)",
    guidance:
      "Azure SQL Database (PaaS), Azure SQL Managed Instance, and SQL Server on a VM differ in " +
      "CDC availability and network reachability for the capture tool. Identify which before " +
      "anything else — the connector config and health checks fork on it.",
    detect: {
      sql: "SELECT SERVERPROPERTY('EngineEdition')   -- 5=Azure SQL DB, 8=Managed Instance, 3=Enterprise (VM/on-prem)",
    },
    verify: {
      sql: "SELECT SERVERPROPERTY('EngineEdition')",
      expect: "5 (Azure SQL DB) | 8 (Managed Instance) | 3 (VM/on-prem)",
    },
    assert: {
      sql: "SELECT CAST(SERVERPROPERTY('EngineEdition') AS varchar(8)) AS edition",
      rules: [
        {
          kind: "oneOf",
          column: "edition",
          values: ["2", "3", "5", "8"],
          label:
            "EngineEdition is CDC-capable (2 Standard | 3 Enterprise/Dev | 5 Azure SQL DB | 8 Managed Instance; NOT 1 Personal / 4 Express)",
        },
      ],
    },
    provenance: {
      source:
        "https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "sqlserver.azure_tier",
    engine: "sqlserver",
    phase: "source-prep",
    severity: "fail",
    klass: "informed",
    title: "Azure SQL Database tier supports CDC",
    guidance:
      "Azure SQL Database CDC needs any vCore tier (GeneralPurpose / BusinessCritical / " +
      "Hyperscale) or DTU S3+. Basic / S0 / S1 / S2 canNOT be a CDC source, so the migration must " +
      "fail here rather than at connector start. Scale the source up before migrating. N/A for " +
      "non-Azure-SQL-DB sources (Managed Instance and VM/on-prem all support CDC regardless).",
    detect: {
      sql: "SELECT SERVERPROPERTY('EngineEdition') AS engine_edition, DATABASEPROPERTYEX(DB_NAME(),'ServiceObjective') AS service_objective",
    },
    verify: {
      sql: "SELECT DATABASEPROPERTYEX(DB_NAME(),'ServiceObjective')   -- Azure SQL DB only",
      expect: "any vCore SLO, or DTU S3+ (NOT Basic/S0/S1/S2)",
    },
    assert: {
      // EngineEdition 5 = Azure SQL DB; the tier gate is N/A on any other edition (MI/VM/on-prem).
      // DATABASEPROPERTYEX(...,'ServiceObjective') is a built-in on every edition, so this compiles
      // on box SQL Server too (unlike sys.database_service_objectives, which is Azure-only).
      sql:
        "SELECT CASE " +
        "WHEN CAST(SERVERPROPERTY('EngineEdition') AS int) <> 5 THEN 'ok' " +
        "WHEN CAST(DATABASEPROPERTYEX(DB_NAME(),'ServiceObjective') AS varchar(128)) IN ('Basic','S0','S1','S2') THEN 'blocked' " +
        "ELSE 'ok' END AS tier_ok",
      rules: [
        {
          kind: "eq",
          column: "tier_ok",
          value: "ok",
          label: "Azure SQL DB tier is CDC-capable (vCore any, or DTU S3+; not Basic/S0/S1/S2)",
        },
      ],
    },
    provenance: {
      source:
        "https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview",
      lastSynced: "2026-07-01",
    },
  },
  {
    id: "sqlserver.cdc_enable",
    engine: "sqlserver",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "SQL Server CDC enabled (DB + per-table)",
    guidance:
      "Enable CDC at DB then table scope (needs db_owner):\n" +
      "  EXEC sys.sp_cdc_enable_db;\n" +
      "  EXEC sys.sp_cdc_enable_table @source_schema=N'dbo', @source_name=N'<table>', @role_name=NULL;\n" +
      "Azure SQL Database tier gate: CDC needs any vCore tier, or DTU S3+ — Basic / S0 / S1 / S2 " +
      "are NOT supported. In Azure SQL DB an internal scheduler replaces SQL Server Agent " +
      "(capture ~every 20s, cleanup hourly). The cdc schema and cdc user must be free (CDC claims " +
      "them exclusively).",
    detect: { sql: "SELECT is_cdc_enabled FROM sys.databases WHERE name = DB_NAME()" },
    verify: { sql: "SELECT is_cdc_enabled FROM sys.databases WHERE name = DB_NAME()", expect: "1" },
    assert: {
      sql: "SELECT CAST(is_cdc_enabled AS varchar(1)) AS is_cdc_enabled FROM sys.databases WHERE name = DB_NAME()",
      rules: [
        { kind: "eq", column: "is_cdc_enabled", value: "1", label: "CDC enabled on the database" },
      ],
    },
    provenance: {
      source:
        "https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "sqlserver.cdc_retention",
    engine: "sqlserver",
    phase: "source-prep",
    severity: "warn",
    klass: "assisted",
    title: "SQL Server CDC retention",
    guidance:
      "Default CDC retention is 3 days — raise it to cover snapshot + catch-up. Note: enabling " +
      "CDC disables ADR aggressive log truncation (capture reads the transaction log), so watch " +
      "log-file growth during heavy write windows.",
    provenance: {
      source:
        "https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "sqlserver.change_tracking_alt",
    engine: "sqlserver",
    phase: "source-prep",
    severity: "info",
    klass: "informed",
    title: "Change Tracking is NOT a substitute for CDC",
    guidance:
      "Change Tracking is a lighter feature (row changed / not, no column history). It does not " +
      "give the before/after images CDC does; the Debezium SQL Server connector needs CDC, so " +
      "Change Tracking alone is insufficient for this path.",
    provenance: {
      source:
        "https://learn.microsoft.com/en-us/sql/relational-databases/track-changes/about-change-tracking-sql-server",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "sqlserver.schema_translation",
    engine: "sqlserver",
    phase: "snapshot",
    severity: "fail",
    klass: "guided",
    title: "T-SQL → Postgres schema translation (the long pole)",
    guidance:
      "Draft + human-ratify the target Postgres DDL. Type mappings:\n" +
      "  TINYINT → smallint (SQL Server TINYINT is 0–255, unsigned);  BIT → boolean\n" +
      "  MONEY / SMALLMONEY → numeric(19,4)\n" +
      "  DATETIME / DATETIME2 → timestamp (pin source tz);  DATETIMEOFFSET → timestamptz\n" +
      "  UNIQUEIDENTIFIER → uuid;  BINARY / VARBINARY → bytea\n" +
      "  NVARCHAR(MAX) / TEXT → text;  XML → xml or text\n" +
      "  HIERARCHYID / GEOGRAPHY / GEOMETRY / sql_variant → NO clean equivalent (design decision)\n" +
      "  IDENTITY column → GENERATED BY DEFAULT AS IDENTITY (PG 10+)\n" +
      "Two traps beyond type-by-type:\n" +
      "  Case sensitivity — SQL Server identifiers/collations are case-INsensitive, Postgres is " +
      "case-sensitive; decide per column (fold to lower, citext, or an ICU collation).\n" +
      "  T-SQL → PL/pgSQL — procedures/functions/triggers are REWRITTEN, not copied " +
      "(GETDATE()→now(), ISNULL→coalesce, TOP→LIMIT); validate drafts against Microsoft SSMA for " +
      "PostgreSQL / AWS SCT. App code carries SQL-Server-specific SQL too (app-side scope).",
    provenance: {
      source: "https://www.bladepipe.com/blog/tech_share/migrate_sqlserver_to_postgresql/",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "sqlserver.identity_resync",
    engine: "sqlserver",
    phase: "cutover",
    severity: "fail",
    klass: "auto",
    title: "SQL Server IDENTITY → Postgres identity resync",
    guidance:
      "Same as the MySQL/PG sequence resync: after CDC catch-up, set each Postgres IDENTITY to " +
      "MAX(pk)+1 before traffic flips.",
    verify: {
      sql: "SELECT last_value FROM pg_sequences   -- target",
      expect: "last_value ≥ max(pk) per mapped table",
    },
    provenance: {
      source: "/docs/postgres/view-pg-sequences.md",
      lastSynced: "2026-06-24",
    },
  },
];

/** Validated at module load — a malformed item crashes loudly, never silently skips. */
export const sourcePrep: readonly SourcePrepItem[] = SourcePrepItems.parse([
  ...MYSQL,
  ...SQLSERVER,
]);

/** All heterogeneous engines that have a source-prep playbook (drives CLI validation + help). */
export function preppableEngines(
  items: readonly SourcePrepItem[] = sourcePrep,
): SourcePrepEngine[] {
  const seen = new Set<SourcePrepEngine>();
  for (const i of items) seen.add(i.engine);
  return [...seen];
}

/** The source-prep items for one engine, in catalog order. */
export function sourcePrepFor(
  engine: SourcePrepEngine,
  items: readonly SourcePrepItem[] = sourcePrep,
): SourcePrepItem[] {
  return items.filter((i) => i.engine === engine);
}

/** Canonical migration order — the phases an engine playbook is grouped + walked in (§5). */
const PHASE_ORDER: Phase[] = [
  "preflight",
  "source-prep",
  "target-prep",
  "snapshot",
  "cdc",
  "reconcile",
  "cutover",
  "teardown",
];

export interface EngineGuidePhase {
  phase: Phase;
  items: SourcePrepItem[];
}

export interface EngineGuide {
  engine: SourcePrepEngine;
  /** Only phases with at least one item, in canonical migration order. */
  phases: EngineGuidePhase[];
  itemCount: number;
}

/** Assemble one engine's source-prep playbook, items grouped by phase in migration order. */
export function buildEngineGuide(
  engine: SourcePrepEngine,
  items: readonly SourcePrepItem[] = sourcePrep,
): EngineGuide {
  const mine = sourcePrepFor(engine, items);
  const phases: EngineGuidePhase[] = PHASE_ORDER.map((phase) => ({
    phase,
    items: mine.filter((i) => i.phase === phase),
  })).filter((p) => p.items.length > 0);
  return { engine, phases, itemCount: mine.length };
}

/** Human-readable render of an engine playbook via the structured logger (mirrors renderGuide). */
export function renderEngineGuide(g: EngineGuide): void {
  log.step(`guide: ${g.engine} source (${g.itemCount} item${g.itemCount === 1 ? "" : "s"})`);
  log.info(
    "heterogeneous source - these run via the Debezium ReplicationEngine; the guide is the " +
      "reference, detect/verify SQL is shown for the operator to run by hand",
  );
  for (const { phase, items } of g.phases) {
    log.info(`phase ${phase}:`);
    for (const i of items) {
      log.detail(`  [${i.severity}/${i.klass}] ${i.id} — ${i.title}`);
      for (const line of i.guidance.split("\n")) log.detail(`    ${line}`);
      if (i.detect) log.detail(`    detect: ${i.detect.sql}`);
      if (i.verify) log.detail(`    verify: ${i.verify.sql}  → expect ${i.verify.expect}`);
      log.detail(`    source: ${i.provenance.source} (synced ${i.provenance.lastSynced})`);
    }
  }
  log.info("schema-translation + cutover items gate the run — see docs/GUIDED-MIGRATION.md §7");
}
