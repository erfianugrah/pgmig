# Guided migration — design for heterogeneous → Postgres / Supabase

> Status: implemented - the `translate`, `guide` and `kb` subcommands ship in the CLI (see `bun start --help`); this document is the design record and may lag the code. This document describes how pgmig extends from a
> PG→PG logical-replication orchestrator into a **guided, knowledge-bearing migration
> advisor** that subsumes the per-engine prep knowledge so the operator follows *one
> checked tool* instead of a dozen vendor-doc tabs.

For what pgmig does today (native PG→PG logical replication, the `doctor → watch →
reconcile → cutover` state machine), see [`RUNBOOK.md`](RUNBOOK.md) and
[`MIGRATION-SCOPE.md`](MIGRATION-SCOPE.md). This spec is additive.

---

## 1. The premise

pgmig's value was never "it runs the migration." It is "it has already absorbed every
gotcha so you don't relearn them at 2am from twelve browser tabs." The replication engine
is simply the part where that knowledge happens to be *executable*.

For homogeneous PG→PG, almost all of the knowledge is executable — native logical
replication does the snapshot + CDC + apply for us, so `doctor` can check `wal_level`,
replica identity, and grants, then `replicate` just issues `CREATE SUBSCRIPTION`.

For **heterogeneous → Postgres** (MySQL, SQL Server, …) most of the prep knowledge is
**not** executable by the tool — it lives in the source platform's config, requires the
operator's console / reboot / credentials, or needs human judgment (schema-type choices).
But it is still pgmig's job to **carry that knowledge, check it, and gate on it** — not
to hand you a link.

The split, quantified roughly:

- **~30%** of heterogeneous support is a new replication *engine* (capture + type-map +
  apply). That is **borrowed**, not built — see [`HETEROGENEOUS.md`](HETEROGENEOUS.md) (the
  Debezium-as-data-plane decision).
- **~70%** is a **knowledge-and-guidance engine**: checked, sourced, freshness-synced,
  fail-closed prep playbooks. That is the part nobody else ships and the part pgmig is
  already shaped like (`doctor`'s `ok/warn/fail` + remediation, `cutover`'s
  `--confirm-writes-stopped` gate).

This spec is the design of that knowledge-and-guidance engine.

---

## 2. A "guide" is a checked step, not prose

The failure mode of sparse online docs is that they are **inert**: they tell you to set
`binlog_row_image=FULL` and trust that you did. pgmig turns every piece of prep knowledge
into a **triplet**:

1. **detect** — observe the current state (`SHOW VARIABLES LIKE 'binlog_row_image'`).
2. **act-or-guide** — if the step is safe + automatable, do it and show what was done;
   otherwise emit the *exact* command / SQL / console path for **this** situation
   (this connection string, these tables, these missing extensions).
3. **verify** — re-check that the state is now correct, and **refuse to advance** until it
   is — or, for steps the tool genuinely cannot observe, require an explicit operator
   acknowledgement that is recorded in the run log.

The third leg is what no vendor doc gives you, and what pgmig already does in two places
today. Generalising it from a handful of hardcoded checks into a *knowledge base* of them
is the whole move.

---

## 3. The automation spectrum (threshold = safety, not effort)

Every prep step is classified, and the class decides behaviour. The bar for dropping from
`auto` toward `informed` is **safety / variability**, never "it's more work" — the
knowledge stays inside the tool at every level.

| Class | Meaning | pgmig behaviour |
|---|---|---|
| **auto** | safe, deterministic, idempotent, tool has the access | tool performs it, shows what it did, then `verify` |
| **assisted** | tool can generate the exact artifact but must not run it (needs your console / reboot / privileged creds) | emits copy-pasteable command + a `verify` that confirms you ran it |
| **guided** | variable / needs judgment (schema-type choices, charset, collation) | tool drafts a proposal, you review + edit, tool records your decision and `verify`s the result |
| **informed** | not observable by the tool at all (org policy, downtime window, vendor support ticket) | tool states the requirement + provenance, requires an explicit `ack` recorded in the run log to proceed |

> The operator's stated principle: *anything that deviates too much from "the tool can just
> do it" should still route through the guided tool rather than sparse docs.* That is
> exactly this table — even an `informed` step cites its source and is captured in the run
> log; it never degrades to "go read the MySQL manual."

---

## 4. The unit of knowledge

pgmig is zod-validated throughout, so a knowledge item is a validated record. A
`Playbook` is an ordered list of them, selected by `(sourceEngine, target, phase)`.

```ts
// src/kb/schema.ts  (proposed)
const KnowledgeItem = z.object({
  id: z.string(),                              // "mysql.binlog_row_image_full"
  appliesTo: z.object({
    source: z.enum(["postgres", "rds-postgres", "aurora-postgres", "neon",
                    "planetscale-postgres", "azure-postgres",
                    "mysql", "rds-mysql", "aurora-mysql", "sqlserver", "azure-sql"]),
    target: z.enum(["postgres", "supabase"]),
  }),
  phase: z.enum(["preflight", "source-prep", "snapshot", "cdc", "reconcile",
                 "cutover", "teardown"]),
  severity: z.enum(["fail", "warn", "info"]),
  klass: z.enum(["auto", "assisted", "guided", "informed"]),
  title: z.string(),
  detect: z.union([z.object({ sql: z.string() }), z.object({ fn: z.string() })]).optional(),
  guidance: z.string(),                        // exact command/SQL/console path, templated
  verify: z.union([z.object({ sql: z.string() }), z.object({ fn: z.string() })]).optional(),
  provenance: z.object({
    source: z.string(),                        // docs.erfi.io path OR vendor URL
    lastSynced: z.string(),                    // ISO date
    upstreamHash: z.string().optional(),       // sha256 of the cited section, for drift
  }),
});
```

This is `doctor`'s existing `ok / warn / fail` + remediation string, **promoted to data**
with a `verify` leg and a `provenance` stamp. Today that knowledge is welded into
TypeScript control flow in `src/steps/doctor.ts` and `src/steps/checks.ts`; making it data
is what unlocks both the guided-run UX and the upstream sync.

---

## 5. Execution: `bun start guide <source-engine>`

A new command walks the selected playbook:

```
bun start guide mysql --json
```

> **Note:** The current `guide` command renders a static playbook text. The interactive walkthrough described below
> (detect -> guide -> verify -> gate) is a proposed enhancement. `--role` and `--json` are the only supported flags.

For each item in phase order:

1. run `detect` → current state
2. compare to desired; if already correct, mark **satisfied**, continue
3. else: `auto` → perform + `verify`; `assisted`/`guided` → print templated `guidance`,
   wait, then `verify`; `informed` → print + require `ack`
4. **gate**: a `fail`-severity item that is neither satisfied nor verified **blocks**
   the phase. Same fail-closed contract as `doctor`'s `✗ NOT READY` and `cutover`'s
   `--confirm-writes-stopped`.

`guide` is `run` with a human in the loop and a knowledge base behind it. `--json` emits
NDJSON (per the existing `run`/`status` convention) so it scripts in CI.

Every step's outcome — satisfied / auto-applied / acknowledged-by-operator-at-T — is
written to the run log, so a failed migration is auditable instead of "I think I set that?"

---

## 6. Upstream KB sync — why the knowledge doesn't rot

Inert embedded knowledge is worse than docs, because it ships *stale* gotchas. In the last
year alone: Neon inbound logical replication went GA, PlanetScale launched Postgres,
Aurora added `aurora.enhanced_logical_replication`. So `provenance` is not decoration — it
drives a maintenance loop.

- **`bun start kb drift`** — for each item, re-fetch `provenance.source`, hash the cited
  section, diff against `upstreamHash`. For PG-family + AWS items the source is
  **docs.erfi.io**, which is already a refreshed mirror (`aws-rds` 1388 files, `aws-aurora`
  988, `aws-dms` 291) updated by the existing "Update Docs" cron — so drift-check is a
  `docs_grep` against a path you control, not a fragile scrape of a vendor marketing site.
  For Debezium/MySQL items the source is the upstream URL (`debezium.io`, `dev.mysql.com`).

- **`kb sync`** — surfaces drifted items for human review. It does **not**
  auto-rewrite guidance from a doc diff (that is the same untrustworthy-automation trap as
  auto-applying a guessed schema). A human ratifies the change and bumps `lastSynced` +
  `upstreamHash`.

- **Staleness at run time** — if an item's `lastSynced` is older than N days when `guide`
  runs it, the step prints a soft warning ("this step's knowledge is 90 days old; vendor
  behaviour may have changed") — the same honesty as the cross-engine reconcile downgrade
  (§9).

The KB becomes a living asset with a freshness SLA, not a hardcoded `if`-ladder that is
wrong in six months.

---

## 7. Worked playbook: MySQL → Supabase

Real items, real provenance. Settings below are from the Debezium MySQL connector "Setting
up MySQL" reference and the MySQL manual — the authoritative source-of-truth for
CDC-out-of-MySQL, which is exactly what a MySQL→PG guide must encode.

### Phase: source-prep

**`mysql.user_grants`** — `severity: fail`, `klass: assisted`
- **guidance**: create a dedicated CDC user with the minimum grants the connector needs:
  ```sql
  CREATE USER 'pgmig'@'%' IDENTIFIED BY '<pw>';
  GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT
    ON *.* TO 'pgmig'@'%';
  FLUSH PRIVILEGES;
  ```
- **detect/verify**: `SHOW GRANTS FOR CURRENT_USER` includes `REPLICATION SLAVE` +
  `REPLICATION CLIENT`.
- **provenance**: `https://debezium.io/documentation/reference/stable/connectors/mysql.html` → "Creating a user"

**`mysql.binlog_enabled`** — `severity: fail`, `klass: assisted`
- **guidance** (my.cnf, requires restart):
  ```ini
  server-id        = <unique-id>      # SELECT @@server_id; must be unique in the cluster
  log_bin          = mysql-bin
  binlog_format    = ROW
  binlog_row_image = FULL
  ```
- **detect/verify**: `SELECT @@log_bin, @@binlog_format, @@binlog_row_image;` →
  `1, ROW, FULL`.
- **provenance**: `https://debezium.io/documentation/reference/stable/connectors/mysql.html` → "Enabling the binlog"

**`mysql.gtid_mode`** — `severity: warn`, `klass: assisted`
- **guidance**: GTIDs let the connector fail over to a replica and enable read-only
  incremental snapshots:
  ```sql
  SET @@GLOBAL.enforce_gtid_consistency = ON;
  SET @@GLOBAL.gtid_mode = ON;            -- requires the OFF→OFF_PERMISSIVE→ON_PERMISSIVE→ON ramp on a live server
  ```
- **detect/verify**: `SELECT @@gtid_mode, @@enforce_gtid_consistency;` → `ON, ON`.
- **provenance**: `https://debezium.io/documentation/reference/stable/connectors/mysql.html` → "Enabling GTIDs"

**`mysql.binlog_retention`** — `severity: fail`, `klass: assisted`
- **guidance**: binlogs must survive long enough to cover the snapshot + catch-up window.
  Self-hosted: `binlog_expire_logs_seconds` ≥ expected snapshot duration. **RDS/Aurora
  MySQL**: automated backups must be **on** (binlog requires them) and set retention via
  `CALL mysql.rds_set_configuration('binlog retention hours', 168);`
- **detect/verify**: `SELECT @@binlog_expire_logs_seconds;` (self-hosted) or
  `CALL mysql.rds_show_configuration;` (RDS).
- **provenance**: `https://debezium.io/.../mysql.html` (purge note) + `/docs/aws-rds/` (RDS proc — drift-synced)

**`mysql.binlog_row_value_options`** — `severity: warn`, `klass: assisted`
- **guidance**: must be empty, not `PARTIAL_JSON`, or the connector can't see full JSON
  column changes.
- **detect/verify**: `SELECT @@binlog_row_value_options;` → `''`.
- **provenance**: `https://debezium.io/.../mysql.html` → "Validating binlog row value options"

### Phase: snapshot / schema-translation (the `guided` heart)

**`mysql.schema_translation`** — `severity: fail`, `klass: guided`
- **guidance**: the tool drafts target Postgres DDL from the MySQL `information_schema` and
  presents the **type decisions that need a human**, defaulting to the documented Debezium
  mappings:
  - `TINYINT(1)` → **boolean** (Debezium's "TINYINT(1) to Boolean" converter) — but
    `TINYINT(1)` storing 0–127 should stay `smallint`; **ask**.
  - `UNSIGNED INT` → `bigint` (widen) ; `UNSIGNED BIGINT` → `numeric`.
  - `ENUM` / `SET` → `text` + optional `CHECK` ; flag for review.
  - zero-dates (`0000-00-00`) → `NULL` (the Debezium zero-date fallback) — confirm per
    column.
  - `DATETIME` vs `TIMESTAMP` → `timestamptz` with the source session tz pinned;
    **fractional-second precision carries across** (`DATETIME(6)`→`timestamptz(6)`, `TIME(3)`→`time(3)`;
    both engines cap at 6).
  - `DECIMAL` → `numeric(p,s)` preserved; warn on `decimal.handling.mode` rounding.
  - **generated columns** (`STORED`/`VIRTUAL GENERATED`) → drafted as a **plain column** so the
    CDC sink can write the captured value, then flagged with the source expression; converting to a
    Postgres `GENERATED ALWAYS AS (...) STORED` is a by-hand decision (MySQL functions ≠ Postgres).
  - `SET` → `text` (Debezium delivers it comma-joined) — or model as `text[]` / add a `CHECK`.
  - **spatial** (`GEOMETRY`/`POINT`/`POLYGON`/`MULTI*`/`GEOMETRYCOLLECTION`) → `text` (WKB); use the
    PostGIS `geometry` type if the target has the extension.
- **act**: never auto-applies. Writes the draft to `migration/<run>/target-schema.sql`,
  records each human decision, and **gates cutover** behind explicit sign-off.
- **provenance**: `https://debezium.io/documentation/reference/stable/connectors/mysql.html` → "Data type mappings"

### Phase: cutover / reconcile

**`mysql.identity_resync`** — `severity: fail`, `klass: auto`
- **guidance**: after CDC catch-up, `AUTO_INCREMENT` values do not replicate; set each
  Postgres `IDENTITY`/sequence to `MAX(pk)+1` before traffic flips. (Direct analogue of the
  existing PG sequence-resync in `cutover`.)
- **verify**: `pg_sequences.last_value >= max(pk)` for every mapped table.
- **provenance**: pgmig internal (mirrors PlanetScale's `ff-seq`/sequence-handling step).

### Phase: target-prep (Supabase moat — reuse what exists)

The Supabase non-data plane (`auth.users` FK seeding, `storage` schema, RLS, `config-sync`,
advisor `verify`, the cutover write-stop gate) is **already automated by pgmig** and is
engine-independent -- it runs identically whether rows arrived from PG logical replication
or a Debezium MySQL stream. AWS DMS streams your rows and leaves all of this to you; this is
the differentiator. See [`MIGRATION-SCOPE.md`](MIGRATION-SCOPE.md).

**Doctor warnings to watch for in this phase:**

- **STORED generated columns** -- the doctor detects them and warns they are excluded from the
  reconcile hash (the subscriber recomputes them per-row, so hashing would show a false mismatch).
  No action needed, but expect the warning.
- **`cron.job` active jobs** -- the doctor warns if `pg_cron` has active jobs. Pause them at the
  watermark before `bootstrap` so they do not fire on a half-migrated target.
- **Vault / pgsodium root key** -- the doctor warns if `vault.secrets` is non-empty: the encryption
  root key is NOT carried by a manual dump/restore. Copy it from the source via the Management API
  if you use column encryption.
- **pg_dump client version** -- the doctor checks the local `pg_dump --version` against the source
  server major. If the client is older than the server, `bootstrap` will fail with a GSSAPI
  negotiation error. Install a matching pg_dump (e.g. via `apt install postgresql-client-<major>`).

---

## 7b. Worked playbook: SQL Server / Azure SQL → Supabase

Real items, real provenance. This is the harder heterogeneous engine: T-SQL diverges further
from PL/pgSQL than MySQL does, and the capture mechanism is SQL Server CDC change-tables
(read by the Debezium SQL Server connector), not a binlog.

> **The preflight phase of this playbook *is* the customer discovery questionnaire.** The
> four questions a sales/solutions team sends to scope an Azure SQL move — which Azure SQL
> product, how much logic lives in the DB, unusual types/features, how apps connect — are
> exactly the `detect` items below. The tool and the questionnaire are the same knowledge,
> one machine-checked and one human-asked.

### Phase: preflight

**`sqlserver.flavour`** — `severity: fail`, `klass: informed`
- **why**: Azure SQL **Database** (PaaS), Azure SQL **Managed Instance**, and **SQL Server
  on a VM** differ in CDC availability and network reachability for the capture tool.
- **detect**: `SELECT SERVERPROPERTY('EngineEdition');` → `5` = Azure SQL Database,
  `8` = Managed Instance, `3` = Enterprise (VM/on-prem).
- **provenance**: `https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview`

### Phase: source-prep

**`sqlserver.cdc_enable`** — `severity: fail`, `klass: assisted`
- **guidance**: enable CDC at DB then table scope (needs `db_owner`):
  ```sql
  EXEC sys.sp_cdc_enable_db;
  EXEC sys.sp_cdc_enable_table @source_schema=N'dbo', @source_name=N'<table>', @role_name=NULL;
  ```
  **Azure SQL Database tier gate**: CDC is supported on any **vCore** tier, or **DTU S3+**
  — **Basic / S0 / S1 / S2 are not supported**. In Azure SQL DB an internal scheduler
  replaces SQL Server Agent (capture every ~20s, cleanup hourly). The `cdc` schema and `cdc`
  user must be free (CDC claims them exclusively).
- **detect/verify**: `SELECT is_cdc_enabled FROM sys.databases WHERE name = DB_NAME();` → `1`.
- **provenance**: `https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview`

**`sqlserver.cdc_retention`** — `severity: warn`, `klass: assisted`
- **guidance**: default CDC retention is **3 days** — raise it to cover snapshot + catch-up.
  Note: enabling CDC **disables ADR aggressive log truncation** (the capture reads the
  transaction log), so watch log-file growth during heavy write windows.
- **provenance**: same as above.

**`sqlserver.change_tracking_alt`** — `severity: info`, `klass: informed`
- **note**: **Change Tracking** is a lighter feature (row changed / not, no column history).
  It does not give the before/after images CDC does; the Debezium SQL Server connector needs
  **CDC**, so Change Tracking alone is insufficient for this path.
- **provenance**: `https://learn.microsoft.com/en-us/sql/relational-databases/track-changes/about-change-tracking-sql-server`

### Phase: schema-translation (`guided` — the long pole, larger than MySQL's)

**`sqlserver.schema_translation`** — `severity: fail`, `klass: guided`
- **type mapping** (drafted, human-ratified):

  | SQL Server | Postgres | note |
  |---|---|---|
  | `TINYINT` | `smallint` | SQL Server TINYINT is 0–255, unsigned |
  | `BIT` | `boolean` | |
  | `MONEY` / `SMALLMONEY` | `numeric(19,4)` | |
  | `DATETIME` / `DATETIME2` | `timestamp` | pin source tz |
  | `DATETIMEOFFSET` | `timestamptz` | |
  | `UNIQUEIDENTIFIER` | `uuid` | |
  | `BINARY` / `VARBINARY` | `bytea` | |
  | `NVARCHAR(MAX)` / `TEXT` | `text` | |
  | `XML` | `xml` or `text` | |
  | `HIERARCHYID` / `GEOGRAPHY` / `GEOMETRY` / `sql_variant` | **no clean equivalent** | flag for design decision |
  | `IDENTITY` column | `GENERATED BY DEFAULT AS IDENTITY` (PG 10+) | |

- **two traps that aren't type-by-type**:
  - **Case sensitivity** — SQL Server identifiers + default collations are case-**insensitive**;
    Postgres is case-**sensitive**. `UserData` and `userdata` collapse in SQL Server but are
    two objects in Postgres. Decide per column: fold to lower, `citext`, or an ICU collation.
  - **T-SQL → PL/pgSQL** — stored procedures, functions, and triggers are **rewritten, not
    copied** (`GETDATE()`→`now()`, `ISNULL`→`coalesce`, `TOP`→`LIMIT`, etc.). This is the
    heaviest single item and is `guided` end-to-end; **Microsoft SSMA for PostgreSQL** /
    **AWS SCT** are the canonical conversion authorities to validate the drafts against
    during `kb sync`.
- **out-of-DB callout** (`informed`): application code carries SQL-Server-specific SQL too;
  the tool flags this as app-side scope it cannot fix, so it is not silently missed.
- **provenance**: `https://www.bladepipe.com/blog/tech_share/migrate_sqlserver_to_postgresql/`
  (type table + traps) — cross-validate against Microsoft SSMA on sync.

### Phase: cutover

**`sqlserver.identity_resync`** — `severity: fail`, `klass: auto` — same as the MySQL/PG
sequence resync: set each Postgres `IDENTITY` to `MAX(pk)+1` before traffic flips.

---

## 8. Appendix playbook: PG-family (drop-in, mostly `assisted`/`auto`)

These are the same native logical-replication engine pgmig uses today — only the
enablement guidance differs per provider. Provenance is docs.erfi.io.

| id | provider | guidance (summary) | provenance |
|---|---|---|---|
| `rds-pg.logical_replication` | RDS PostgreSQL | `rds.logical_replication=1` in a **custom parameter group**; **static → reboot**; sets `wal_level`/`max_wal_senders`/`max_replication_slots` | `/docs/aws-rds/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.md` |
| `aurora-pg.logical_replication` | Aurora PostgreSQL | same in a **cluster** parameter group | `/docs/aws-aurora/AuroraPostgreSQL.Replication.Logical.md` |
| `aurora-pg.enhanced` | Aurora PostgreSQL | optional `aurora.enhanced_logical_replication=1` writes full column images without `REPLICA IDENTITY FULL`; **toggling invalidates all slots** (recreate); raises source IOPS | `/docs/aws-aurora/zero-etl.setting-up.md` |
| `neon.enable` | Neon | enable logical replication per project — **irreversible**, **restarts all computes**; `max_wal_senders`/`max_replication_slots` pinned at 10 | `https://neon.com/docs/guides/logical-replication-neon` |
| `neon.slot_reaping` | Neon | inactive slots auto-removed after ~40h; a paused migration loses its slot (ties into pgmig's WAL watchdog) | `https://neon.com/docs/guides/logical-replication-neon` |
| `neon.scale_to_zero` | Neon (as source) | a connected subscriber prevents scale-to-zero → ongoing compute cost | `https://neon.com/docs/guides/logical-replication-neon` |
| `planetscale-pg.disk` | PlanetScale Postgres | target disk must be ≥150% of source size; params via Clusters → Parameters | `https://planetscale.com/docs/postgres/imports/postgres-migrate-walstream` |
| `planetscale-pg.copy_data` | PlanetScale Postgres | after a manual schema import, `CREATE SUBSCRIPTION ... copy_data=false` or duplicate-key errors; resync sequences | `https://planetscale.com/docs/postgres/imports/postgres-migrate-walstream` |

For these, `classifyConn` (`src/db.ts`) gains a `provider` discriminator (host pattern), and
`doctor`'s Supabase-only pooler/direct ladder becomes a `switch (provider)` that emits the
right item. No engine changes — this is valuable on its own, independent of heterogeneous.

---

## 8b. Real-cloud rehearsal (the beta -> stable evidence step)

The heterogeneous engines are harness-verified in CI against real MySQL 8.2 and SQL Server 2022
containers. The last confidence step before trusting the path in anger is a rehearsal against a
**real managed cloud source** (Azure SQL Database / Managed Instance, or Amazon RDS / Aurora
MySQL) plus a real Postgres target, driven by the exact same engine + config the production run
uses. That rehearsal is `test/heterogeneous/rehearse-cloud.ts`.

**It is a rehearsal: it NEVER stops source writes and NEVER cuts over.** It runs
`translate --apply` (no sign-off) -> `replicate` -> `watch` (health + catch-up + retention
watchdog) -> `reconcile` -> `teardown`, then removes the Debezium container, leaving the source
untouched. Config + secrets load exactly as the CLI loads them, so what you rehearse is what you
run.

```bash
# config: $PGMIG_CONFIG (default ./migrate.config.yaml); secrets: $SOURCE_DB_URL / $TARGET_DB_URL
# The Debezium container runs on YOUR machine and connects OUT to the cloud source, so the source
# firewall must allow your egress IP and SOURCE_DB_URL must be the PUBLIC endpoint.
bun run test/heterogeneous/rehearse-cloud.ts
# PGMIG_REHEARSE_SKIP_TRANSLATE=1  -> you already applied the target schema; skip the draft/apply
```

Requires Docker locally. Exit 0 = the snapshot + streaming + reconcile were healthy against your
cloud source; review the printed guided decisions before a real cutover.

### Source prep before you rehearse

**Azure SQL Database / Managed Instance (SQL Server engine):**
- **Tier**: CDC needs any **vCore** tier, or DTU **S3+**. Basic / S0 / S1 / S2 cannot be a CDC
  source. `doctor`'s `sqlserver.azure_tier` gate fails early on a blocked tier.
- **CDC**: `EXEC sys.sp_cdc_enable_db` then `sys.sp_cdc_enable_table` on each table. On Azure SQL
  DB an internal scheduler runs capture/cleanup (no SQL Server Agent); on MI/VM, Agent must run.
- **Retention**: default CDC cleanup is 3 days. `watch`'s retention watchdog reads it from
  `msdb.dbo.cdc_jobs` and aborts before a slow snapshot outruns it.
- **Connectivity + TLS**: allow your egress IP in the server firewall; put `?encrypt=true` on
  `SOURCE_DB_URL` (Azure requires TLS; the engine flips it on when it sees that flag).

**Amazon RDS / Aurora MySQL (MySQL engine):**
- **binlog**: `binlog_format=ROW`, `binlog_row_image=FULL`, `binlog_row_value_options` empty.
- **Retention**: automated backups must be ON (RDS binlog requires them), then
  `CALL mysql.rds_set_configuration('binlog retention hours', 168)`. `watch`'s retention
  watchdog reads `@@binlog_expire_logs_seconds` and aborts before the snapshot outruns purge.
- **Connectivity**: publicly-accessible instance (or run the rehearsal from within the VPC) with
  a security-group rule for your egress IP.

### Keep it cheap and safe

- Rehearse against a **restored snapshot / clone** of production, or a small representative table
  set (`reconcile.tables`), not the live primary -- the rehearsal reads + snapshots but the extra
  CDC read load and the applied target schema are still real.
- The rehearsal leaves the source untouched, but it DOES create the target schema (drop the
  throwaway target afterwards).
- To prove CDC (not just snapshot), INSERT/UPDATE a few rows on the source during the rehearsal
  window and watch the counts converge before `reconcile`.

---

## 9. The two honest caveats (printed loudly at run time)

1. **Schema translation cannot be fully automated.** Item `mysql.schema_translation` is
   `guided`, never `auto`: the tool drafts, the human ratifies, cutover gates on sign-off.
2. **Cross-engine reconcile loses the byte-for-byte guarantee.** pgmig's PG→PG reconcile
   hashes `row::text` with pinned GUCs — impossible across engines (MySQL trims trailing
   spaces, SQL Server pads CHAR, booleans/timestamps/floats render differently). Heterogeneous
   reconcile drops to **count + per-column aggregates** (min/max/sum/count/null-count). The
   `reconcile` output must state this reduction explicitly — it catches gross divergence,
   not subtle type-coercion bugs.

---

## 10. How this lands on the codebase (minimal disruption)

1. Extract today's `doctor` checks into `Playbook` data items in `src/kb/` — mechanical
   refactor, no behaviour change. Valuable immediately, including for the PG-family work.
2. Add `bun start guide <source-engine>` - walks the playbook, runs detect -> guide -> verify,
   gates per S5.
3. Add `bun start kb drift` / `kb sync` wired to docs.erfi.io + vendor URLs (S6).
4. The heterogeneous **data plane** (Debezium behind a `ReplicationEngine` interface) is
   orthogonal — see [`HETEROGENEOUS.md`](HETEROGENEOUS.md). The **knowledge plane** in this
   doc is the larger differentiator and ships independently.

Source priority by demand: MySQL / Aurora-MySQL first, then SQL Server / Azure SQL (Debezium
SQL Server connector, CDC change-tables), then MongoDB (document→relational, a separate
shape), Oracle last (LogMiner/XStream licensing pain).
```
