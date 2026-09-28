# pgmig

**Near-zero-downtime Postgres-to-Postgres migration** via native logical replication. Move data
between two databases while the source stays online. Only the final cutover (seconds to minutes)
requires stopping writes.

Works for any PG15+ -> PG15+ pair: Supabase to Supabase (cross-region, same-region tier change,
project split), self-hosted to Supabase, or self-hosted to self-hosted.

---

## Which path should I use?

pgmig has **three separate workflows**. Your goal determines which one to follow.

| If you want to... | Use this path | Commands (in order) |
|---|---|---|
| **Move data between two databases** with minimal downtime (cross-region move, project split, self-hosted to Supabase) | **A -- Migration** | `doctor -> bootstrap -> replicate -> watch -> reconcile -> cutover -> verify -> teardown` |
| **Practice a migration** or test the pipeline on throwaway projects | **B -- Sandbox / Rehearsal** | `sandbox up -> doctor -> bootstrap -> replicate -> watch -> reconcile -> cutover -> sandbox down` |
| **Rehearse a Postgres major-version upgrade** (e.g. PG 15 to 17 using `pg_upgrade`) | **C -- Upgrade rehearsal** | `upgrade doctor -> upgrade capture -> upgrade lab -> upgrade verify` |

**Path A** streams row data via logical replication while the source stays online. You stop writes
only for the final cutover (seconds to minutes). This is the main use case.

**Path B** creates temporary Supabase projects, seeds data, runs the full pipeline, then deletes
everything. Use it to learn the tool without risk.

**Path C** audits your database for upgrade blockers, dumps a copy, times a real `pg_upgrade` in
Docker, and proves the upgraded copy is data-identical. No database migration -- just rehearsal.

> **Migrating from MySQL or SQL Server to Postgres?** See [`docs/HETEROGENEOUS.md`](docs/HETEROGENEOUS.md)
> and [`docs/GUIDED-MIGRATION.md`](docs/GUIDED-MIGRATION.md). Those use a different engine (Debezium
> CDC) and need schema translation. The rest of this README covers the Postgres -> Postgres path.

---

## Prerequisites

Install these **before** you start. Each has a check command to verify it is ready.

### 1. Bun (runs the CLI)

```bash
bun --version
```

**Expected:** `1.3.x` or higher.

If you don't have Bun: `curl -fsSL https://bun.sh/install | bash`

### 2. Docker (for sandbox, upgrade lab, and rehearsal tests)

```bash
docker --version
docker compose version
```

**Expected:** Docker `24.x` or higher, compose `v2.x` or higher.

### 3. Postgres client tools (pg_dump, psql)

```bash
pg_dump --version
psql --version
```

**Expected:** `15.x` or higher. The local major version must be >= the source server's major
version. If the local version is older, you will get a `GSSAPI negotiation error` when `bootstrap`
tries to dump the schema.

**If you see that error:** Install a newer postgres client. On macOS:
`brew install postgresql@17`. On Debian/Ubuntu: `apt install postgresql-client-17`.

### 4. Network reachability (the IPv6 trap)

Logical replication needs a **direct connection** to the database host, NOT the connection pooler.
The direct host (`db.<ref>.supabase.co:5432`) is **IPv6-only** unless the project has the
[IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address).

```bash
# Test if your machine can reach the direct host (replace <ref> with your project ref)
ping -c 1 db.<your-project-ref>.supabase.co
```

**If this fails**, your machine has no IPv6 route to the direct host. You have three options:

- **Option A (recommended):** Run pgmig from an IPv6-capable host -- a small VM in the
  target region. Clone the repo there, `bun install`, and run the commands.
- **Option B (small cost, ~$6/mo):** Enable the IPv4 add-on on the source project. The
  direct host then resolves to IPv4.
- **Option C (last resort):** Keep `SOURCE_DB_URL` on the pooler for admin queries and set
  `SOURCE_REPLICATION_URL` to the source direct host. The pooler does NOT carry WAL --
  replication still goes direct. The `doctor` command validates this split.

### 5. Supabase Access Token (optional -- for Supabase-specific commands)

Only needed if you use `provision`, `config-sync`, `sandbox`, `functions`, or `storage`.

```bash
echo $SUPABASE_ACCESS_TOKEN
```

**Expected:** `sbp_<long string>`. Find it at:
[Supabase Dashboard -> Account -> Access Tokens](https://supabase.com/dashboard/account/tokens)
Create one with scope `All` (or at minimum `Projects: read/write` and `Orgs: read`).

---

## Setup

### Clone and install

```bash
git clone https://github.com/erfianugrah/pgmig.git
cd pgmig
bun install
```

### Compiled binary (optional - no Bun needed at runtime)

```bash
bun run build              # -> ./pgmig (standalone, embeds the Bun runtime; gitignored)
mv pgmig ~/.local/bin/   # or anywhere on your PATH
pgmig doctor             # same UX as `bun start doctor`
```

Rebuild after code changes. Tagged releases (`v*`) also publish prebuilt
linux/darwin x64+arm64 binaries via `.github/workflows/release.yml`.

### Environment variables

Copy the example env file and fill in your values. **Every value is a secret -- never commit it.**

```bash
cp .env.example .env
```

The env file is authoritative over your shell environment. If you have a conflicting variable
already exported, pgmig warns you. Use `--no-env-file` to skip the env file entirely.

All commands accept these global options:

| Option | Default | Description |
|---|---|---|
| `-c, --config <path>` | `migrate.config.yaml` | Path to the config file |
| `--env-file <path>` | `.env` if present | Secrets file to load (authoritative over inherited env) |
| `--no-env-file` | off | Skip loading any env file; use inherited environment as-is |
| `--log-file <path>` | `logs/pgmig-<command>-<timestamp>.log` | Mirror all logs to this file (survives terminal/SSH loss) |
| `--no-log-file` | off | Disable the log file (terminal only) |

| Variable | Where to find it (Supabase Dashboard) | Required for | Example |
|---|---|---|---|
| `SOURCE_DB_URL` | Project Settings -> Database -> Connection string -> URI (use the **direct** host, not pooler) | Everything | `postgresql://postgres:password@db.<ref>.supabase.co:5432/postgres` |
| `TARGET_DB_URL` | Same as above, for the target project | Everything | `postgresql://postgres:password@db.<ref>.supabase.co:5432/postgres` |
| `SOURCE_REPLICATION_URL` | Same as SOURCE_DB_URL but always the **direct** host | Only if you use the pooler split (Option C above) | `postgresql://postgres:password@db.<ref>.supabase.co:5432/postgres` |
| `SUPABASE_ACCESS_TOKEN` | [Account -> Access Tokens](https://supabase.com/dashboard/account/tokens) | `provision`, `config-sync`, `sandbox`, `functions`, `storage` | `sbp_abc123...` |

**Leave empty (unset) any variable you don't need.** Empty string means "not used."

### Config file

```bash
cp migrate.config.example.yaml migrate.config.yaml
# Edit migrate.config.yaml with your project refs and table list
```

Here is an annotated example:

```yaml
# migrate.config.yaml -- list the tables you want to replicate
source:
  ref: abcdefghijklmnopqrst   # your source Supabase project ref (from the dashboard URL)
  host: db.abcdefghijklmnopqrst.supabase.co  # direct host, not pooler
tables:
  - public.users              # schema.table -- one per line
  - public.orders
  - public.order_items

# Optional: change default names
# replication:
#   publication: pgmig_pub
#   slot: pgmig_slot
#   subscription: pgmig_sub

# Optional: only if you want to copy non-database config
# configSync:
#   secrets: true             # copy SMTP/OAuth/SMS secrets (default: false)
#   projectSecrets: true      # copy Edge Function env vars (default: false)

# Optional: billable infra to match
# provision:
#   compute: micro            # target compute size
#   disk: 16                  # target disk size in GB
```

---

## Quick Start A -- Near-zero-downtime migration

This walks you through the full pipeline. Run each command in order. Read the output before
proceeding to the next step. All commands use `bun start <command>`.

### Step 0: Readiness check (read-only)

```bash
bun start doctor --source-only
```

**What it does:** Checks the source database for readiness: connection shape (pooler vs direct),
WAL level, replica identity, extension versions, cross-schema foreign keys, and any custom
Postgres config that won't be replicated. Exit code 0 = pass, 1 = fail.

**Expected output (pass):**
```
✓ SOURCE wal_level = logical
✓ SOURCE has replica identity
✓ Doctor pass: READY (with warnings)
```

**Expected output (fail):**
```
✗ SOURCE wal_level = replica (needs logical)
✗ NOT READY -- fix the issues above, then re-run
```

**If you see NOT READY:** Fix the reported issues and re-run `doctor` before continuing.

### Step 1: Load schema, roles, and extensions onto the target

```bash
# Preview what will be done (read-only)
bun start bootstrap
```

**What it does:** Shows a preview of the extensions, roles, and schema that will be created on
the target. No changes are made yet.

```bash
# Apply the changes (this mutates the target)
bun start bootstrap --confirm
```

**What it does:** Enables missing extensions on the target, restores database roles (without
passwords -- passwords must be set manually), and restores the schema. For Supabase sources, it
automatically excludes the ~27 managed schemas (`auth`, `storage`, `extensions`, etc.) that
already exist on every Supabase project.

**If you have tables that reference `auth.users`** (a foreign key from your table into the
auth schema), you must also load auth data onto the target before the next step:

```bash
# ONLY if you have cross-schema FKs into auth.users (doctor will tell you)
bun start bootstrap --confirm --with-auth-data
```

### Step 2: Stand up replication

```bash
bun start replicate
```

**What it does:** Creates a publication (what to replicate) on the source, a replication slot
(where to read WAL from) on the source, and a subscription (where to apply the data) on the
target. This starts the initial copy of all existing data.

### Step 3: Watch the initial sync

```bash
bun start watch
```

**What it does:** Polls the replication status every few seconds and shows:
- Which tables are still copying (percentage done)
- Which tables are ready (fully synced)
- The WAL size being retained by the replication slot (the watchdog aborts if it grows too large)

**Expected output:**
```
public.users           copying   42%  (1.2 GB / 2.8 GB)
public.orders          ready     --    (all rows copied)
public.order_items     ready     --    (all rows copied)
WAL retained: 1.8 GB  (watchdog limit: 50 GB)
```

Let `watch` run until all tables show `ready`. For large databases, this can take hours.

### Step 4: Stop writes to the source

**This is the only moment of downtime.** Put your application in read-only mode or take it
down. Do NOT skip this step -- the cutover will fail if writes are still flowing.

### Step 5: Reconcile (checksum verification)

**Run this AFTER you have stopped writes** (Step 4), otherwise in-flight rows will show as
spurious diffs.

```bash
bun start reconcile
```

**What it does:** Compares row data between source and target using chunked checksums (256
buckets by default). If any rows differ, it reports the exact divergent rows.

**Expected output (pass):**
```
RECONCILE PASSED -- all 256 buckets match
```

**Expected output (fail):**
```
RECONCILE FAILED -- 1 bucket mismatch
  Table public.users: row id=42 missing_on_target
```

**If reconcile fails:** Do NOT proceed to cutover. Investigate the mismatch. You can restart
writes on the source, tear down replication with `teardown`, and fix the issue.

### Step 6: Cutover (drain lag, resync sequences, drop subscription)

```bash
bun start cutover
```

**What it does:**
1. Drains remaining replication lag to 0 (waits up to 300 seconds by default)
2. Verifies writes are actually stopped (samples WAL position twice)
3. Resyncs sequence values (serial/IDENTITY columns) so new inserts don't collide
4. Drops the subscription (replication stops permanently)

**Expected output:**
```
Lag: 0 bytes (drained)
Writes stopped: confirmed (WAL not advancing)
✓ Sequences resynced: 3
✓ Subscription dropped
✓ CUTOVER COMPLETE
```

**If the cutover fails** (lag won't drain because writes are still happening):
```
✗ Lag did not drain -- WAL is still advancing
  Writes may not be stopped. Check your application.
```

**If you need more time for lag to drain:**
```bash
bun start cutover --max-lag-wait 600
```

**After cutover completes:**
- Repoint your application to the target database (change the connection string)
- Add any cron jobs on the target now
- Re-enable scheduled jobs that were paused

### Step 7: Copy non-database config (Supabase only)

```bash
# Preview what will be copied (read-only)
bun start config-sync --dry-run

# Apply the changes
bun start config-sync
```

**What it does:** Copies project configuration (Auth settings, Realtime settings, PostgREST
settings, Storage settings, pooler config) via the Supabase Management API. Secrets (SMTP
passwords, OAuth client secrets) are NOT copied by default.

**The JWT signing secret + API keys are NEVER copied.** New project = new keys by design.
Existing user sessions will invalidate and users will need to re-login.

### Step 8: Match billable infra (optional, Supabase only)

```bash
# Preview what will be changed (read-only)
bun start provision

# Apply the changes (this changes the bill!)
bun start provision --confirm
```

**What it does:** Adjusts the target project's compute size, disk size, PITR (Point-In-Time
Recovery), IPv4 add-on, and backup schedule to match the source. This is a **billable** change.

### Step 9: Post-migration health check

```bash
bun start verify
```

**What it does:** Runs Supabase advisors on the target (RLS policies, primary keys, performance
lints) and fails if any issues are found. Exit 0 = healthy, exit 1 = issues found.

### Step 10: Tear down replication objects

```bash
bun start teardown
```

**What it does:** Safely drops the subscription, slot, and publication in the correct order.
Idempotent -- safe to run even if some objects were already dropped.

---

## Quick Start B -- Sandbox (practice on throwaway projects)

Use this to practice the full pipeline without touching real data. It creates temporary Supabase
projects, runs the pipeline, then deletes everything.

```bash
# Create a throwaway source+target pair, seed data, write config files
bun start sandbox up --org <your-org-id>

# Check the sandbox status (shows the config files to use)
bun start sandbox status

# Now run the pipeline using the sandbox config files:
# (the sandbox up command prints the exact commands)
bun start -c migrate.sandbox.yaml doctor
bun start -c migrate.sandbox.yaml bootstrap --confirm
bun start -c migrate.sandbox.yaml replicate
bun start -c migrate.sandbox.yaml watch
bun start -c migrate.sandbox.yaml reconcile
bun start -c migrate.sandbox.yaml cutover
bun start -c migrate.sandbox.yaml teardown

# When done: delete both projects
bun start sandbox down
```

---

## Quick Start C -- Postgres major-version upgrade rehearsal

This is a **separate workflow** from the migration pipeline. Use it when you want to rehearse a
Postgres in-place major-version upgrade (e.g. PG 15 to 17) on production-like data before running
the real upgrade. No `migrate.config.yaml` is needed -- flags and env vars only.

### Step C1: Upgrade doctor (readiness audit)

```bash
SOURCE_DB_URL="postgresql://postgres:password@db.<ref>.supabase.co:5432/postgres" \
  bun start upgrade doctor --to 17
```

**What it does:** Read-only audit of the source. Checks for:
- Extensions deprecated on the target major version
- `reg*` columns referencing system OIDs
- Logical replication slots (foreign slots that could hold WAL)
- Roles using `md5` password encryption (may fail to connect after upgrade)
- Estimated downtime based on database size

**Expected output:**
```
✓ No deprecated extensions found
✓ No foreign replication slots
✗ 2 roles use md5 passwords (will fail to connect after upgrade)
  -> Fix: ALTER ROLE <name> WITH PASSWORD 'newpassword';
✓ DB size: 2.8 GB -> estimated downtime: ~15 min (fixed overhead) + ~30 sec (copy)
```

**Exit code:** 0 = pass (no hard blockers), 1 = at least one hard blocker found.

### Step C2: Upgrade capture (dump the source)

```bash
SOURCE_DB_URL="postgresql://postgres:password@db.<ref>.supabase.co:5432/postgres" \
  bun start upgrade capture --out-dir capture --max-gb 10
```

**What it does:** Dumps roles, schema, and data into a local directory (`capture/`). Creates a
`manifest.json` with version, size, and extension inventory. Refuses to capture if the database
is larger than `--max-gb` (10 GB default) unless `--force` is used.

**For Supabase sources with auth data:**
```bash
SOURCE_DB_URL="postgresql://..." \
  bun start upgrade capture --out-dir capture --with-auth-data
```

**Expected output:**
```
✓ Capture complete: 2.8 GB, 3 extensions, 27 tables
  Manifest: capture/manifest.json
```

### Step C3: Upgrade lab (time a real pg_upgrade in Docker)

**Option 1: With real captured data:**
```bash
bun start upgrade lab --capture-dir capture --runs 3 --keep
```

**Option 2: Without real data (seed a fixture instead):**
```bash
bun start upgrade lab --seed-gib 0.5 --runs 3
```

**What it does:** Starts two Docker containers (old version and new version), restores the
captured data (or seeds a fixture), snapshots the old data directory, runs `pg_upgrade --link`
N times (fresh snapshot copy per run), and runs post-upgrade `ANALYZE`. Emits a timing report.

**Expected output:**
```
Run 1: 3.6s  (pg_upgrade --link)
Run 2: 3.8s  (pg_upgrade --link)
Run 3: 3.7s  (pg_upgrade --link)
Average: 3.7s
```

**With `--keep`:** Leaves both containers running so you can run `upgrade verify` next.
**With `--prod-bytes`:** Extrapolates the production downtime window:
```bash
bun start upgrade lab --capture-dir capture --runs 3 --keep --prod-bytes 100000000000
```

### Step C4: Upgrade verify (prove data-identical)

```bash
SOURCE_DB_URL="postgresql://localhost:5433/pre" \
  TARGET_DB_URL="postgresql://localhost:5434/post" \
  bun start upgrade verify
```

**What it does:** Compares the pre-upgrade copy (at `SOURCE_DB_URL`) and the upgraded cluster
(at `TARGET_DB_URL`) using chunked-checksum reconcile. Also checks extension versions, auth
schema row sanity, and md5-role status. Exit 0 = data-identical, exit 1 = divergence found.

**Expected output (pass):**
```
VERIFY PASSED -- all tables checksum-identical
Extensions: 3/3 versions match
Auth schema: 2 tables, 142 rows, no issues
```

**Expected output (fail):**
```
RECONCILE FAILED -- 1 bucket mismatch
  Table public.users: row id=42 hash_diff
  Extension pgjwt: source has 1.0, target has 1.1
✗ VERIFY FAILED
```

---

## Command Reference

Every command listed here. Run any of these with `bun start <command>`.

### Migration pipeline

```bash
# Readiness checklist: connection shape, wal_level, replica identity, extension versions,
# cross-schema FKs, foreign replication slots, custom GUC overrides.
# --source-only skips target checks (use when target isn't created yet)
bun start doctor --source-only
```

```bash
# Read-only hard-gate checks (subscribe grant, replication capacity, replica identity).
# Throws on failure.
bun start preflight
```

```bash
# Prepare the target: enable extensions + restore roles + schema from source.
# Preview by default; --confirm applies the changes.
# --all-schemas: include Supabase managed schemas (auth/storage/...)
# --with-auth-data: also load auth schema row data (FK pre-step)
# --out-dir <path>: directory for dumped SQL files (default: ledger)
bun start bootstrap --confirm
```

```bash
# Create publication + slot + subscription on target. Starts the initial copy.
bun start replicate
```

```bash
# Poll initial-sync state + WAL-bloat watchdog. Shows per-table copy progress.
# Run until all tables show 'ready'.
bun start watch
```

```bash
# Checksum source vs target. Chunked mode (256 buckets) by default.
# --mode full: single aggregate (small tables only)
# --buckets <n>: bucket count (default: 256)
# --max-examples <n>: max divergent rows to report (default: 20)
# --out-dir <path>: directory for reconcile JSON report (default: ledger)
bun start reconcile
```

```bash
# Drain lag to 0, resync owned sequences, drop subscription.
# --max-lag-wait <sec>: seconds to wait for lag to drain (default: 300)
# --out-dir <path>: directory holding the translated-schema sign-off manifest (default: ledger)
bun start cutover
```

```bash
# Drop subscription/slot/publication safely. Idempotent.
bun start teardown
```

### Verification

```bash
# Post-migration health gate: run Supabase advisors on the target.
# --fail-on <level>: gate threshold (error | warn | info, default: error)
# --out-dir <path>: directory for the verify JSON report (default: ledger)
# --json: emit result as JSON on stdout
bun start verify
```

### Config and infra (Supabase only)

```bash
# Copy non-data config via Management API (auth, realtime, postgrest, storage, pooler).
# Secrets stripped by default.
# --dry-run: diff only, do not apply
bun start config-sync --dry-run
```

```bash
# Copy billable infra (compute size, PITR/IPv4, disk, backup schedule).
# Preview by default; --confirm applies (changes the bill).
bun start provision --confirm
```

```bash
# Move a project into another org.
# <org-slug>: target org slug
# <token>: claim token from the source org
# Preview by default; --confirm performs the claim.
bun start claim <org-slug> <token> --confirm
```

### Edge Functions and Storage (Supabase only)

```bash
# Transfer Edge Functions from source to target.
# --dry-run: print commands only
bun start functions --dry-run
```

```bash
# Push storage objects from local directory to target.
# <localDir>: directory containing storage objects to upload
# --dry-run: print commands only
bun start storage ./storage-dir --dry-run
```

### Schema translation (non-Postgres sources)

```bash
# Draft target Postgres DDL from MySQL information_schema. Never auto-applies.
# --out-dir <path>: directory for target-schema.sql + decisions manifest (default: ledger)
# --apply: also apply the drafted DDL to the TARGET (mutates it)
# --sign-off: ratify the existing draft so cutover may proceed
# --json: emit draft as JSON on stdout
bun start translate --out-dir ledger
```

### Autonomous run (CI / Lambda)

```bash
# Execute the pipeline end-to-end. Exit 0 iff all phases through the requested stop pass.
# --through <phase>: stop after this phase (preflight | replicate | watch | reconcile | cutover)
# --json: emit NDJSON events on stdout (human logs to stderr)
# --confirm-writes-stopped: required to allow --through cutover
# --max-lag-wait <sec>: cutover lag-drain wait (default: 300)
bun start run --through reconcile --json
```

```bash
# Cutover is destructive and refused unless you assert writes are stopped:
bun start run --through cutover --confirm-writes-stopped
```

### Status (one-shot snapshot)

```bash
# One-shot replication snapshot for a scheduled watcher.
# --json: emit a single JSON object on stdout
# --require-synced: exit non-zero unless all tables are ready
bun start status --json
```

### Migration guide (knowledge base)

```bash
# Enablement playbook for a migration source.
# <target>: managed Postgres provider (azure, supabase, ...) or heterogeneous engine (mysql, sqlserver)
# --role: limit to 'source' or 'target' role
# --json: emit the guide as JSON on stdout
bun start guide supabase
```

```bash
bun start guide mysql
```

### Knowledge base maintenance

```bash
# Flag KB items whose guidance hasn't been re-verified recently.
# --max-age-days <n>: staleness threshold (default: 90)
# --json: emit drift report as JSON on stdout. Exit 1 if stale items found.
bun start kb drift
```

### Upgrade rehearsal (PG major-version upgrade)

```bash
# Read-only major-upgrade readiness audit of the source.
# --to <major>: target Postgres major version (default: 17)
# --db-url <url>: source connection string (default: SOURCE_DB_URL)
# --copy-mbps <n>: assumed disk copy throughput for downtime estimate (default: 100)
# --fixed-overhead-sec <n>: assumed fixed platform overhead in seconds (default: 900)
bun start upgrade doctor --to 17
```

```bash
# Dump roles + schema + data of the source into a local directory.
# --db-url <url>: source connection string (default: SOURCE_DB_URL)
# --out-dir <path>: capture output directory (default: capture)
# --max-gb <n>: refuse to capture above this size unless --force (default: 10)
# --force: capture even above --max-gb
# --all-schemas: include Supabase-managed schemas
# --with-auth-data: also dump auth schema row data separately
bun start upgrade capture --out-dir capture --max-gb 10
```

```bash
# Docker lab: time a real pg_upgrade --link N times on production-like data.
# --from <major>: source Postgres major version (default: 15)
# --to <major>: target Postgres major version (default: 17)
# --runs <n>: pg_upgrade timing runs (default: 3)
# --capture-dir <path>: capture directory from `upgrade capture`
# --seed-gib <n>: fixture + size-targeted seed instead of a capture (GiB)
# --image <flavor>: lab image flavor (auto | pgdg | supabase, default: auto)
# --from-image <ref>: supabase/postgres image for old major (supabase flavor)
# --to-image <ref>: supabase/postgres image for new major (supabase flavor)
# --prod-bytes <n>: production DB size in bytes (extrapolated downtime estimate)
# --keep: keep lab containers running afterwards (for upgrade verify)
# --clean: tear down the lab containers and exit
# --work-dir <path>: lab scratch directory (default: .upgrade-lab)
bun start upgrade lab --capture-dir capture --runs 3 --keep
```

```bash
# Prove the upgraded cluster is data-identical via chunked-checksum reconcile.
# --include-managed: also diff Supabase-managed schemas (auth/storage/...)
# --out-dir <path>: directory for reconcile JSON report (default: ledger)
# --max-examples <n>: max divergent rows to report per table (default: 20)
bun start upgrade verify
```

```bash
# The upgrade group also responds to the `pgupgrade` alias:
bun start pgupgrade doctor --to 17
bun start pgupgrade capture --out-dir capture --max-gb 10
bun start pgupgrade lab --capture-dir capture --runs 3
bun start pgupgrade verify
```

```bash
# And the `rehearse upgrade` group (same subcommands, nested under rehearse):
bun start rehearse upgrade doctor --to 17
bun start rehearse upgrade capture --out-dir capture --max-gb 10
bun start rehearse upgrade lab --seed-gib 0.5
bun start rehearse upgrade verify
```

### Sandbox (throwaway Supabase pair for rehearsal)

```bash
# Create a throwaway Supabase source+target pair, seed the source,
# write migrate.sandbox.yaml + .env.sandbox.
# --org <id>: Supabase org slug (required)
# --rows <n>: documents to seed on the source (default: 3000)
# --payload <bytes>: approx payload bytes per document (default: 2000)
# --src-region <r>: source region (default: eu-central-1)
# --tgt-region <r>: target region (default: eu-west-1)
bun start sandbox up --org <org-id>
```

```bash
# Check sandbox status.
bun start sandbox status
```

```bash
# Delete both sandbox projects + remove the generated files.
bun start sandbox down
```

### Rehearsal harness (test rig)

```bash
# Live replication/reconcile against a throwaway Docker Postgres pair.
bun start rehearse integration
```

```bash
# Seed source data for rehearsal (batched, concurrent, server-side generation).
# --rows <n>: row count (default: 100000)
# --payload <bytes>: approx payload bytes per row (default: 6000)
bun start rehearse seed --rows 100000 --payload 6000
```

```bash
# Seed to a target size in GiB.
# --gib <n>: target table size (default: 10)
# --payload <bytes>: approx payload bytes per row (default: 6000)
# --batch <rows>: rows per insert batch (default: 50000)
# --concurrency <n>: parallel insert batches (default: 4)
bun start rehearse seed-size --gib 10 --payload 6000
```

```bash
# Full scale rehearsal: seed-to-size -> run -> fault gate -> teardown (throwaway pair).
# --gib <n>: target source size (default: 10)
# --payload <bytes>: approx payload bytes per row (default: 6000)
# --batch <rows>: rows per insert batch (default: 1000)
# --concurrency <n>: parallel insert batches (default: 4)
# --chaos <scenario>: fault scenario to inject
# --chaos-arg <value>: argument for the chaos scenario
bun start rehearse run --gib 10
```

```bash
# Inject a fault scenario into the rehearsal pair.
# <scenario>: drop-replica-identity | lose-row | corrupt-row | stall-subscriber |
#             desync-sequence | tsearch-drift
# --arg <value>: scenario argument (table / subscription name)
bun start rehearse chaos lose-row
```

```bash
# Drive continuous write load with an append-only id ledger.
# --ledger <path>: ledger file path (default: ledger/written_ids.log)
# --interval <ms>: ms between inserts (default: 50)
# --duration <sec>: stop after N seconds (default: run until Ctrl-C)
bun start rehearse writer --ledger ledger/written_ids.log
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GSSAPI negotiation error` or `unsupported version` when running `bootstrap` | Local `pg_dump`/`psql` version is older than the source server's major version. The client library uses GSSAPI negotiation, which fails when the versions don't match. | Install a newer postgres client: `brew install postgresql@17` (macOS), `apt install postgresql-client-17` (Debian/Ubuntu). The local version only needs to be >= the source version. |
| `doctor` reports `NOT READY` -- pooler detected in SOURCE_DB_URL | You set `SOURCE_DB_URL` to the pooler host (`*.pooler.supabase.com`). The pooler cannot stream logical replication. | Change `SOURCE_DB_URL` to the **direct** host (`db.<ref>.supabase.co:5432`). If you have no IPv6, set `SOURCE_REPLICATION_URL` to the direct host and keep `SOURCE_DB_URL` on the pooler (Option C). |
| `doctor` reports `NOT READY` -- cannot reach direct host | Your machine has no IPv6 route to the direct host, and the project does not have the IPv4 add-on. | Run from an IPv6-capable host (Option A) or enable the IPv4 add-on in the dashboard (Option B, ~$6/mo). |
| `replicate` fails with `ERROR: insert or update on table "users" violates foreign key constraint "fk_user_id"` on `auth.users` | A table in your replication list has a foreign key into `auth.users`, but the target's `auth.users` is empty. Every row is rejected. | Before running `replicate`, load auth data onto the target: `bun start bootstrap --confirm --with-auth-data`. `doctor` prints this advice. |
| After cutover, a custom login role cannot connect to the target | Database roles are dumped without passwords (`pg_dumpall --roles-only --no-role-passwords`). The role exists on the target but has no password. | Reset the password on the target: `ALTER ROLE <name> WITH PASSWORD '<new-password>';` |
| `upgrade doctor` warns about roles using `md5` passwords | The source uses `md5` password encryption, which is deprecated (or removed) on the target major version. After upgrade, these roles cannot authenticate. | Change each role to use `scram-sha-256`: `ALTER ROLE <name> WITH PASSWORD '<password>';` (this automatically upgrades to scram-sha-256). |
| `doctor` reports extension version mismatch between source and target | An extension is installed on both sides but at different versions. The target may have a newer version that is not backward-compatible. | Update the extension on the target: `ALTER EXTENSION <name> UPDATE TO '<version>';` or match the source version. |
| `watch` aborts: `WAL watchdog: retained WAL exceeds limit` | The replication slot is retaining too much WAL on the source, filling up disk space. The watchdog aborts to prevent the source from running out of disk. | Either increase the watchdog limit (`watchdog.maxRetainedWalMb` in config) or speed up the initial copy (check for slow tables, especially those with STORED generated columns). |
| `provision` fails with `capacity` error | The target region does not have capacity at the requested compute size. | Try a smaller compute size, or choose a different region. Check capacity before the migration window. |
| `pg_cron` jobs fire on the target before cutover, modifying data that should not be touched yet | The target already has `pg_cron` enabled and the cron jobs from the source schema were restored by `bootstrap`. The jobs start running immediately on the target. | Before running `bootstrap`, pause cron jobs at the watermark. Add cron jobs to the target only **after** cutover. `doctor` warns about `cron.job` if it detects it. |
| `pgsodium` / vault root key not carried by dump/restore | The `pgsodium` root key is stored outside the database (in the Supabase platform) and is not included in any dump file. | Copy the key via the API: `GET /pgsodium` -> `PUT /pgsodium`. Only needed if you use column encryption / Vault. |
| Initial copy is very slow (e.g. ~11 MiB/s instead of ~80 MiB/s) | A table has a STORED generated column (e.g. a `tsvector` column for full-text search). Generated columns are recomputed per row on the subscriber during the initial copy, which is CPU-bound. Measured: **~7x slower** with the generated column. | For very large tables, define the generated column as a plain column on the target during sync, then convert it to generated after the copy completes. Or budget the extra hours. |
| `bootstrap` fails with `permission denied` or `must be superuser` | The database user does not have sufficient privileges to run `pg_dump` / `pg_dumpall` / `psql` with the required flags. On Supabase, the `postgres` role is not a superuser. | `bootstrap` is aware of Supabase's supautils restrictions. It filters out superuser-only objects (event triggers, `COMMENT ON EXTENSION`, publications, FDW grants) that would cause the restore to abort. Ensure you are using the direct host (not pooler) and the `postgres` role. |

---

## Safety Model

pgmig is designed to be **safe by default**. Every command is read-only unless you explicitly
opt in to mutations.

### Read-only by default

- `doctor`, `preflight`, `reconcile`, `status`, `watch`, `upgrade doctor` -- **never modify anything**.
- `bootstrap`, `provision`, `claim` -- **preview only** by default. Add `--confirm` to apply.
- `config-sync` -- **diff only** by default. Add `--dry-run` to preview, then run without it to
  apply (but even then, secrets are stripped by default).
- `translate` -- **write only** by default. Add `--apply` to apply to the target.
- `cutover`, `teardown` -- these are **destructive** by design. `cutover` drops the subscription
  (replication stops permanently). `teardown` drops the subscription, slot, and publication.

### The confirm gates

| Command | Gate | What happens |
|---|---|---|
| `bootstrap` | `--confirm` | Without it, prints the `pg_dump`/`psql` plan and exits. |
| `provision` | `--confirm` | Without it, prints the billable changes and exits. |
| `claim` | `--confirm` | Without it, prints the claim preview and exits. |
| `run --through cutover` | `--confirm-writes-stopped` | Refuses to cutover unless you assert writes are stopped. |
| `translate` | `--sign-off` | Refuses to cutover (heterogeneous) until the schema draft is signed off. |

### The rollback point of no return

The migration is **lossless** up until the moment you repoint your application to the target
database. Before that:

- **Phase A (before cutover):** The source is still taking writes. The replication slot and
  subscription can be torn down with `teardown`. **No data loss.**
- **Phase B (after cutover, app NOT yet repointed):** Writes are stopped. The source has all
  data. The target has all data up to the cutover point. You can restart the migration or
  re-point the app to the source. **No data loss.**
- **Phase C (after app repointed):** The target is now taking writes. The source still has
  pre-cutover data but is missing post-cutover writes. **This is the point of no return.**
  Rolling back to the source loses every write the target took.

### Where logs are written

- All commands write a log file to `logs/<command>-<timestamp>.log` in the repo directory (override with `--log-file <path>`, disable with `--no-log-file`).
- The `reconcile` report writes to `ledger/reconcile-<timestamp>.json`.
- The `verify` report (with `--json`) writes to the configured `--out-dir` (default: `ledger/`).
- Error output goes to stderr. Use `--json` on `run`, `status`, `verify`, `translate` to get
  machine-readable output on stdout.

---

## Non-Supabase migrations

The replication engine is plain Postgres -- the integration suite runs it against vanilla
`postgres:16` containers with zero Supabase involvement. To migrate any PG15+ -> PG15+ pair
(self-hosted to self-hosted, self-hosted to Supabase, same-region tier change, project split):

- **Required:** source has `wal_level=logical`; the target role can `CREATE SUBSCRIPTION`;
  the schema (DDL) is loaded on the target first; connection strings are **direct** (not a
  transaction pooler).
- **Use:** `doctor`, `bootstrap`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`,
  `teardown`, `status`, `run` -- all engine-only and Supabase-agnostic.
- **Skip:** `config-sync` (no-ops without `SUPABASE_ACCESS_TOKEN`), `functions`
  (`functions.enabled: false`), `storage` (`storage.buckets: []`).

---

## Why this exists

A cross-region migration is ~7 independent workstreams. Most are already covered; this tool
fills the data-movement gap and reminds you of the rest:

| Workstream | Handled by | In this tool |
|---|---|---|
| Schema / DDL | `bootstrap` (or `supabase db push` / `pg_dump --schema-only`) | `bootstrap --confirm` does extensions + roles + schema |
| **Table data, low-downtime** | native logical replication | **`replicate` + `watch`** |
| Sequences | resync at cutover | `cutover` resyncs every owned sequence |
| Storage objects | `supabase storage cp` | `storage` wrapper |
| Edge Functions | `supabase functions download/deploy` | `functions` wrapper |
| Project config (Auth/Realtime/...) | Management API | `config-sync` (secrets opt-in) |
| JWT signing secret / API keys | nothing -- new project = new keys | never copied |
| Post-migration health gate | Management API advisors | `verify` (fails on RLS/PK/etc. lints) |
| Compute size / PITR / IPv4 / disk / backup schedule | Management API (billable) | `provision` (preview + gate) |
| Move project to another org | Management API claim token | `claim` (preview + gate) |

---

## Testing & Rehearsal

Four validation tiers:

```bash
bun test                  # 1. unit       -- pure logic, no DB, always runs
bun run test:integration  # 2. integration -- live replication + fault injection vs a Docker PG pair
bun run test:scale        # 3. scale      -- volume + safety-gate harness (Docker)
bun run test:live <org>   # 4. live       -- real throwaway Supabase projects (costs money)
```

---

## Layout

```
src/
  cli.ts              commander entry -- one subcommand per step
  config.ts           zod schema (YAML) + env secrets schema
  db.ts               source/target postgres clients; subscription conn string; withRetry
  mgmt.ts             Supabase Management API client
  steps/
    doctor.ts         automated readiness checklist (pre-migration)
    bootstrap.ts      target pre-step: extensions + roles + schema (pg_dump/psql; confirm-gated)
    run.ts            autonomous pipeline runner (CI/Lambda entry point)
    preflight.ts      read-only gate checks
    checks.ts         shared preflight/doctor SQL (subscribe grant, replication capacity)
    replicate.ts      publication + slot + subscription
    watch.ts          sync-state poll + WAL bloat watchdog
    reconcile.ts      counts + content-hash + ledger proof
    cutover.ts        lag drain + sequence resync + drop subscription
    teardown.ts       safe ordered cleanup
    status.ts         one-shot replication snapshot (for scheduled watchers)
    config-sync.ts    Management API config copy
    provision.ts      billable infra copy (compute/disk/pitr/ipv4/backup-schedule; confirm-gated)
    verify.ts         post-migration advisor health gate
    claim.ts          org-level project-claim
    sandbox.ts        throwaway Supabase pair for rehearsal (up/status/down)
    cli-wrappers.ts   supabase functions/storage wrappers
    translate.ts      MySQL->Postgres schema translation
  upgrade/
    doctor.ts         major-upgrade readiness audit
    capture.ts        dump roles + schema + data for upgrade lab
    lab.ts            Docker lab: time pg_upgrade N times
    verify.ts         prove upgraded cluster is data-identical
    source.ts         source-only connection helpers
  rehearsal/
    schema.sql        sandbox / rehearse-run fixture
    seed.ts           seed source data (far-future expiry)
    writer.ts         continuous write load + id ledger
test/                 *.test.ts (unit) + integration.test.ts + scale/live harnesses
docs/
  RUNBOOK.md          the step-by-step runbook
  MIGRATION-SCOPE.md  exhaustive what-migrates/what-doesn't
  GUIDED-MIGRATION.md design: guided knowledge-bearing advisor for heterogeneous to PG/Supabase
  HETEROGENEOUS.md    design: Debezium data plane behind a ReplicationEngine interface
```