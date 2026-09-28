/**
 * Cross-engine reconcile — the downgraded check the heterogeneous (Debezium) path uses in place
 * of the native `row::text` byte-hash (HETEROGENEOUS.md §2, item 7; §5, item 5).
 *
 * Native PG→PG reconcile compares `sum(hashtextextended(row::text))` per bucket: it works because
 * the SAME function over the SAME deterministic text encoding runs on both sides. None of that
 * survives a MySQL (or SQL Server) source — there is no `hashtextextended`, no `row::text`, and
 * the value encodings themselves differ (`TINYINT(1)`→`bool`, datetime formatting, unsigned ints,
 * zero-dates). A byte-exact hash is impossible, so the heterogeneous path drops to **count +
 * portable per-column aggregates** computed in each engine's own dialect and compared as scalars.
 *
 * This is a deliberately WEAKER check and the engine must say so loudly: it catches row-count
 * drift, numeric divergence (sum/min/max), null-pattern changes, and bulk text changes
 * (total char length), but NOT a length-preserving edit to a text value. It is trustworthy as a
 * gate only because the heterogeneous path's other controls compensate — Debezium replicates the
 * change stream faithfully and the cutover is fail-closed (HETEROGENEOUS.md §4, finding #2).
 *
 * Pure module (no IO): metric selection, per-engine SQL rendering, row parsing, and the diff are
 * all unit-tested; the DebeziumEngine only has to run the two rendered queries and feed the rows
 * back in — the same render-as-data / defer-the-IO split as `debezium-config.ts`.
 */

/** A source dialect this reconcile can render against. Postgres is the target side. */
export type AggEngine = "mysql" | "postgres" | "sqlserver";

/**
 * Portable aggregate metrics — chosen so the SAME value comes back from MySQL and Postgres for
 * identical data. `avg` is deliberately excluded (float rounding diverges across engines and
 * yields false mismatches; `sum` + `non_null` recover the mean if ever needed).
 */
export type AggMetric = "non_null" | "sum" | "min" | "max" | "char_len_sum";

/** Coarse type bucket that decides which metrics are meaningful + portable for a column. */
export type ColumnTypeCategory = "numeric" | "text" | "temporal" | "boolean" | "other";

export interface AggColumn {
  name: string;
  category: ColumnTypeCategory;
}

/**
 * The metrics computed for a column of a given category. Conservative by design — false mismatches
 * are worse than missed signal here, because this backs a fail-closed cutover:
 *  - numeric: full signal (non_null + sum + min + max).
 *  - text: non_null + total char length (a cheap content signal; misses length-preserving edits).
 *  - temporal: non_null only — min/max risk tz/format-driven false diffs across dialects.
 *  - boolean / other: non_null only.
 */
export function aggregatesFor(category: ColumnTypeCategory): AggMetric[] {
  switch (category) {
    case "numeric":
      return ["non_null", "sum", "min", "max"];
    case "text":
      return ["non_null", "char_len_sum"];
    default:
      return ["non_null"];
  }
}

/** Map a Postgres `information_schema.columns.data_type` (the target side) to a category. */
export function categorizePgType(dataType: string): ColumnTypeCategory {
  const t = dataType.toLowerCase();
  if (
    /^(smallint|integer|bigint|decimal|numeric|real|double precision|money)$/.test(t) ||
    t.startsWith("int") ||
    t === "serial" ||
    t === "bigserial"
  ) {
    return "numeric";
  }
  if (/(char|text|citext|name|uuid)/.test(t)) return "text";
  if (/(timestamp|date|time|interval)/.test(t)) return "temporal";
  if (t === "boolean" || t === "bool") return "boolean";
  return "other";
}

/**
 * Quote an identifier for the given engine, escaping an embedded quote char by doubling it (each
 * dialect's own escape convention). Column names here come from live catalog discovery
 * (`information_schema.columns` on the target), not just the ident-validated config, so an
 * embedded backtick/bracket/quote must not be able to break out of the quoted identifier.
 */
function quoteIdent(engine: AggEngine, ident: string): string {
  if (engine === "mysql") return `\`${ident.replace(/`/g, "``")}\``;
  if (engine === "sqlserver") return `[${ident.replace(/]/g, "]]")}]`;
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * The char-length function name per dialect. SQL Server's `LEN` strips trailing spaces (unlike
 * MySQL `CHAR_LENGTH` / Postgres `char_length`), so the text char_len_sum can show a benign diff
 * for space-padded `char(n)` columns — acceptable for this already-coarse downgraded check, and
 * the row-count + numeric signals are unaffected.
 */
function charLenFn(engine: AggEngine): string {
  if (engine === "mysql") return "CHAR_LENGTH";
  if (engine === "sqlserver") return "LEN";
  return "char_length";
}

/** Deterministic result alias for (column index, metric) — the parser maps it back. */
export function aggAlias(colIndex: number, metric: AggMetric): string {
  return `c${colIndex}_${metric}`;
}

/** Render the single-row aggregate query for one engine. Pure string generation. */
export function renderAggregateQuery(
  engine: AggEngine,
  schema: string,
  table: string,
  columns: AggColumn[],
): string {
  const q = (id: string) => quoteIdent(engine, id);
  const charLen = charLenFn(engine);
  const rel = `${q(schema)}.${q(table)}`;

  // `rowcount` is a RESERVED keyword in T-SQL (SET ROWCOUNT), so the alias must be quoted for
  // SQL Server; quoting it in every dialect keeps the parsed result key (`rowcount`) identical.
  const selects: string[] = [`count(*) AS ${q("rowcount")}`];
  columns.forEach((col, i) => {
    const c = q(col.name);
    for (const m of aggregatesFor(col.category)) {
      const alias = aggAlias(i, m);
      switch (m) {
        case "non_null":
          selects.push(`count(${c}) AS ${alias}`);
          break;
        case "sum":
          selects.push(`sum(${c}) AS ${alias}`);
          break;
        case "min":
          selects.push(`min(${c}) AS ${alias}`);
          break;
        case "max":
          selects.push(`max(${c}) AS ${alias}`);
          break;
        case "char_len_sum":
          selects.push(`sum(${charLen}(${c})) AS ${alias}`);
          break;
      }
    }
  });

  return `SELECT ${selects.join(", ")} FROM ${rel}`;
}

export interface ColumnAgg {
  column: string;
  /** metric → scalar as string (numbers/decimals stringified for stable comparison), or null. */
  metrics: Partial<Record<AggMetric, string | null>>;
}

export interface TableAggregates {
  rowCount: string;
  columns: ColumnAgg[];
}

/** Normalize a raw scalar from a driver (number | bigint | Decimal | Date | null) to string|null. */
function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Parse a single aggregate result row (keyed by the rendered aliases) into structured form. The
 * `columns` MUST be the same list (same order) passed to `renderAggregateQuery`.
 */
export function parseAggregateRow(
  row: Record<string, unknown>,
  columns: AggColumn[],
): TableAggregates {
  return {
    rowCount: scalar(row.rowcount) ?? "0",
    columns: columns.map((col, i) => {
      const metrics: Partial<Record<AggMetric, string | null>> = {};
      for (const m of aggregatesFor(col.category)) metrics[m] = scalar(row[aggAlias(i, m)]);
      return { column: col.name, metrics };
    }),
  };
}

export type AggMismatch =
  | { kind: "row_count"; source: string; target: string }
  | {
      kind: "column_metric";
      column: string;
      metric: AggMetric;
      source: string | null;
      target: string | null;
    }
  | { kind: "column_missing"; column: string; side: "source" | "target" };

/** Pure: which row-count / per-column-metric values diverge between source and target. */
export function diffAggregates(source: TableAggregates, target: TableAggregates): AggMismatch[] {
  const out: AggMismatch[] = [];
  if (source.rowCount !== target.rowCount) {
    out.push({ kind: "row_count", source: source.rowCount, target: target.rowCount });
  }
  const tByName = new Map(target.columns.map((c) => [c.column, c]));
  const sByName = new Map(source.columns.map((c) => [c.column, c]));
  for (const sCol of source.columns) {
    const tCol = tByName.get(sCol.column);
    if (!tCol) {
      out.push({ kind: "column_missing", column: sCol.column, side: "target" });
      continue;
    }
    for (const metric of Object.keys(sCol.metrics) as AggMetric[]) {
      const s = sCol.metrics[metric] ?? null;
      const t = tCol.metrics[metric] ?? null;
      if (s !== t)
        out.push({ kind: "column_metric", column: sCol.column, metric, source: s, target: t });
    }
  }
  for (const tCol of target.columns) {
    if (!sByName.has(tCol.column)) {
      out.push({ kind: "column_missing", column: tCol.column, side: "source" });
    }
  }
  return out;
}

export interface AggregateReport {
  table: string;
  sourceRows: string;
  targetRows: string;
  mismatches: AggMismatch[];
  match: boolean;
  /** Always present — the loud "this is a weaker check" caveat (HETEROGENEOUS.md §5 item 5). */
  caveat: string;
}

const DOWNGRADE_CAVEAT =
  "cross-engine reconcile: count + portable per-column aggregates, NOT a byte-exact row hash — " +
  "a length-preserving edit to a text value is invisible to this check (HETEROGENEOUS.md §2 item 7)";

/** Tie a source/target aggregate pair into a pass/fail report carrying the downgrade caveat. */
export function reconcileAggregateReport(
  table: string,
  source: TableAggregates,
  target: TableAggregates,
): AggregateReport {
  const mismatches = diffAggregates(source, target);
  return {
    table,
    sourceRows: source.rowCount,
    targetRows: target.rowCount,
    mismatches,
    match: mismatches.length === 0,
    caveat: DOWNGRADE_CAVEAT,
  };
}
