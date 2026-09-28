# Heterogeneous data plane — Debezium behind a `ReplicationEngine` interface

> Status: implemented - the `translate`, `guide` and `kb` subcommands ship in the CLI (see `bun start --help`); this document is the design record and may lag the code. Companion to [`GUIDED-MIGRATION.md`](GUIDED-MIGRATION.md).
> That doc covers the **knowledge-and-guidance** plane (the ~70% that is checked, sourced,
> fail-closed prep playbooks). This doc covers the **data** plane (the ~30% that is a new
> replication engine) and the decision to **borrow** it rather than build it.

---

## 1. The asymmetry that makes this tractable

pgmig only ever migrates **into Postgres** (plain PG or Supabase). DMS-style tools are
priced and built as **any-to-any** — N source dialects × M target dialects, a quadratic
type/DDL matrix. pgmig's target is always one dialect, which collapses the worst half:

- **One target type system, one target DDL dialect.** No "MySQL→Oracle" mappings — only
  "→ Postgres."
- **The apply layer is off-the-shelf too.** When the sink is always Postgres, the Debezium
  **JDBC / Postgres sink connector** writes the rows; you don't hand-write the apply loop.

So both *capture* and *apply* are wrap-not-build. What pgmig actually owns is the
orchestration + the schema-translation drafting + reconcile — its existing wheelhouse.

## 2. What native logical replication gave us for free (and now doesn't)

PG→PG, one `CREATE SUBSCRIPTION ... copy_data=true` hands pgmig the entire data plane: a
consistent snapshot at an exact LSN, the CDC stream from that LSN with no gap/overlap, the
apply loop (the target walreceiver writes rows — pgmig never touches one), type fidelity,
and a deterministic `row::text` representation that makes byte-for-byte reconcile possible.

Heterogeneous loses all of that. You re-implement the free half once per source engine — or
you wrap an engine that already did. The eight pieces:

| # | Piece | Heterogeneous reality | Verdict |
|---|---|---|---|
| 1 | Source CDC capture | MySQL/Aurora-MySQL binlog (ROW); PlanetScale Vitess **VStream**; SQL Server / Azure SQL CDC change-tables; Oracle LogMiner/XStream | **wrap (Debezium)** |
| 2 | Normalized change envelope | op + before/after row image + source position (GTID/LSN) | **wrap (Debezium)** |
| 3 | Type mapping matrix | `TINYINT(1)`→bool, unsigned ints, ENUM/SET, zero-dates, fractional-second precision, generated columns, spatial; SQL Server `UNIQUEIDENTIFIER`→uuid, BIT, MONEY, DATETIME2, IDENTITY, ROWVERSION, collations | **wrap (Debezium) + `guided` review** — MySQL matrix DONE (`schema-translate.ts`); SQL Server matrix DONE (`sqlserver-schema-translate.ts`) |
| 4 | Schema/DDL translation | source DDL → Postgres DDL | **own — the long pole; see GUIDED-MIGRATION §7** |
| 5 | Consistent snapshot + position | MySQL consistent-snapshot txn + GTID; SQL Server snapshot isolation + LSN; then `COPY` | **wrap (Debezium snapshot)** |
| 6 | Apply loop into Postgres | ordering, idempotency, batching | **wrap (Debezium JDBC/PG sink)** |
| 7 | Cross-engine reconcile | `row::text` byte-hash dies → count + per-column aggregates | **own (downgraded)** |
| 8 | Engine-specific cutover gate | write-stop detection (`SHOW MASTER STATUS` / LSN poll), identity/auto-increment resync | **own (mirrors PG path)** |

Items 4 and 7 are the only ones pgmig owns. Everything else is Debezium.

## 3. The architecture: keep the control plane, plug the data plane

Define an internal `ReplicationEngine` interface. The state machine
(`doctor → watch → reconcile → cutover → teardown`) calls the interface; the step *names*
survive, the *implementations* fork by engine.

```ts
// src/engine/types.ts  (proposed)
interface ReplicationEngine {
  snapshot(opts): Promise<SnapshotResult>;     // initial bulk load + consistent position
  startCDC(opts): Promise<void>;               // begin streaming from that position
  lag(): Promise<LagReport>;                    // for `watch`
  reconcile(opts): Promise<ReconcileReport>;    // byte-hash (native) | count+aggregate (dbz)
  stopAtPosition(pos): Promise<void>;           // cutover write-stop gate
  teardown(): Promise<void>;
}
```

- **impl A — `native-pg`** (today): `CREATE SUBSCRIPTION`, `pg_subscription_rel`,
  `row::text` byte-hash. The first commit is extracting today's behaviour behind this
  interface with **zero behaviour change** — strictly good structure, useful even for the
  PG-family provider work.
- **impl B — `debezium`** (new): provisions a Debezium connector (embedded engine or
  Debezium Server — **no Kafka cluster required**) for MySQL binlog → Postgres sink;
  monitors lag via connector metrics; reconcile drops to count + aggregates.

How the existing commands fork:

| Step | `native-pg` (today) | `debezium` (heterogeneous) |
|---|---|---|
| `doctor` | wal_level, replica identity, subscribe grant | binlog ROW + server_id + GTID (MySQL) / CDC enabled (SQL Server); connector reachability; **schema-translation review gate** |
| `replicate` | `CREATE SUBSCRIPTION copy_data=true` | provision connector + snapshot |
| `watch` | poll `pg_subscription_rel` | poll connector lag / sink offset |
| `reconcile` | `row::text` byte-hash, 256 buckets | count + per-column aggregates |
| `cutover` | LSN write-stop gate + sequence resync | GTID/LSN write-stop gate + identity resync |
| `teardown` | drop sub/slot/publication | tear down connector + offsets |

## 4. Why Debezium, not hand-rolled, and not DMS-only

- **Not hand-rolled binlog/CDC parsers + a type matrix.** That is rebuilding Debezium/DMS:
  years of other people's bug reports, and it dilutes pgmig into something unrecognizable.
- **Not DMS-as-the-whole-tool.** AWS DMS does the data plane fine but knows nothing about the
  Supabase non-data plane (`auth.users` FK, storage, RLS, config-sync, advisor verify) and
  has **no fail-closed cutover gate**. pgmig's orchestration *is* the differentiator DMS
  lacks. Wrapping Debezium lets pgmig keep its control plane + Supabase muscle while
  borrowing the hard CDC machinery.

**Prior art validates the cutover gate.** Azure's own managed PostgreSQL Migration Service
implements exactly pgmig's fail-closed model: it runs CDC, then enters a
`Waiting for cutover trigger` state and instructs the operator to **stop writes to the
source and wait for `latency` → 0** before a manual cutover. That a first-party cloud
migration tool converges on the same write-stop-then-trigger gate is confirmation pgmig's
`cutover --confirm-writes-stopped` contract is the right shape, not an over-cautious quirk.
Source: `learn.microsoft.com/en-us/azure/postgresql/migrate/migration-service`.

The deciding question is *why* heterogeneous is wanted:

- "Consolidate a few MySQL apps onto Postgres a couple times a year" → AWS DMS /
  Debezium-as-a-service is cheaper than building anything. See `/docs/aws-dms/` on
  docs.erfi.io to evaluate.
- "Recurring product capability, and DMS's lack of a fail-closed cutover gate keeps burning
  us" → this design. The moat is the guided knowledge plane + Supabase cutover, not the CDC.

## 5. MVP scope

MySQL → Supabase, single source, behind the `ReplicationEngine` seam:

1. Refactor today's native-PG path behind the interface — **no behaviour change** (first
   commit; all existing tests green).
2. `engine: debezium` impl drives Debezium **embedded** for MySQL binlog → Postgres sink.
3. `doctor`/`guide` gain the MySQL source-prep items (see
   [`GUIDED-MIGRATION.md`](GUIDED-MIGRATION.md) §7) + the `guided` schema-translation gate.
4. Reuse the existing Supabase target wrappers wholesale.
5. `reconcile` drops to count + aggregates and **says so loudly**.

Effort: weeks, not days, dominated by schema-translation drafting (§7 of the guided spec)
and the reconcile downgrade. The CDC machinery itself is borrowed.

### Delivery vehicle — DECIDED (2026-06-24)

The spike (finding #1) left the delivery vehicle open: pin a 3.6 pre-release, wait for 3.6 GA,
or fall back to single-node Kafka Connect. Resolved by checking the actual gating dependency:

- `io.debezium:debezium-server-jdbc` on Maven Central — newest **`3.6.0.CR1`**, no `3.6.0.Final`
  (`maven-metadata.xml` lastUpdated 2026-06-23). The no-Kafka JDBC sink exists only from 3.6.0.Alpha2.
- quay.io/debezium/server images - on 2026-06-24 the 3.6 line was published only up to
  **`3.6.0.CR1`** (no CR1 or Final image); the newest GA `Final` overall is `3.5.2.Final`, which
  has **no** JDBC sink.

So **wait-for-GA is blocked** (3.6 GA unscheduled; CR1 jar only landed the day before) and the
**Kafka-Connect fallback reintroduces the Kafka dependency §1 rejected**. Decision: **pin the 3.6
pre-release**. The custom image layers the JDBC-sink jar onto the stock server image (finding #3),
so the sink jar must MATCH the server-core version in the base image. On 2026-06-24 the base image
topped out at Beta2 (no CR1 image), so both were pinned at Beta2. The pre-release risk is
acceptable because finding #2 already makes pgmig's reconcile + fail-closed cutover load-bearing
- the engine never trusts the sink's delivery guarantees, GA or not.

**RE-PIN (2026-07-01): Beta2 -> `3.6.0.CR1`.** `quay.io/debezium/server:3.6.0.CR1` has since
shipped and the matching `debezium-server-jdbc:3.6.0.CR1` jar is on Maven Central, so the matched
image+jar pair now exists at CR1 (one step closer to GA, no core/sink skew). `3.6.0.Final` is
still unscheduled, so this stays a pre-release. The pin lives as a typed constant in
[`src/engine/debezium-runtime.ts`](../src/engine/debezium-runtime.ts) (`DEBEZIUM_SERVER_VERSION`,
`DEBEZIUM_RUNTIME_GA=false`); re-pin CR1 -> Final only when a matching Final image+jar pair ships
and flip the GA flag.

### Runtime — IMPLEMENTED + harness-verified (2026-06-24)

The full `DebeziumEngine` lifecycle is built and proven end-to-end against real Debezium
3.6.0.CR1 + MySQL 8.2 + Postgres 16 by the Docker harness (`test/heterogeneous/`, PASS):

- **`replicate`** — render config → stage 0600 → `docker run` the pinned image → poll `/q/health`.
- **`reconcile`** — count + portable per-column aggregates on the MySQL source + PG target via the
  `mysql2` client, diffed by `reconcile-aggregate.ts`; the byte-exact-hash downgrade is logged loudly.
- **`watch`** — connector liveness via `/q/health` (the `debezium` check) + source/target row-count
  convergence. NB: this image ships **no** `/q/metrics` endpoint (404), so there is no HTTP lag
  number — health + count-convergence are the observable initial-sync-complete signals.
- **`cutover`** — translated-schema **sign-off gate** (`assertSchemaSignedOff`) → MySQL write-stop
  gate (`SHOW MASTER STATUS` position stability) → row-count drain → identity/sequence resync
  (no-op for explicit-PK schemas) → stop the container (the drop-subscription analogue).
- **`teardown`** — stop + `rm -f` the container + drop the offset volume, idempotent.

Two CLI surfaces complete the guided path (MVP §5 item 3, DELIVERED 2026-06-24):

- **`bun start translate`** — drafts target Postgres DDL from the MySQL `information_schema`, writes
  `<out-dir>/target-schema.sql` + `target-schema.decisions.json` (never auto-applies), `--apply`
  to load it, `--sign-off` to ratify. `cutover` refuses to run until the draft is signed off.

```bash
# Draft target Postgres DDL from MySQL information_schema (never auto-applies)
bun start translate --out-dir ledger

# Apply the drafted DDL to the TARGET
bun start translate --out-dir ledger --apply

# After human review: sign off the schema so cutover may proceed
bun start translate --out-dir ledger --sign-off
```
- **`bun start doctor`** — for a heterogeneous source, runs the MySQL engine-prep playbook **live**:
  the items carrying a machine-checkable `assert` (grants, binlog ROW+FULL, GTID,
  `binlog_row_value_options`) are judged pass/warn/fail against the real server; retention is a
  live reading to weigh by hand; the schema gate points at `translate`. Target checks drop to
  reachability + version + translated-tables-exist (no CREATE SUBSCRIPTION — Debezium is the sink).

The MySQL type matrix (item 3) is **complete** (`src/engine/schema-translate.ts`,
`test/schema-translate.test.ts`): the common matrix plus the edges — fractional-second precision
(`DATETIME(6)`→`timestamptz(6)`), generated columns (drafted as plain columns so the sink can write
captured values, then flagged with the source expression), SET (comma-joined `text`, or `text[]`/CHECK),
and the full spatial family (WKB `text`, or PostGIS). Anything unsettleable is drafted to a safe
default and flagged for review, never silently guessed.

Orchestration logic is unit-tested behind an injected IO + MySQL seam (`test/debezium-runtime-io.test.ts`);
the real Docker + Debezium behaviour is the harness's job. `mysql2` is the source-side client (the
resolved dependency decision; `connect()` builds Postgres clients only).

Source priority by demand: MySQL / Aurora-MySQL first, then SQL Server / Azure SQL (Debezium
SQL Server connector), then MongoDB (document→relational, a separate sub-project), Oracle
last.

## 6. SQL Server / Azure SQL notes (the second engine) — DELIVERED 2026-06-24

The SQL Server engine is implemented end-to-end and forks cleanly off `cfg.source.engine`:

- **client** — `src/engine/sqlserver.ts` (mssql-backed `SqlServerConn`, mirrors `mysql.ts`).
- **config** — `debezium-config.ts` renders the `SqlServerConnector` (CDC change-tables,
  `database.names`, `database.encrypt`, 4-segment RegexRouter) off the discriminated source union.
- **schema translation** — `src/engine/sqlserver-schema-translate.ts` (the §7b long pole: full
  T-SQL matrix incl. fractional-second precision cap at 6, DATETIME→timestamp tz review, the
  ROWVERSION trap, IDENTITY + COMPUTED overlays, spatial/`sql_variant` design decisions). Wired
  into `bun start translate`.
- **engine lifecycle** — `DebeziumEngine` replicate/watch/reconcile/cutover/teardown are
  engine-aware: bracket `[schema].[table]` quoting + `LEN`, the sqlserver reconcile dialect, and
  a **CDC-`max_lsn` write-stop gate** (`sys.fn_cdc_get_max_lsn`) in place of the binlog position.
- **doctor** — the engine-prep playbook runs LIVE for SQL Server (EngineEdition CDC-capable +
  `is_cdc_enabled` asserts).
- **harness** — `test/heterogeneous/harness-sqlserver.ts` + `docker-compose.sqlserver.yml`,
  **green end-to-end in CI** (the `heterogeneous` job) against real SQL Server 2022 (Developer,
  CDC) + Debezium 3.6.0.CR1 + Postgres 16.

The Debezium **SQL Server connector** captures from SQL Server **CDC change-tables**, not a
binlog — so the source-prep playbook (see [`GUIDED-MIGRATION.md`](GUIDED-MIGRATION.md) §7b)
must enable CDC first (`sys.sp_cdc_enable_db` + per-table `sys.sp_cdc_enable_table`). Engine
notes that shaped the `debezium` impl for this source:

- **Azure SQL Database tier gate** — CDC needs a vCore tier (any) or DTU **S3+**; Basic/S0/S1/S2
  can't be a source. **DELIVERED**: the `sqlserver.azure_tier` source-prep item (fail-severity)
  runs live in `doctor` and fails early on a blocked tier, before connector start. It reads
  `DATABASEPROPERTYEX(DB_NAME(),'ServiceObjective')` (a built-in on every edition, so it no-ops
  off Azure via the `EngineEdition <> 5` branch) rather than the Azure-only
  `sys.database_service_objectives` view.
- **Capture topology differs by flavour** — Azure SQL DB uses an internal CDC **scheduler**
  (no SQL Server Agent); MI and VM use Agent jobs. The connector config + health checks differ.
- **CDC retention is the watchdog input** — default 3-day cleanup; a stalled migration past
  retention loses change rows (the SQL Server analogue of Neon's 40h slot reaping and MySQL's
  binlog purge). **DELIVERED**: `watch` now arms a retention watchdog (`sourceRetentionSeconds`
  reads the CDC cleanup job's retention from `msdb.dbo.cdc_jobs`, or `@@binlog_expire_logs_seconds`
  for MySQL), warns at `watchdog.retentionWarnFraction` (default 0.8) of the window and hard-aborts
  at 1.0 (the CDC analogue of the WAL watchdog). Verdict logic is the pure, unit-tested
  `evaluateRetentionHeadroom` (test/retention-watchdog.test.ts); a probe failure degrades to a
  no-op rather than blocking the run.
- **Heavier schema translation** — T-SQL → PL/pgSQL is a larger rewrite than MySQL's, so the
  `guided` schema gate (§7b) carries more weight and SSMA/SCT cross-validation matters more.
- **`HIERARCHYID` / `GEOGRAPHY` / `GEOMETRY` / `sql_variant`** have no clean Postgres target —
  these are `fail`-severity design decisions, not silent coercions.
```
