# Cross-region (and PG→PG) migration — step-by-step runbook

A no-guessing procedure to move a Postgres database (Supabase→Supabase across regions, or any
PG15+→PG15+ pair) with minimal downtime, using native logical replication. Follow it top to
bottom. Substitute your own project refs / connection strings / table names where placeholders
appear (`<...>`).

If you only read one thing: **run `bun start doctor` at every gate and do not proceed past
a `✗ NOT READY`.**

For the **exhaustive list of what does and does not migrate** (consolidating Supabase's three
official guides + the Management-API surface), see **[`docs/MIGRATION-SCOPE.md`](MIGRATION-SCOPE.md)**
— it answers "what are the *some things* not stored in my database?" completely.

> **Major-version upgrade rehearsal is a different workflow.** If you are rehearsing a Postgres
> major-version upgrade (the in-place `pg_upgrade` path) rather than moving data to a new
> project, use `pgmig upgrade doctor|capture|lab|verify` (also `pgupgrade` /
> `rehearse upgrade`) - no migrate.config.yaml needed. See the README section
> **Major-version upgrade rehearsal**.

Prerequisites (Bun, the `supabase` CLI, `psql`/`pg_dump`, Docker for the rehearsal) and
install steps are in the README **Prerequisites** + **Getting started** sections - set those
up before step 1.

---

## 0. Gather these facts about YOUR migration first (do not skip)

Fill this table in before you touch anything. `doctor` verifies most of it, but knowing the
answers up front is what makes the rest of the runbook mechanical.

| Fact | How to find it | Why it matters |
|---|---|---|
| Source project ref | dashboard / connection string | the FROM |
| Source region | dashboard | the move is *away* from here |
| Org id (Supabase) | `supabase orgs list` | the target is created here |
| Postgres version + `wal_level` | `show server_version; show wal_level;` | logical replication needs `wal_level=logical` and target version ≥ source |
| Data tables to replicate | your schema | the only thing this tool copies — enumerate them in config |
| Generated columns | `\d+ <table>` | STORED generated columns are excluded from the reconcile hash automatically |
| **Cross-schema FKs into `auth`** | inspect FKs | **referenced rows (e.g. `auth.users`) must exist on the target BEFORE the copy** or every child row is FK-rejected |
| Owned sequences (serial/IDENTITY) | `\d <table>` | resynced at cutover; none needed for uuid/text PKs |
| Storage buckets / objects | dashboard | NOT carried (managed schema) - recreate buckets; the `storage` step pushes objects but auto-creates buckets **private** (restore visibility) |
| Edge Functions | dashboard | transferred separately (`functions` step) or skipped if none |
| Non-default extensions | `select extname, extversion from pg_extension;` | must be enabled on the target before the schema load; `doctor` also flags an installed extension whose version DIFFERS between source and target |
| Custom LOGIN roles | `\du` | passwords are not dumped — reset them manually on the target if any |

> If your `supabase` CLI can't find its Go binary, export `SUPABASE_GO_BINARY` to its path
> before any `supabase` command.

---

## 1. DECISION REQUIRED — where you run the replication from (connectivity)

Logical replication needs a **direct** connection on both ends:
`postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres`.
The **pooler** host (`...pooler.supabase.com`) **cannot stream replication** — it is only
usable for read-only inspection and for `supabase db dump`.

The direct host is **IPv6-only** unless the project has the IPv4 add-on. **If the box you run
from has no IPv6 route**, `replicate` / `watch` / `reconcile` cannot connect to the direct
host from there. Pick one before you go further:

- **Option A (recommended, $0):** run `pgmig` from an IPv6-capable host — e.g. a small
  VM in the target region. Clone the repo, `bun install`, copy `migrate.config.yaml` + `.env`.
- **Option B (small cost):** enable the [IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address)
  on the source (and target) for the migration window, then run from your box. Remove it after.
- **Option C (split - last resort):** only if you can do neither A nor B. Keep
  `SOURCE_DB_URL`/`TARGET_DB_URL` on the IPv4 **session pooler** for admin/dump/reconcile and set
  **`SOURCE_REPLICATION_URL`** to the source *direct* host. This does NOT route WAL through the
  pooler - the subscription's CONNECTION is `SOURCE_REPLICATION_URL`, dialed by the target's
  walreceiver over the provider's internal network, so replication stays direct. `doctor`
  validates the split, and `replicate` hard-errors if the replication CONNECTION is ever a pooler.
  Prefer A or B - the pooler adds a hop for pgmig's own queries with no upside.

The read-only prep in steps 2–3 and the dump/restore in step 6 work via the **pooler**
regardless of which option you choose.

---

## 2. Stage config + env

```bash
cd <repo>
bun install
cp migrate.config.example.yaml migrate.config.yaml   # set source.ref + tables
cp .env.example .env                                  # set SOURCE_DB_URL (and token if Supabase)
# migrate.config.yaml and .env are gitignored.
bun start doctor --source-only
```

Expected: `READY (with warnings)` when `SOURCE_DB_URL` is the **direct** host - the typical
warning is the `auth.users` cross-schema FK (addressed in step 6). If you're on a non-IPv6 box
and set `SOURCE_DB_URL` to the pooler, set **`SOURCE_REPLICATION_URL`** to the source *direct*
host now (Option C) so `doctor` reports the split as correct. A pooler `SOURCE_DB_URL` with no
`SOURCE_REPLICATION_URL` is a hard **FAIL** (`NOT READY`): the pooler can't stream WAL, so that
config could never replicate.

---

## 3. Rehearse on throwaway Postgres first (optional but recommended, $0)

Proves the replication + reconcile + fault-detection SQL end-to-end with no managed project:

```bash
bun run test:integration   # needs Docker; ~6s
```

For a scale rehearsal that emulates real on-disk size + live write load, see the README
**Rehearsal** section (`bun start rehearse seed-size` / `rehearse writer` / `rehearse run`).

### Driving the rehearsal pair from the host (no in-docker runner)

`docker-compose.rehearsal.yml`'s runner service exists so the subscription's CONNECTION
(`source:5432`) resolves identically from the runner and from the target's walreceiver.
To drive the pair with the CLI / compiled binary directly from the host instead, split
the URLs by who dials them:

- `SOURCE_DB_URL` / `TARGET_DB_URL` - dialed by pgmig itself (seed, doctor,
  reconcile). Use the published host ports: `localhost:55432` / `localhost:55433`.
- `SOURCE_REPLICATION_URL` - dialed by the TARGET's walreceiver. `localhost` would
  resolve to the target container itself, so use the compose network gateway IP with
  the published source port (reachable from inside the container AND from the host):
  `postgresql://postgres:pw@<gateway>:55432/postgres?sslmode=disable`. Get the gateway
  via `docker network inspect pgmig-rehearsal_default --format '{{(index .IPAM.Config 0).Gateway}}'`.

Three gotchas, all learned the hard way:

- **Docker Desktop on WSL**: the Windows Hyper-V `excludedportrange`
  (`netsh int ip show excludedportrange protocol=tcp`) can reserve 55432/55433, and
  publishing then fails with a `forwards/expose ... 500`. Remap with an override file -
  use the `!override` tag, because plain port overrides APPEND and `!reset` WIPES:
  `ports: !override ["56432:5432"]`.
- **Fresh pair per `rehearse run`**: the seed is deterministic and teardown drops the
  publication/slot/subscription but does NOT truncate the target tables. A second run
  on a dirty pair dies with `duplicate key value violates unique constraint` in a
  tablesync error loop. `docker compose ... down -v` between runs.
- **`ledgerPath` needs the writer**: the example config's `reconcile.ledgerPath`
  inflight-loss proof reads `ledger/written_ids.log`, which only `rehearse writer`
  writes. Drop the ledger keys from the config for a plain `rehearse run`, or reconcile
  fails with ENOENT after otherwise passing.

### Validating the safety gates (prove they FIRE, not just that they exist)

Before trusting a real migration, confirm the data-plane gates actually abort when they
should. The scale harness (`test/scale.harness.ts`) has three modes, selected by env flag,
all against a throwaway docker PG pair (no managed project, $0):

```bash
# positive path — concurrent INSERT/UPDATE/DELETE on documents AND no-PK UPDATE/DELETE
# churn on the REPLICA IDENTITY FULL audit table run THROUGH the initial copy + streaming
# apply; writes stop before cutover; reconcile runs after cutover at lag=0 with a ledger
# inflight-loss check. EXPECT: RECONCILE PASSED, ledger clean.
docker compose -f docker-compose.test.yml run --rm \
  -e ROWS=200000 -e WRITE_LOAD=1 -e WRITE_INTERVAL_MS=2 -e WRITE_AFTER_SEC=6 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'

# NEGATIVE — freeze apply + bloat source WAL. EXPECT: `watch` aborts via the WAL watchdog
# ("slot retains NN MB > 8 MB limit"); harness exits 0 only because the gate fired.
docker compose -f docker-compose.test.yml run --rm \
  -e ROWS=1000 -e WATCHDOG_FIRE=1 -e WATCHDOG_MB=8 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'

# NEGATIVE — keep writing through cutover. EXPECT: `cutover` fails closed
# ("lag did not drain in time"); proves cutover refuses when writes were not stopped.
docker compose -f docker-compose.test.yml run --rm \
  -e ROWS=50000 -e WRITE_THROUGH_CUTOVER=1 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'
```

Each harness exits non-zero if the expected gate does **not** fire, so they double as CI
assertions (see `.github/workflows/ci.yml`). This is the negative-path complement to the
README's `rehearse chaos` table — same gates, exercised at scale.

---

## 4. Create the target project  ← THE ONLY BILLABLE STEP (Supabase)

```bash
# Pick the new region. Valid regions: ap-east-1 ap-northeast-1 ap-northeast-2 ap-south-1
#   ap-southeast-1 ap-southeast-2 ca-central-1 eu-central-1 eu-central-2 eu-north-1
#   eu-west-1 eu-west-2 eu-west-3 sa-east-1 us-east-1 us-east-2 us-west-1 us-west-2
supabase projects create <project-name> \
  --org-id <YOUR_ORG_ID> \
  --region <TARGET_REGION> \
  --db-password "$(openssl rand -base64 24)"   # SAVE THIS — you'll need it below
```

Note the new project **ref** it prints. From the dashboard **Connect** panel of the new
project, copy the **direct** connection string (`db.<newref>.supabase.co:5432`) and its
**session-pooler** string (`...pooler.supabase.com:5432`) — you'll use the pooler for the
restore and the direct one for replication.

(For a self-hosted target, just provision the empty PG15+ instance and capture its direct
connection string.)

---

## 5. Point the config + env at the new target

Edit `migrate.config.yaml`:

```yaml
target:
  ref: <NEW_TARGET_REF>
```

Edit `.env` — set `TARGET_DB_URL` to the new project's **direct** string, and (only when you
run replication from an IPv6 host or with the IPv4 add-on) switch `SOURCE_DB_URL` to the
source **direct** string. From a non-IPv6 box keep `SOURCE_DB_URL` on the pooler for the dump
and use `SOURCE_REPLICATION_URL` (Option C above).

---

## 6. Restore everything the tool does NOT replicate — onto the target, in order

Logical replication carries **table rows only** — no DDL, no roles, no `auth`/`storage`
schemas. Any FK from a replicated table into `auth.users` means the **referenced auth rows
must exist on the target before the copy**, or every child row is rejected. Connection here
can be the **pooler** (read for dump, write for restore) — direct is not required for this step.

> **Preferred: `bun start bootstrap --confirm`.** It does 6a–6c for the roles + schema +
> extensions automatically, **without Docker** (the `supabase db dump` path below shells
> `pg_dump` inside a version-matched container). For a Supabase source it auto-excludes the
> managed schemas and filters the reserved roles (`anon`/`supabase_*`/`postgres`/…) exactly
> like `supabase db dump`, so you never hit the `supabase_admin` ownership / `cli_login_postgres`
> grant errors the manual path warns about below. Pass **`--with-auth-data`** to also do the
> `auth` ROW data (the `auth.users` FK pre-step) in the same run - it dumps the auth-schema
> rows and restores them with `session_replication_role = replica` so FK triggers are deferred
> during the load (`bun start bootstrap --with-auth-data --confirm`). Without that flag the auth
> data is skipped (see step 6d / the FK-trap command `doctor` prints). The manual `supabase db
> dump` flow below remains the fallback when you can't run the system `pg_dump`/`pg_dumpall`.

```bash
SRC="<SOURCE_POOLER_OR_DIRECT_URL>"
TGT="<TARGET_POOLER_URL>"

# 6a. dump roles, schema (DDL+RLS+functions), and the auth-schema DATA from the source
supabase db dump --db-url "$SRC" -f roles.sql  --role-only
supabase db dump --db-url "$SRC" -f schema.sql
supabase db dump --db-url "$SRC" -f auth.sql   --data-only --schema auth --use-copy \
  -x auth.schema_migrations   # SELECT-only for postgres on managed targets; see below

# 6b. enable non-default extensions on the target FIRST (dashboard → Database → Extensions,
#     or SQL). `doctor` in step 7 lists exactly which are still missing — enable those.

# 6c. restore roles → schema → auth data, with triggers disabled during the data load
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file auth.sql \
  --dbname "$TGT"
```

`auth.schema_migrations` is the one auth table where managed targets grant the `postgres`
role SELECT only (verified 2026-07-30: every other auth table gets full DML) — restoring a
dump that includes it fails with `permission denied for table schema_migrations`, and the
target already carries its own migration ledger. `bootstrap --with-auth-data` excludes it
automatically (pg_dump `--exclude-table-data`); the manual path above passes `-x` explicitly. If `bootstrap`
fails partway, re-running it re-plans the schema restore against tables that now exist -
recover by running the printed auth-data dump/restore commands by hand instead of re-applying
the whole schema.

If `psql` errors on `supabase_admin` ownership or a `cli_login_postgres` grant, see the
"Troubleshooting" notes in the upstream guide
(`/docs/supabase/guides/platform/migrating-within-supabase/backup-restore.md`) — comment out
the offending `ALTER ... OWNER TO "supabase_admin"` / `GRANT "postgres" TO "cli_login_postgres"`
line and re-run.

`schema.sql` is the authoritative app-schema source (full live DDL: tables, RLS, functions,
any scheduled-job functions). It does **not** contain `cron.schedule(...)` job rows (that's
data in the `cron` schema, not DDL), so the target won't run scheduled jobs while both DBs are
live. Add any such schedule explicitly **after** cutover in step 9d. Prefer the dumped
`schema.sql` over replaying a migrations directory — it already captures the live state.

For a non-Supabase pair, replace the `supabase db dump` calls with ordinary
`pg_dumpall --roles-only` + `pg_dump --schema-only`, and there is no `auth` schema to restore.
(`bootstrap` does this automatically — it skips the managed-schema/role filters for a
non-Supabase source.)

**Firewall / network reachability (non-Supabase or self-managed source).** The subscription's
WAL stream is dialed *by the target's walreceiver*, not from your laptop — so the **source**
must accept inbound connections from the **target's egress IPs** on the Postgres port, and (if
the source enforces it) `pg_hba.conf` must permit the replication role from those IPs. Supabase→
Supabase sidesteps this (the dial goes over Supabase's internal network), but for an Azure /
self-hosted / cloud source you must allowlist the subscriber's egress IPs first, or
`CREATE SUBSCRIPTION` connects but the stream never starts. (Azure: *Server → Networking →
Firewall rules*; capture the target host's outbound IPs and add one rule per IP.) Likewise
`pg_dump`/`pg_dumpall` for the pre-step must reach the source from wherever you run `bootstrap`.

---

## 7. Full readiness check + preflight  ← GATE (run from the replication host)

```bash
bun start doctor        # full: source + target
bun start preflight
```

`doctor` must end `READY` (warnings ok). It confirms: target reachable, target version ≥
source, target role can `CREATE SUBSCRIPTION`, **target has all source extensions**, **your
data tables exist on the target (schema loaded)**, and that no cross-schema FK is missing its
prerequisite data. **Stop if any `✗`.**

---

## 8. Stand up replication and watch the initial copy  ← DIRECT connection required

```bash
bun start replicate     # creates publication + slot on source, subscription on target
bun start watch         # polls until all tables srsubstate='r'; aborts if WAL bloats past
                        # watchdog.maxRetainedWalMb (default 2048) on the source
```

`replicate` is idempotent-ish: it skips objects that already exist. If you need to start
over, run `bun start teardown` first.

---

## 9. Cutover  ← brief downtime starts here

### Migration-day signals — success & abort thresholds

Decide these BEFORE you stop writes. The tool owns the **data-plane** gates (left); your
observability stack owns the **app-tier** gates (right). Abort if either trips.

| Phase | Watch (data-plane, this tool) | Watch (app-tier, your dashboards) |
|---|---|---|
| Initial copy (`watch`) | WAL retained MB < `watchdog.maxRetainedWalMb`; slot `active`; `wal_status` stays `reserved`/`extended` (not `lost`); `apply_error_count`/`sync_error_count` flat | source DB CPU / disk IOPS / disk latency headroom; source not approaching connection saturation |
| Verify (`reconcile` 9b) | `RECONCILE PASSED` (zero mismatched buckets, ledger clean) | - |
| Lag drain + drop subscription (`cutover` 9c) | lag -> 0 within `--max-lag-wait`; quiesce check reports source WAL **quiescent** (no active write backends) | app confirmed in read-only / down; no client write retries hitting the source |
| Post-repoint (9e) | sequences resynced (cutover log shows each `setval`) | target p95/p99 latency within X% of source baseline; 5xx < Y; connection pool not spiking from retry storms |

**Hard abort thresholds (define concrete numbers from your baselines):**
- `watch` self-aborts on WAL watchdog and on `wal_status=lost` — do **not** override these.
- Lag fails to drain in `--max-lag-wait` → writes are not actually stopped; do not proceed.
- `reconcile` reports any mismatch → do **not** complete cutover; investigate.
- App-tier: sustained 5xx > Y for N min, or DB p95 > X for N min, after repoint → roll back (§12).

### Safety-net checklist -- verify before the freeze

Run through these **before** you stop writes. If any check fails, address it first.

- **Create a named restore point** via the Management API before the freeze.
  This gives you a known-good recovery target if something goes wrong mid-migration.
- **Re-check target-region capacity** at the target instance size. If the region is out of
  capacity at the compute size you need, pick a different size or region.
- **Pause cron at the watermark.** `doctor` warns about `cron.job` if it detects scheduled
  jobs. Pause them before `bootstrap` so they don't fire on a half-migrated target.
  Add them back only after cutover.
- **Disable `pg_cron`/`pg_net` on the target** until cutover. These extensions fire external
  actions (HTTP requests, scheduled jobs) immediately as soon as the schema is restored.
- **Re-password custom login roles.** `bootstrap` restores roles without passwords. Reset
  each custom login role's password: `ALTER ROLE <name> WITH PASSWORD '<new-password>';`
- **Storage copy method.** If you have Storage objects, decide whether to use the `storage`
  command (for S3-protocol-compatible targets) or a manual copy script.
- **JWT secret / API keys are NEVER copied.** Existing user sessions will invalidate after
  cutover. Your application must use the new project's keys. Update env vars before
  repointing the app.

Keep one dashboard view open for migration day: API RPS + p95/p99, 4xx/5xx + timeouts, DB CPU/mem/disk-latency/IOPS, DB connections (+ pooler), and the `pgmig watch`/`status` output (or its `--log-file`).

```bash
# 9a. STOP application writes to the SOURCE (put the app in read-only / take it down).
#     This is the only moment of downtime.

# 9b. verify source == target (writes stopped, data should match):
bun start reconcile                   # chunked checksum; must print RECONCILE PASSED
#   (full-table variant: bun start reconcile --mode full)

# 9c. drain replication lag to zero and drop the subscription:
bun start cutover                     # default waits up to 300s for lag to drain
#   (override: bun start cutover --max-lag-wait 600)

# 9d. load any deferred schedule/cron migration on the TARGET (the one skipped earlier):
psql "$TARGET_DB_URL" -f <path/to/deferred_schedule_migration.sql>

# 9e. repoint the app: set its database URL + keys to the new project and redeploy.
#     DNS/edge cutover as applicable.
```

**Never re-enable writes on the source after this point** — that causes split-brain. The
`cutover` command prints the same warning.

---

## 10. Copy non-data config (secrets stripped)

```bash
bun start config-sync --dry-run   # review the diff first
bun start config-sync
```

This copies Auth / Realtime / PostgREST / Storage / pooler settings via the Management API
(needs `SUPABASE_ACCESS_TOKEN` in `.env`). By default **secrets are stripped** — re-enter SMTP /
OAuth / JWT secrets on the target by hand in the dashboard (or opt in below). `config-sync` is a
TS port of `sync_supabase_config.sh`; read paths, `--dry-run`, and the apply (write) path have
all been exercised against the live Management API (2026-07-30: Auth / Realtime / Pooler /
PostgREST / Storage / project secrets applied and re-read on the target). Still `--dry-run`
first and review the diff — it is the last chance to catch an unwanted overwrite.

Note on the Auth section: two hook families (`hook_password_verification_attempt`,
`hook_mfa_verification_attempt`) are plan-gated — PATCHing them at all earns HTTP 402 on orgs
without the entitlement, even when disabled. `stripAuth` drops those families unless they are
enabled; an enabled gated hook passes through and fails loudly if the target org cannot take it.

**Optional sections + secret copying** (all opt-in under `configSync` in the config):

| Flag | Effect |
|---|---|
| `sslEnforcement: true` | copy DB SSL enforcement (GET → PUT `/ssl-enforcement`) |
| `networkRestrictions: true` | copy allowed-CIDR network restrictions (skips if source has none — never opens an empty allow-list) |
| `secrets: true` | copy auth **integration** creds (SMTP/OAuth/SMS/hook secrets) instead of stripping them |
| `projectSecrets: true` | copy project / Edge-Function secrets via the bulk `/secrets` endpoint (plaintext; `--dry-run` redacts values) |
| `thirdPartyAuth: true` | recreate third-party-auth integrations (Firebase/Auth0/Cognito/Clerk JWT) on the target (additive) |
| `ssoProviders: true` | recreate SSO/SAML providers on the target (additive; needs SAML 2.0 enabled on the target plan) |

Even with `secrets: true`, the **JWT signing secret + API keys are never copied** — they live on
separate endpoints this tool does not call, so a new project always gets new signing material.
### 10b. (Optional) Match billable infra — `provision`

Compute size, PITR/IPv4 addons, disk, and backup schedule are **billable**, so they live behind a
separate confirm-gated command rather than `config-sync`:

```bash
bun start provision            # preview: shows source → target diff + price, applies NOTHING
bun start provision --confirm  # applies — CHANGES THE TARGET'S BILL
```

Each area is opt-in under `provision` in the config (`compute`, `pitr`, `ipv4`, `disk`,
`backupSchedule` — all default `false`). `provision` only **adds/upgrades** the target to match
the source; it never strips addons the target already has. Gotchas:

- **Compute size is the migration-critical one** — if you don't match it, the target may be
  under-provisioned for the load you're cutting over. But matching a large source onto a fresh
  target starts billing immediately.
- **Custom Postgres config interacts with compute** (consideration #2 in the Supabase docs): if you
  copied compute-tuned GUCs (`shared_buffers` et al.), re-check them after a compute change.
- **Backup schedule needs the Enterprise plan** — `provision` skips it gracefully on lower plans.
- **Disk size only grows** in practice; shrinking is not supported by the platform.

Deferred / NOT automated (do by hand — see “What can't be migrated” below): custom domain & vanity
subdomain (DNS-coupled), `pgsodium` root key, read replicas, the `auth_mfa_phone` addon.

### What can't be migrated (no write path / by design)

The full not-migratable list (JWT/API keys, org settings/members/roles, entitlements, custom
domain, pgsodium key, read replicas, CLI-only GUCs) lives in the canonical scope reference —
**[`docs/MIGRATION-SCOPE.md` §C/§D](MIGRATION-SCOPE.md)**. The operationally-important callouts:

> **"Invisible" custom Postgres config.** The Management-API `dbPostgres` section only carries
> the GUCs Supabase exposes on `/config/database/postgres`. Settings applied directly in SQL via
> `ALTER ROLE ... SET` / `ALTER DATABASE ... SET` (e.g. `statement_timeout`, `auto_explain.*`,
> `pg_stat_statements.*`, `pgaudit.*`, `session_replication_role`) live in `pg_db_role_setting`
> and **config-sync cannot see them**. `doctor` reads `pg_db_role_setting` on both ends and warns
> about source overrides missing/differing on the target so you can re-apply them by hand. It does
> **not** auto-copy: compute-tuned values (`shared_buffers`, `work_mem`, `max_connections`, …) are
> flagged `[compute-tuned]` because copying them onto a smaller target causes instability — review
> before re-applying. CLI-only system overrides (`shared_buffers` et al. via `supabase
> postgres-config`) are likewise not synced; re-set them on the target if the source customised them.

> **A new Supabase project has a new JWT secret + anon/service keys.** Every existing user JWT
> and session is signed with the OLD secret, so all users must **re-login** after cutover.
> Update the app's database URL + keys to the new project as part of step 9e.

Storage objects and Edge Functions, if any, transfer separately:
- **Storage:** `bun start storage <localDir>` (skip if no buckets). The push auto-creates missing buckets but lands them **private** - restore public visibility (`update storage.buckets set public = true where id = '<bucket>';`) or public URLs return 400 "Bucket not found" (verified 2026-07-30).
- **Edge Functions:** the `functions` step (skip / `functions.enabled: false` if none).
- **OAuth providers:** re-enter each provider's client id/secret on the target's Auth settings.

### Org-level data is NOT migratable

Org settings, **members/roles**, and entitlements are read-only in the Management API — re-invite
the team by hand. Details in [`docs/MIGRATION-SCOPE.md` §D](MIGRATION-SCOPE.md). The only org-level
*action* is **claiming a project into a different org** (step 10a) — use it when the goal is "same
project, different org" rather than the new-project + replication path.

### 10a. (Optional) Claim a project into another org

```bash
bun start claim <org-slug> <claim-token>            # preview + gate only
bun start claim <org-slug> <claim-token> --confirm  # actually move it
```

Preview is the default: it fetches the claim token's preview, **fails closed** on API errors /
`valid=false` / an expired token, and warns (without blocking) on a plan **downgrade** or members
exceeding the target org's free-tier project limit. `--confirm` performs the `POST`. Generate the
claim token from the source project's dashboard. Members do **not** transfer either way.

---

## 11. Tear down replication objects

```bash
bun start teardown      # drops subscription → slot → publication, in the safe order
```

---

## 12. Abort / rollback — decision tree by phase

The rollback that's available depends on where you are. **The point of no return for a
lossless rollback is step 9e** (repointing the app at the target). Know which phase you're
in before you act.

### Phase A — before 9a (source still taking writes)

Abort is **free**. The source has served continuously and the target is a throwaway.

```bash
bun start teardown      # drops subscription → slot → publication; source untouched
# optionally delete the target project
```

### Phase B — after 9a, before 9e (writes stopped, app NOT yet repointed)

Still **lossless**: the target has taken zero application writes, so the source is current.
Roll back by simply not flipping the app:

```bash
bun start teardown      # remove replication objects
# re-enable application writes on the SOURCE and bring the app back up unchanged
```

This is the **last lossless rollback point** unless you set up reverse replication (below).

### Phase C — after 9e (app repointed, target taking writes) — POINT OF NO RETURN

Rolling straight back to the source now **loses every write the target took since 9e**,
because nothing replicates target → source. Your options, worst-case first:

1. **Roll forward** (preferred): fix the problem on the target. The source is already stale;
   it is no longer a clean fallback.
2. **Accept the loss window**: if the target took only a few minutes of writes and they're
   recoverable/negligible, repoint back to the source and manually re-apply what was lost.
   You **must never** then re-enable writes on both — pick one authoritative DB (split-brain).
3. **Lossless rollback** — only if you set up **reverse replication** at cutover (below).

### Optional: reverse replication for a lossless rollback window

If the migration is high-stakes and you want Phase C to stay lossless during a validation
window, establish target → source streaming **after** `reconcile` passes (9c) and **before**
you repoint the app (9e). Use a second config with the roles swapped and **`copyData: false`**
(the data already matches — you only want new changes to stream back):

```bash
# migrate.reverse.yaml: source.ref/target.ref swapped, distinct slot/publication/subscription
# names, replication.copyData: false. SOURCE_DB_URL/TARGET_DB_URL swapped in a reverse .env.
bun start -c migrate.reverse.yaml replicate    # target → source, streaming only (no copy)
```

Now writes to the new target also flow back to the old source. If you must roll back inside
the window: stop writes on the target, `bun start -c migrate.reverse.yaml cutover` (drain the
reverse lag), repoint the app to the source, and tear down both directions. Once you're
confident in the target, tear down the reverse path (§11 with the reverse config) and the old
project becomes a cold standby.

> Reverse replication requires the source to still satisfy the same preflight gates (wal_level,
> replica identity) it always had. It is **not** bidirectional/active-active: only one side
> ever takes application writes at a time. Its sole purpose is a clean escape hatch.

---

## 13. Post-migration verification

- `bun start reconcile` → `RECONCILE PASSED`.
- App health: exercise a representative write path and confirm it persists on the new project.
- Confirm authentication still works (migrated users) if you use Supabase Auth.
- Confirm any scheduled jobs (e.g. pg_cron) are present on the target (`select * from cron.job;`).
- Leave the old project paused (not deleted) for a few days as a safety net.

---


## Command reference (this tool)

| Command | What it does |
|---|---|
| `bun start run [--through P] [--json] [--confirm-writes-stopped] [--max-lag-wait SEC]` | autonomous pipeline (preflight->replicate->watch->reconcile[->cutover]); exit 0 iff the requested range passed. For CI/Lambda. |
| `bun start status [--json] [--require-synced]` | one-shot replication snapshot (sub state, srsubstate, slot active, WAL retained, lag) for a scheduled watcher |
| `bun start doctor [--source-only]` | automated readiness checklist (connection shape, reachability, wal_level, replica identity, reconcile hashColumns vs live schema, cross-schema FK deps, target version/grant/extensions/schema-loaded, extension version mismatches, foreign replication slots, custom `pg_db_role_setting` GUC overrides) |
| `bun start preflight` | read-only hard-gate checks; throws on failure |
| `bun start bootstrap [--confirm] [--all-schemas] [--with-auth-data] [--out-dir P]` | prepare the TARGET: enable extensions + restore roles + schema from source (Supabase-aware role/schema filter); `--with-auth-data` also loads the auth-schema row data (FK pre-step); preview unless `--confirm` |
| `bun start replicate` | publication + slot + subscription (starts initial copy) |
| `bun start watch` | poll initial-sync state + WAL-bloat watchdog |
| `bun start reconcile [--mode chunked|full] [--buckets N] [--max-examples N] [--out-dir P]` | checksum source vs target |
| `bun start cutover [--max-lag-wait SEC] [--out-dir P]` | drain lag to 0, resync owned sequences, drop subscription |
| `bun start teardown` | drop subscription/slot/publication safely (idempotent) |
| `bun start translate [--out-dir P] [--apply] [--sign-off] [--json]` | draft target Postgres DDL from a non-Postgres source (e.g. MySQL); never auto-applies; `--sign-off` ratifies the draft so cutover may proceed |
| `bun start config-sync [--dry-run]` | copy non-data config via Management API (secrets stripped) |
| `bun start verify [--fail-on error|warn|info] [--out-dir P] [--json]` | post-migration health gate: run Supabase advisors on the target, fail on lints |
| `bun start provision [--confirm]` | copy billable infra (compute size, PITR/IPv4, disk, backup schedule); preview unless `--confirm` |
| `bun start claim <org-slug> <token> [--confirm]` | org-level: move a project into another org (preview unless `--confirm`) |
| `bun start functions [--dry-run]` | transfer Edge Functions (skip if none) |
| `bun start storage <localDir> [--dry-run]` | push storage objects (skip if none) |
| `bun start guide <target> [--role source|target] [--json]` | enablement playbook for a migration source (managed PG provider or heterogeneous engine) |
| `bun start kb drift [--max-age-days N] [--json]` | flag KB items whose guidance hasn't been re-verified recently; exit 1 if stale items found |
| `bun start upgrade doctor [--to MAJOR] [--db-url URL] [--copy-mbps N] [--fixed-overhead-sec N]` | read-only major-upgrade readiness audit of the source |
| `bun start upgrade capture [--db-url URL] [--out-dir P] [--max-gb N] [--force] [--all-schemas] [--with-auth-data]` | dump roles + schema + data of the source into a local dir (input for `upgrade lab`) |
| `bun start upgrade lab [--from MAJOR] [--to MAJOR] [--runs N] [--capture-dir P] [--seed-gib N] [--image FLAVOR] [--from-image REF] [--to-image REF] [--prod-bytes N] [--keep] [--clean] [--work-dir P]` | Docker lab: time a real `pg_upgrade --link` N times on production-like data |
| `bun start upgrade verify [--include-managed] [--out-dir P] [--max-examples N]` | prove the upgraded cluster is data-identical: chunked-checksum reconcile |
| `bun start pgupgrade doctor [--to MAJOR] [--db-url URL] [--copy-mbps N] [--fixed-overhead-sec N]` | alias for `upgrade doctor` |
| `bun start pgupgrade capture [--db-url URL] [--out-dir P] [--max-gb N] [--force] [--all-schemas] [--with-auth-data]` | alias for `upgrade capture` |
| `bun start pgupgrade lab [--from MAJOR] [--to MAJOR] [--runs N] [--capture-dir P] [--seed-gib N] [--image FLAVOR] [--from-image REF] [--to-image REF] [--prod-bytes N] [--keep] [--clean] [--work-dir P]` | alias for `upgrade lab` |
| `bun start pgupgrade verify [--include-managed] [--out-dir P] [--max-examples N]` | alias for `upgrade verify` |
| `bun start rehearse upgrade doctor [--to MAJOR] [--db-url URL] [--copy-mbps N] [--fixed-overhead-sec N]` | alias for `upgrade doctor` (nested under rehearse) |
| `bun start rehearse upgrade capture [--db-url URL] [--out-dir P] [--max-gb N] [--force] [--all-schemas] [--with-auth-data]` | alias for `upgrade capture` (nested under rehearse) |
| `bun start rehearse upgrade lab [--from MAJOR] [--to MAJOR] [--runs N] [--capture-dir P] [--seed-gib N] [--image FLAVOR] [--from-image REF] [--to-image REF] [--prod-bytes N] [--keep] [--clean] [--work-dir P]` | alias for `upgrade lab` (nested under rehearse) |
| `bun start rehearse upgrade verify [--include-managed] [--out-dir P] [--max-examples N]` | alias for `upgrade verify` (nested under rehearse) |
| `bun start rehearse integration` | live replication/reconcile against a throwaway Docker Postgres pair |
| `bun start rehearse seed [--rows N] [--payload B]` | seed source data for rehearsal (batched, concurrent, server-side generation) |
| `bun start rehearse seed-size [--gib N] [--payload B] [--batch ROWS] [--concurrency N]` | seed to a target size in GiB |
| `bun start rehearse run [--gib N] [--payload B] [--batch ROWS] [--concurrency N] [--chaos SCENARIO] [--chaos-arg VALUE]` | full scale rehearsal in-tool: seed-to-size -> run -> fault gate -> teardown (throwaway pair) |
| `bun start rehearse chaos <scenario> [--arg VALUE]` | inject a fault scenario into the rehearsal pair |
| `bun start rehearse writer [--ledger P] [--interval MS] [--duration SEC]` | drive continuous write load with an append-only id ledger |
| `bun start sandbox up --org <id> [--rows N] [--payload B] [--src-region R] [--tgt-region R]` | create a throwaway Supabase source+target pair, seed the source, write `migrate.sandbox.yaml` + `.env.sandbox` for a hands-on rehearsal |
| `bun start sandbox status` | check sandbox status |
| `bun start sandbox down` | delete both sandbox projects + remove the generated files |

All commands take `-c <path>` for an alternate config (default `migrate.config.yaml`), and
`--env-file <path>` to load secrets from a specific file (default `.env` if present). The env
file is **authoritative over inherited shell variables** - pgmig warns when it overrides a
conflicting one, so a stale `SOURCE_DB_URL` exported in your shell can never silently point a
run at the wrong database. `--no-env-file` uses the inherited environment as-is.
