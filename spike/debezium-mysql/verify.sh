#!/usr/bin/env bash
# Proves the data plane end to end:
#   1. snapshot — Debezium copies the 4 seeded inventory.customers rows into Postgres
#   2. CDC      — a row INSERTed in MySQL appears in Postgres via the binlog stream
set -euo pipefail
cd "$(dirname "$0")"

pg() { docker compose exec -T postgres psql -U postgres -d target -tAc "$1"; }
my() { docker compose exec -T mysql mysql -uroot -pdebezium -N inventory -e "$1" 2>/dev/null; }

echo "── waiting for Debezium snapshot to land the target table ──"
for i in $(seq 1 40); do
  if pg "SELECT to_regclass('public.customers')" | grep -q customers; then break; fi
  sleep 3
done

snap=$(pg "SELECT count(*) FROM customers")
echo "snapshot rows in Postgres.customers: ${snap}  (expect 4)"

echo "── inserting a new row in MySQL (CDC path) ──"
my "INSERT INTO customers (first_name,last_name,email) VALUES ('Ada','Lovelace','ada@pgmig.dev')"

echo "── waiting for the CDC row to stream through ──"
for i in $(seq 1 20); do
  n=$(pg "SELECT count(*) FROM customers WHERE email='ada@pgmig.dev'")
  if [ "$n" = "1" ]; then break; fi
  sleep 2
done

final=$(pg "SELECT count(*) FROM customers")
echo "final rows in Postgres.customers: ${final}  (expect 5)"
pg "SELECT id,first_name,last_name,email FROM customers ORDER BY id"

if [ "$final" = "5" ]; then echo "SPIKE PASS ✓"; else echo "SPIKE FAIL ✗"; exit 1; fi
