import { z } from "zod";

/** Where a knowledge item's guidance came from, and when it was last reconciled. Shared by
 *  every item type so `kb drift` can age-check them uniformly. */
export const Provenance = z.object({
  /** docs.erfi.io path (preferred — drift-checkable via docs_grep) or vendor URL. */
  source: z.string().min(1),
  /** ISO date (YYYY-MM-DD) the guidance was last reconciled against `source`. */
  lastSynced: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lastSynced must be YYYY-MM-DD"),
});
export type Provenance = z.infer<typeof Provenance>;

/** Migration phase an item belongs to (docs/GUIDED-MIGRATION.md §4, plus `target-prep`). */
export const Phase = z.enum([
  "preflight",
  "source-prep",
  "target-prep",
  "snapshot",
  "cdc",
  "reconcile",
  "cutover",
  "teardown",
]);
export type Phase = z.infer<typeof Phase>;

/**
 * A unit of migration knowledge, promoted from inline control flow to validated data.
 *
 * This is the PG-family **provider-hint** slice of the broader `KnowledgeItem` proposed in
 * docs/GUIDED-MIGRATION.md §4: enough structure to carry `provenance` (so the planned
 * `kb drift` / `kb sync` loop in §6 can re-check the cited source) without the cross-engine
 * `phase` / `appliesTo{source,target}` fields the heterogeneous data plane (HETEROGENEOUS.md)
 * will add. Until then, a provider hint is keyed by `(provider, role)` — which managed
 * Postgres the connection points at, and whether it is the migration source or target.
 *
 * `severity` / `klass` are full enums (not the `info` / `informed` the current data happens
 * to use) so heterogeneous items reuse this schema rather than forcing a migration. See
 * docs/GUIDED-MIGRATION.md §8, §10.1.
 */
export const ProviderHintItem = z.object({
  /** Stable id, e.g. "rds-postgres.enable_logical_replication". */
  id: z.string().min(1),
  /** Managed-Postgres provider this guidance applies to (mirrors db.ts `PgProvider`). */
  provider: z.enum([
    "supabase",
    "rds-postgres",
    "aurora-postgres",
    "neon",
    "planetscale-postgres",
    "azure-postgres",
    "generic",
  ]),
  /** Whether the guidance applies when this provider is the migration source or target. */
  role: z.enum(["source", "target"]),
  /** fail gates a phase; warn/info are advisory. Provider hints are all `info` today. */
  severity: z.enum(["fail", "warn", "info"]),
  /** auto applies it; assisted/guided draft-then-ratify; informed prints + acks. */
  klass: z.enum(["auto", "assisted", "guided", "informed"]),
  /** The exact remediation text doctor prints (kept verbatim — tests assert substrings). */
  guidance: z.string().min(1),
  provenance: Provenance,
});
export type ProviderHintItem = z.infer<typeof ProviderHintItem>;

/** A validated list of provider-hint knowledge items. */
export const ProviderHints = z.array(ProviderHintItem);

/**
 * A live readiness check, promoted from doctor's inline control flow to data: a SQL probe
 * plus phase / severity / remediation / provenance metadata. Three probe shapes are
 * supported, by how the result is judged:
 *   - value:     `detect.column` + `expect` — the column must equal `expect` (e.g. wal_level)
 *   - existence: neither — the caller reads whether any row came back (e.g. stale slot)
 *   - multi-col: neither, run via `runProbe` — the caller evaluates the raw row (replica identity)
 * doctor executes these against a connection (keeping its existing render strings); `guide`'s
 * future live walk runs the same items. docs/GUIDED-MIGRATION.md §4, §10.1.
 */
export const CheckItem = z.object({
  /** Stable id, e.g. "source.wal_level_logical". */
  id: z.string().min(1),
  phase: Phase,
  /** fail gates the phase; warn/info are advisory. */
  severity: z.enum(["fail", "warn", "info"]),
  /** Short human label, e.g. "source wal_level". */
  title: z.string().min(1),
  /** A SQL probe. `column` names the observed value (value checks); omit it for existence
   *  checks, where the caller reads `present` (did the probe return a row?). `$1`-style
   *  placeholders are bound to params supplied at run time (e.g. a config slot/publication name). */
  detect: z.object({
    sql: z.string().min(1),
    column: z.string().min(1).optional(),
  }),
  /** The string `detect.column` must equal to pass (value checks). Omit for existence checks. */
  expect: z.string().optional(),
  /** Verbose remediation (the `guide` surface; doctor keeps its own terse line). */
  guidance: z.string().min(1),
  provenance: Provenance,
});
export type CheckItem = z.infer<typeof CheckItem>;

/** A validated list of check items. */
export const Checks = z.array(CheckItem);

/** Heterogeneous source engines with a `pgmig guide <engine>` prep playbook (HETEROGENEOUS.md
 *  §5 source priority). PG-family sources use the native-pg ProviderHint catalog instead. */
export const SourcePrepEngine = z.enum(["mysql", "sqlserver"]);
export type SourcePrepEngine = z.infer<typeof SourcePrepEngine>;

/**
 * A source-prep knowledge item for a heterogeneous engine (MySQL / SQL Server), the
 * `KnowledgeItem` of docs/GUIDED-MIGRATION.md §4 scoped to the source-prep → cutover playbook
 * those engines need before a Debezium ReplicationEngine (HETEROGENEOUS.md) can stream them.
 *
 * Unlike `CheckItem` — whose Postgres `detect.sql` `doctor` runs live — these probes are
 * MySQL SQL / T-SQL. pgmig has no driver for those engines until the DebeziumEngine runtime
 * lands, so `detect`/`verify` are **documentation-grade today**: `pgmig guide <engine>`
 * prints them; nothing executes them yet. They are carried now (not invented later) so the
 * runtime inherits a ready, provenance-stamped probe set — the KB de-risks the engine.
 *
 * `klass` (auto/assisted/guided/informed) drives the future `guide` walk (§5): `auto` performs
 * + verifies, `assisted`/`guided` draft-then-ratify, `informed` prints + acks. Today only the
 * print path exists.
 */
/**
 * A single machine-checkable rule over the row(s) returned by a source-prep `assert.sql`. Kept as
 * serialisable data (not a closure) so it stays drift-checkable, unit-testable, and renderable.
 *   - `eq`        observed `rows[0][column]` must stringify-equal `value` (e.g. binlog_format=ROW)
 *   - `oneOf`     observed `rows[0][column]` must be one of `values`
 *   - `empty`     observed `rows[0][column]` must be empty/NULL (e.g. binlog_row_value_options)
 *   - `contains`  the WHOLE result set (all rows/cols, stringified) must contain every `all`
 *                 substring, case-insensitively (e.g. SHOW GRANTS must include both REPLICATION
 *                 privileges — the column name is dynamic, so we scan the lot)
 */
export const SourcePrepRule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("eq"),
    column: z.string().min(1),
    value: z.string(),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("oneOf"),
    column: z.string().min(1),
    values: z.array(z.string()).min(1),
    label: z.string().min(1),
  }),
  z.object({ kind: z.literal("empty"), column: z.string().min(1), label: z.string().min(1) }),
  z.object({
    kind: z.literal("contains"),
    all: z.array(z.string()).min(1),
    label: z.string().min(1),
  }),
]);
export type SourcePrepRule = z.infer<typeof SourcePrepRule>;

/** A live probe + the rules its result must satisfy. doctor runs this against a MySQL source. */
export const SourcePrepAssert = z.object({
  sql: z.string().min(1),
  rules: z.array(SourcePrepRule).min(1),
});
export type SourcePrepAssert = z.infer<typeof SourcePrepAssert>;

export const SourcePrepItem = z.object({
  /** Stable id, engine-prefixed, e.g. "mysql.binlog_enabled". */
  id: z.string().min(1),
  /** Heterogeneous source engine this item applies to (the `guide <engine>` key). */
  engine: SourcePrepEngine,
  phase: Phase,
  /** fail gates the phase; warn/info are advisory. */
  severity: z.enum(["fail", "warn", "info"]),
  /** auto applies it; assisted/guided draft-then-ratify; informed prints + acks. */
  klass: z.enum(["auto", "assisted", "guided", "informed"]),
  /** Short human label, e.g. "MySQL binlog enabled". */
  title: z.string().min(1),
  /** Verbatim remediation — exact SQL / my.cnf / console steps. Tests assert substrings. */
  guidance: z.string().min(1),
  /** Source-side probe (MySQL SQL / T-SQL) revealing current state. Documentation-grade today. */
  detect: z.object({ sql: z.string().min(1) }).optional(),
  /** Source-side verify probe + the human-readable expected result. Documentation-grade today. */
  verify: z.object({ sql: z.string().min(1), expect: z.string().min(1) }).optional(),
  /** Machine-checkable assertion `doctor` runs LIVE against the source (heterogeneous doctor
   *  path). When present, doctor executes `assert.sql` and evaluates every rule; items without
   *  it stay documentation-grade — doctor reports their `detect` reading or a manual pointer. */
  assert: SourcePrepAssert.optional(),
  provenance: Provenance,
});
export type SourcePrepItem = z.infer<typeof SourcePrepItem>;

/** A validated list of source-prep items. */
export const SourcePrepItems = z.array(SourcePrepItem);
