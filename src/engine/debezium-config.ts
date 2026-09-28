/**
 * Renders the Debezium Server `application.properties` for a MySQL → Postgres migration — the
 * fiddly half of the `debezium` engine's `replicate`, proven end-to-end by the spike at
 * spike/debezium-mysql/. This module is pure string generation (no IO, no container), so the
 * spike's hard-won config findings are encoded as executable, unit-tested code:
 *
 *   - finding #5: NEVER emit a `${...}` placeholder — Quarkus/SmallRye pre-expands it as its own
 *     config-expression syntax and NPEs. Topic→table naming is done with a RegexRouter SMT whose
 *     `$1` replacement has no braces. `assertNoConfigExpression` is a hard guard.
 *   - finding #6: `schema.evolution=none` in production — pgmig pre-creates the target from the
 *     `guided` schema-translation draft (GUIDED-MIGRATION.md §7); Debezium's `basic` auto-DDL
 *     would land the wrong types. `basic` is allowed only for the spike/smoke harness.
 *   - finding #7: no `ExtractNewRecordState` SMT — the JDBC sink ingests native change events.
 *
 * The output contains the target + source passwords in cleartext (it is mounted into the
 * container as a file); callers MUST keep it out of logs.
 */

import type { Config, Secrets } from "../config.ts";

/** A MySQL source the Debezium MySQL connector captures from (spike-proven). */
export interface DebeziumMySqlSource {
  flavour: "mysql";
  hostname: string;
  port: number;
  user: string;
  password: string;
  /** `SELECT @@server_id` — must be unique in the cluster (KB item mysql.binlog_enabled). */
  serverId: number;
  /** databases to capture, e.g. ["inventory"]. */
  databases: string[];
  /** schema-qualified tables, e.g. ["inventory.customers"]. */
  tables: string[];
}

/**
 * A SQL Server source the Debezium SQL Server connector captures from. Unlike MySQL's binlog, this
 * reads CDC change-tables (KB item sqlserver.cdc_enable), so the source must have CDC enabled at DB
 * + table scope first. Topics are `<prefix>.<database>.<schema>.<table>` (4 segments — one more
 * than MySQL's `<prefix>.<db>.<table>`), so the RegexRouter strips an extra segment.
 */
export interface DebeziumSqlServerSource {
  flavour: "sqlserver";
  hostname: string;
  port: number;
  user: string;
  password: string;
  /** CDC-enabled databases to capture, e.g. ["inventory"] (Debezium `database.names`). */
  databases: string[];
  /** schema-qualified tables, e.g. ["dbo.customers"] (the `dbo` is the SQL Server schema). */
  tables: string[];
  /** TLS to the source. Azure SQL requires true; on-prem/VM often false. Default false. */
  encrypt: boolean;
}

/** The heterogeneous source a Debezium plan captures from (discriminated on `flavour`). */
export type DebeziumSource = DebeziumMySqlSource | DebeziumSqlServerSource;

/** The Postgres/Supabase target the JDBC sink writes into. */
export interface DebeziumTarget {
  /** jdbc:postgresql://host:port/db */
  jdbcUrl: string;
  user: string;
  password: string;
}

export interface DebeziumPlan {
  /** Debezium topic prefix (logical server name). Topics are `<prefix>.<db>.<table>`. */
  topicPrefix: string;
  source: DebeziumSource;
  target: DebeziumTarget;
  /**
   * `none` (production): pgmig pre-creates the target schema from the guided draft.
   * `basic`: Debezium auto-creates/adds columns — spike/smoke only (finding #6).
   */
  schemaEvolution: "none" | "basic";
  /** Writable dir in the container for file-based offset + schema-history storage. */
  dataDir: string;
}

/** Throw if any value contains a `${...}` expression (spike finding #5 — would NPE the server). */
export function assertNoConfigExpression(properties: string): void {
  // match a literal `${` that opens an expression — the exact thing SmallRye pre-expands
  if (/\$\{/.test(properties)) {
    throw new Error(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${ is the guarded token
      "Debezium Server config contains a ${...} expression, which Quarkus/SmallRye pre-expands " +
        "and NPEs on (spike finding #5). Use a RegexRouter SMT with $1 (no braces) for topic→table " +
        "naming, and never emit a literal ${ in any value.",
    );
  }
}

/** Escape a string for use inside a Java regex (the RegexRouter `regex` value). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Decompose a DB connection URL into its parts (percent-decoding credentials). */
function parseDbUrl(
  url: string,
  defaultPort: number,
): { host: string; port: number; user: string; password: string; database: string } {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!u.hostname) throw new Error(`connection URL has no host: ${u.protocol}//…`);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : defaultPort,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

/**
 * Build a {@link DebeziumPlan} from real pgmig `Config` + `Secrets` — the bridge between the
 * control-plane config and the spike-proven renderer. Source connection comes from
 * `SOURCE_DB_URL` (a `mysql://` URL); only the structural bits (`serverId`, `databases`) live in
 * `config.source`. The JDBC sink target comes from `TARGET_DB_URL` (a `postgresql://` URL),
 * rewritten to the `jdbc:postgresql://host:port/db` form the Debezium JDBC sink expects.
 *
 * Narrows `config.source` to the heterogeneous engines (`mysql` / `sqlserver`): `postgres` uses
 * native logical replication (no Debezium) and is rejected here. The capture table-list reuses
 * `replication.tables` (for MySQL schema.table ≡ db.table; for SQL Server it is schema.table within
 * the `databases` catalog). Defaults `schemaEvolution` to `none` (production: pre-create the target
 * from the guided schema draft — finding #6); pass `basic` only for the spike/smoke harness.
 */
export function debeziumPlanFromConfig(
  cfg: Config,
  secrets: Secrets,
  opts: { dataDir?: string; schemaEvolution?: "none" | "basic" } = {},
): DebeziumPlan {
  const tgt = parseDbUrl(secrets.TARGET_DB_URL, 5432);
  const target: DebeziumTarget = {
    jdbcUrl: `jdbc:postgresql://${tgt.host}:${tgt.port}/${tgt.database}`,
    user: tgt.user,
    password: tgt.password,
  };
  const base = {
    // logical server name; the RegexRouter strips the topic prefix + db/schema segments.
    topicPrefix: cfg.replication.publication,
    target,
    schemaEvolution: opts.schemaEvolution ?? ("none" as const),
    dataDir: opts.dataDir ?? "/debezium/data",
  };

  if (cfg.source.engine === "mysql") {
    const src = parseDbUrl(secrets.SOURCE_DB_URL, 3306);
    return {
      ...base,
      source: {
        flavour: "mysql",
        hostname: src.host,
        port: src.port,
        user: src.user,
        password: src.password,
        serverId: cfg.source.serverId,
        databases: cfg.source.databases,
        tables: cfg.replication.tables,
      },
    };
  }
  if (cfg.source.engine === "sqlserver") {
    const src = parseDbUrl(secrets.SOURCE_DB_URL, 1433);
    // `?encrypt=true` in SOURCE_DB_URL flips TLS on (required for Azure SQL).
    const encrypt = /[?&]encrypt=true\b/i.test(secrets.SOURCE_DB_URL);
    return {
      ...base,
      source: {
        flavour: "sqlserver",
        hostname: src.host,
        port: src.port,
        user: src.user,
        password: src.password,
        databases: cfg.source.databases,
        tables: cfg.replication.tables,
        encrypt,
      },
    };
  }
  throw new Error(
    `debeziumPlanFromConfig supports only heterogeneous sources; source.engine is '${cfg.source.engine}'. ` +
      "postgres uses native logical replication (no Debezium).",
  );
}

/**
 * Render the full `application.properties`. Deterministic line order (tests assert substrings).
 * The RegexRouter strips the `<prefix>.<db>.` topic prefix so each source table lands in a bare
 * target table name (e.g. `dbz.inventory.customers` → `customers`).
 */
export function renderDebeziumServerConfig(plan: DebeziumPlan): string {
  const { topicPrefix, source, target, schemaEvolution, dataDir } = plan;
  if (source.tables.length === 0) throw new Error("Debezium plan has no source tables");
  if (source.databases.length === 0) throw new Error("Debezium plan has no source databases");

  const { sourceLines, routeRegex } = renderSourceSection(source, topicPrefix, dataDir);

  const lines = [
    `# Rendered by pgmig — Debezium Server ${source.flavour} → Postgres (no Kafka). DO NOT log: contains secrets.`,
    "",
    ...sourceLines,
    "",
    "# ── sink: JDBC straight into Postgres ──",
    "debezium.sink.type=jdbc",
    `debezium.sink.jdbc.connection.url=${target.jdbcUrl}`,
    `debezium.sink.jdbc.connection.username=${target.user}`,
    `debezium.sink.jdbc.connection.password=${target.password}`,
    "debezium.sink.jdbc.insert.mode=upsert",
    "debezium.sink.jdbc.primary.key.mode=record_key",
    "debezium.sink.jdbc.delete.enabled=true",
    `debezium.sink.jdbc.schema.evolution=${schemaEvolution}`,
    "",
    "# ── topic→table naming via RegexRouter ($1 replacement, never a brace-expression — finding #5) ──",
    "debezium.transforms=route",
    "debezium.transforms.route.type=org.apache.kafka.connect.transforms.RegexRouter",
    `debezium.transforms.route.regex=${routeRegex}`,
    "debezium.transforms.route.replacement=$1",
    "",
    "quarkus.http.port=8080",
    "",
  ];
  const out = lines.join("\n");
  assertNoConfigExpression(out);
  return out;
}

/**
 * Render the connector-specific source block + the RegexRouter regex, forked by source flavour.
 * MySQL: binlog connector, `database.include.list`, topics `<prefix>.<db>.<table>` (3 segments).
 * SQL Server: CDC connector, `database.names`, topics `<prefix>.<db>.<schema>.<table>` (4 segments
 * — the regex strips one more leading segment so rows still land under the bare table name).
 */
function renderSourceSection(
  source: DebeziumSource,
  topicPrefix: string,
  dataDir: string,
): { sourceLines: string[]; routeRegex: string } {
  const prefix = escapeRegex(topicPrefix);
  const history = [
    "debezium.source.schema.history.internal=io.debezium.storage.file.history.FileSchemaHistory",
    `debezium.source.schema.history.internal.file.filename=${dataDir}/schema_history.dat`,
  ];
  const offsets = [
    `debezium.source.offset.storage.file.filename=${dataDir}/offsets.dat`,
    "debezium.source.offset.flush.interval.ms=0",
  ];

  if (source.flavour === "mysql") {
    return {
      // `<prefix>.<db>.<table>` → keep only the final segment. $1 has no braces (finding #5).
      routeRegex: `${prefix}\\.[^.]+\\.(.*)`,
      sourceLines: [
        "# ── source: MySQL connector ──",
        "debezium.source.connector.class=io.debezium.connector.mysql.MySqlConnector",
        `debezium.source.topic.prefix=${topicPrefix}`,
        `debezium.source.database.hostname=${source.hostname}`,
        `debezium.source.database.port=${source.port}`,
        `debezium.source.database.user=${source.user}`,
        `debezium.source.database.password=${source.password}`,
        `debezium.source.database.server.id=${source.serverId}`,
        `debezium.source.database.include.list=${source.databases.join(",")}`,
        `debezium.source.table.include.list=${source.tables.join(",")}`,
        ...offsets,
        ...history,
      ],
    };
  }

  // sqlserver: CDC change-tables. database.names (not include.list); 4-segment topics.
  return {
    routeRegex: `${prefix}\\.[^.]+\\.[^.]+\\.(.*)`,
    sourceLines: [
      "# ── source: SQL Server connector (CDC change-tables) ──",
      "debezium.source.connector.class=io.debezium.connector.sqlserver.SqlServerConnector",
      `debezium.source.topic.prefix=${topicPrefix}`,
      `debezium.source.database.hostname=${source.hostname}`,
      `debezium.source.database.port=${source.port}`,
      `debezium.source.database.user=${source.user}`,
      `debezium.source.database.password=${source.password}`,
      `debezium.source.database.names=${source.databases.join(",")}`,
      `debezium.source.database.encrypt=${source.encrypt}`,
      `debezium.source.table.include.list=${source.tables.join(",")}`,
      ...offsets,
      ...history,
    ],
  };
}
