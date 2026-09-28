import { type CheckItem, Checks } from "./schema.ts";

/**
 * Live readiness checks promoted from `doctor`'s inline control flow to data. Each is a
 * single-row SQL probe + an expected value; doctor runs them via `runCheck` and renders its
 * existing pass/fail strings, while `guide`'s future live walk runs the same items. Grounded
 * in the Postgres docs (docs.erfi.io) so `kb drift` can age-check them.
 *
 * Extraction is incremental and output-preserving: a check moves here only when doctor's
 * emitted strings stay byte-identical (see test/integration.test.ts).
 */
const RAW: CheckItem[] = [
  {
    id: "source.slot_absent",
    phase: "source-prep",
    severity: "warn",
    title: "stale replication slot",
    // existence probe — $1 is bound to the configured slot name at run time
    detect: { sql: "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1" },
    guidance:
      "A replication slot left from a prior run blocks a clean start and pins WAL on the source. " +
      "Drop it (pg_drop_replication_slot) or run `pgmig teardown` before re-replicating.",
    provenance: {
      source: "/docs/postgres/view-pg-replication-slots.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "source.publication_absent",
    phase: "source-prep",
    severity: "warn",
    title: "stale publication",
    detect: { sql: "SELECT 1 FROM pg_publication WHERE pubname = $1" },
    guidance:
      "A publication left from a prior run is reused as-is; if its table set differs from config, " +
      "drop it or run `pgmig teardown` first so the published set matches.",
    provenance: {
      source: "/docs/postgres/catalog-pg-publication.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "source.replica_identity",
    phase: "source-prep",
    severity: "fail",
    title: "replica identity",
    // per-table probe: $1 schema, $2 table. Multi-column result (relreplident + has_pk) is
    // evaluated by the caller, so no single `column`/`expect` here.
    detect: {
      sql:
        "SELECT c.relreplident, " +
        "EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relname = $2",
    },
    guidance:
      "A table that publishes UPDATE/DELETE must have a REPLICA IDENTITY (a primary key, a " +
      "unique index via REPLICA IDENTITY USING INDEX, or REPLICA IDENTITY FULL) — otherwise " +
      "those operations are disallowed and won't replicate.",
    provenance: {
      source: "/docs/postgres/sql-createpublication.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "target.schema_loaded",
    phase: "target-prep",
    severity: "fail",
    title: "target schema loaded",
    // per-table probe: $1 schema, $2 table. relkind distinguishes ordinary ('r') from
    // partitioned ('p') tables; absence means the table isn't there. Evaluated by the caller.
    detect: {
      sql:
        "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')",
    },
    guidance:
      "Logical replication does not carry DDL — the target schema must be created BEFORE replicate " +
      "(load it via your migration tool / pg_dump --schema-only / `pgmig bootstrap`). A missing " +
      "table blocks the initial copy; a partitioned table replicates but reconcile scans only the " +
      "partition root.",
    provenance: {
      source: "/docs/postgres/sql-createpublication.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "source.wal_level_logical",
    phase: "source-prep",
    severity: "fail",
    title: "source wal_level",
    detect: { sql: "SHOW wal_level", column: "wal_level" },
    expect: "logical",
    guidance:
      "Logical replication requires wal_level=logical on the SOURCE. Managed providers set it " +
      "via a parameter group/server parameter (see the provider guide); self-hosted: set " +
      "wal_level=logical in postgresql.conf. It can only be changed at server start, so restart " +
      "the source, then re-check.",
    provenance: {
      source: "/docs/postgres/runtime-config-wal.md",
      lastSynced: "2026-06-24",
    },
  },
];

/** Validated at module load — a malformed check crashes loudly, never silently skips. */
export const checks: readonly CheckItem[] = Checks.parse(RAW);

/** Look up a check by id (throws if absent — ids are compile-time-ish constants in doctor). */
export function check(id: string): CheckItem {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`unknown check id: ${id}`);
  return found;
}

export interface CheckResult {
  id: string;
  /** Did the probe return any row? The pass signal for existence checks. */
  present: boolean;
  /** The observed value from `detect.column`, or null (no column, or no row). */
  observed: string | null;
  /** Value checks: observed === expect. Existence checks (no expect): falls back to `present`. */
  ok: boolean;
}

/** Runs the probe, binding `params` to `$1`-style placeholders, and returns the result rows. */
export type QueryFn = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Execute one check: run `detect.sql` (binding `params`), then either read `detect.column`
 * from the first row and compare to `expect` (value check), or report whether any row came
 * back (existence check). IO is injected as `query` so the logic is unit-testable without a
 * live connection. doctor passes `(sql, p) => db.unsafe(sql, p)`.
 */
export async function runCheck(
  query: QueryFn,
  item: CheckItem,
  params?: readonly unknown[],
): Promise<CheckResult> {
  const rows = await query(item.detect.sql, params);
  const present = rows.length > 0;
  const raw = item.detect.column != null ? rows[0]?.[item.detect.column] : undefined;
  const observed = raw == null ? null : String(raw);
  const ok = item.expect != null ? observed === item.expect : present;
  return { id: item.id, present, observed, ok };
}

/**
 * Run a check's probe and return the first row (or null), for checks whose pass/fail predicate
 * spans multiple columns and so can't be expressed as `column`/`expect` — the caller evaluates
 * the row itself. The knowledge that still lives in the KB is the probe SQL + provenance; only
 * the row-shaped predicate stays in code.
 */
export async function runProbe<T = Record<string, unknown>>(
  query: QueryFn,
  item: CheckItem,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await query(item.detect.sql, params);
  return (rows[0] as T | undefined) ?? null;
}
