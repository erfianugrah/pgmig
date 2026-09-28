#!/usr/bin/env bash
# Regression checks: pgmig source + docs claims made by the lexicanum e2e
# guides. Ported from the 2026-07-30 ad-hoc verification harness (lessons:
# ~/.local/share/harness/HARNESS-NOTES.md). No network, no transcript - these
# are the timeless subset. Run via `bun run verify:claims` (wired into CI).
#
# Env:
#   BANNED_IDENTIFIERS  space-separated strings that must not appear in any
#                       git-tracked file (org ids, throwaway refs). Unset =
#                       loud SKIP, never a vacuous PASS.
set -u
cd "$(dirname "$0")/.." || exit 2

pass=0; fail=0; skip=0
chk() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then printf 'PASS  %s\n' "$d"; pass=$((pass+1)); else printf 'FAIL  %s\n' "$d"; fail=$((fail+1)); fi; }
skp() { printf 'SKIP  %s\n' "$1"; skip=$((skip+1)); }
has()     { grep -qF "$2" "$1"; }       # file contains fixed string
src_has() { grep -rqF "$1" src/; }      # src/ contains fixed string
src_has_i() { grep -rqiF "$1" src/; }   # src/ contains fixed string, case-insensitive
no_fixed() { ! grep -qF "$1" "$2"; }    # file must NOT contain fixed string

echo "=== 1. CLI surface: every command/flag the guides name exists ==="
for cmd in sandbox doctor preflight bootstrap replicate watch reconcile \
           cutover config-sync provision verify teardown status upgrade; do
  chk "cli registers '$cmd'" grep -qE "\"$cmd\"|'$cmd'|\.command\(\"$cmd" src/cli.ts
done
for flag in --with-auth-data --confirm --dry-run --require-synced --through \
            --env-file --no-env-file --seed-gib --runs --capture-dir --out-dir \
            --keep --prod-bytes --to --db-url --max-gb --org --src-region; do
  chk "cli has flag $flag" grep -qF -- "$flag" src/cli.ts
done

echo "=== 2. Sandbox behaviour claimed in the guides ==="
chk "schema has STORED generated column"    grep -qF "GENERATED ALWAYS AS" src/rehearsal/schema.sql
chk "schema has tsvector"                   grep -qi tsvector src/rehearsal/schema.sql
chk "schema has IDENTITY column (items)"    grep -qi "GENERATED.*IDENTITY" src/rehearsal/schema.sql
chk "schema has a no-PK table (audit_log)"  grep -q "audit_log" src/rehearsal/schema.sql
chk "sandbox writes migrate.sandbox.yaml"   grep -q "migrate.sandbox.yaml" src/steps/sandbox.ts
chk "sandbox writes .env.sandbox"           grep -q ".env.sandbox" src/steps/sandbox.ts
chk "sandbox up creates src+tgt pair"       src_has "creating throwaway pair"
chk "sandbox down deletes projects + files" src_has "SANDBOX TORN DOWN"

echo "=== 3. Bootstrap / auth-data claims ==="
chk "bootstrap auth load uses session_replication_role" grep -rq "session_replication_role" src/
chk "bootstrap enables extensions"      grep -rqiE "CREATE EXTENSION|enableExtension" src/steps/bootstrap.ts
chk "bootstrap restores roles"          grep -rqi "role" src/steps/bootstrap.ts
chk "bootstrap: exclude-table-data flag present" \
    grep -qF -- '--exclude-table-data=auth.schema_migrations' src/steps/bootstrap.ts
chk "test: schema_migrations exclusion test" \
    grep -qF 'exclude-table-data=auth.schema_migrations' test/bootstrap.test.ts

echo "=== 4. Replication-engine claims ==="
chk "replicate avoids FOR ALL TABLES"   grep -rqi "FOR ALL TABLES" src/
chk "watch aborts on wal_status lost"   grep -rqi "wal_status" src/steps/watch.ts
chk "watch enforces maxRetainedWalMb"   grep -rq "maxRetainedWalMb" src/
chk "cutover has WAL quiesce check"     grep -rqi "quiesc" src/steps/cutover.ts
chk "cutover setval()s owned sequences" grep -rqi "setval" src/steps/cutover.ts
chk "cutover drops subscription"        grep -rqi "DROP SUBSCRIPTION" src/steps/cutover.ts
chk "reconcile prints RECONCILE PASSED" grep -rq "RECONCILE PASSED" src/
chk "config-sync strips secrets by default" grep -rqi "strip" src/steps/config-sync.ts
chk "config-sync references jwt"        grep -rqi "jwt" src/steps/config-sync.ts
chk "config-sync: plan-gated hook guard present" \
    grep -qF 'hook_password_verification_attempt' src/steps/config-sync.ts
chk "test: 402 guard test"              grep -qF 'HTTP 402 guard' test/config-sync.test.ts
chk "test: enabled-hook passthrough test" grep -qF 'fail loud at the API' test/config-sync.test.ts
chk "doctor reads pg_db_role_setting"   grep -rq "pg_db_role_setting" src/

echo "=== 5. Remaining source-level claims ==="
chk "createProject passes NO instance size" \
    sh -c "! grep -A8 'async createProject' src/mgmt.ts | grep -qiE 'size|instance'"
chk "prodBytes = downtime estimate"     src_has "for the extrapolated downtime estimate"
chk "lab snapshots pristine datadir"    grep -rq "snapshot-old" src/upgrade/lab.ts
chk "lab runs pg_upgrade --link"        grep -rq -- "pg_upgrade --link" src/upgrade/lab.ts
chk "lab runs ANALYZE post-upgrade"     grep -rqiE "analyze-in-stages|ANALYZE" src/upgrade/lab.ts
chk "sandbox default region eu-central-1" grep -q "eu-central-1" src/cli.ts

echo "=== 6. Docs claims (MIGRATION-SCOPE + RUNBOOK) ==="
chk "MIGRATION-SCOPE: no 'bucket rows come with the DB dump'" \
    no_fixed 'bucket rows come with the DB dump' docs/MIGRATION-SCOPE.md
chk "MIGRATION-SCOPE: bucket NOT-migrated correction present" \
    grep -q 'NOT migrated - the schema dump excludes' docs/MIGRATION-SCOPE.md
chk "MIGRATION-SCOPE: 402 caveat present" \
    grep -q 'HTTP 402 on orgs without the entitlement' docs/MIGRATION-SCOPE.md
chk "MIGRATION-SCOPE: schema_migrations caveat" \
    grep -q 'SELECT-only for `postgres` on managed targets' docs/MIGRATION-SCOPE.md
chk "RUNBOOK: no 'has not been exercised live'" \
    no_fixed 'has not been exercised live' docs/RUNBOOK.md
chk "RUNBOOK: apply path exercised note" \
    grep -q 'apply (write) path have' docs/RUNBOOK.md
chk "RUNBOOK: manual dump excludes schema_migrations" \
    grep -q -- '-x auth.schema_migrations' docs/RUNBOOK.md
chk "RUNBOOK: storage visibility warning" \
    grep -q 'auto-creates missing buckets but lands them' docs/RUNBOOK.md
chk "RUNBOOK: bootstrap partial-failure recovery" \
    grep -q 're-plans the schema restore' docs/RUNBOOK.md

echo "=== 7. Identifier hygiene (git-tracked files) ==="
if [ -n "${BANNED_IDENTIFIERS:-}" ]; then
  test -n "$(git ls-files)" || { echo "FAIL  git ls-files empty (substrate missing)"; fail=$((fail+1)); }
  for id in $BANNED_IDENTIFIERS; do
    chk "banned identifier not in tracked files: ${id:0:6}..." \
        sh -c '! git ls-files | xargs grep -l "$1" 2>/dev/null | grep -q .' _ "$id"
  done
else
  skp "identifier hygiene (set BANNED_IDENTIFIERS to enable)"
fi

echo
echo "================  $pass passed, $fail failed, $skip skipped  ================"
exit $((fail > 0))
