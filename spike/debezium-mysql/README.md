# Spike: MySQL → Debezium Server JDBC sink → Postgres (no Kafka)

**Status: PASS ✓** — proves the data-plane topology the `DebeziumEngine` (HETEROGENEOUS.md §3)
will lifecycle-manage, before sinking weeks into the runtime.

Question the spike answered: *can Debezium stream MySQL → Postgres with no Kafka cluster, via a
direct JDBC sink, the way `NativePgEngine` uses `CREATE SUBSCRIPTION`?* **Yes** — with caveats
that materially shape the engine.

## Run it

```bash
docker compose up --build -d   # ~8 min first time (image pulls + Maven dep resolution)
./verify.sh                    # asserts snapshot (4 rows) + CDC (insert → 5 rows)
docker compose down -v         # teardown
```

`verify.sh` proves both legs: the initial **snapshot** copies the 4 seeded `inventory.customers`
rows into Postgres, then a row INSERTed in MySQL streams through the binlog and **appears in
Postgres** (id 1005, Ada Lovelace).

## Topology

```
MySQL (binlog ROW+FULL)  ──▶  Debezium Server  ──▶  Postgres (target)
  example-mysql:3.0           [ MySQL source connector → JDBC sink ]    postgres:16
                              quay.io/debezium/server:3.6.0.Beta2
                              + debezium-server-jdbc + postgresql driver
```

No Kafka, no Zookeeper, no Connect cluster. One JVM process (`debezium`) that pgmig's engine
starts, watches, and tears down — the heterogeneous analogue of a Postgres subscription.

## Findings (these drive the DebeziumEngine design)

1. **The JDBC sink is a NEW, not-yet-GA feature.** `io.debezium:debezium-server-jdbc` exists on
   Maven Central only from **3.6.0.Alpha2** (latest 3.6.0.CR1); the stock `3.0.0.Final` image
   does **not** have it (it bundles 14 messaging sinks — kafka/kinesis/pubsub/redis/… — but no
   JDBC). The newest quay server *image* with it is `3.6.0.Beta2`.
   → **Engine impact:** pgmig either ships on a 3.6 pre-release, waits for 3.6 GA, or falls
   back to single-node Kafka Connect (GA, but reintroduces the Kafka dependency the design
   rejected). Track 3.6 GA before committing the runtime.

2. **Delivery guarantees are weaker than Kafka Connect.** The docs are explicit: Debezium
   Server's JDBC sink does **not** provide Kafka-Connect-grade offset management, exactly-once,
   or automatic error-handling/retries.
   → **Engine impact:** this is *why* pgmig's reconcile (count + per-column aggregates) and
   fail-closed cutover gate are load-bearing for the heterogeneous path, not optional. The
   engine cannot trust the sink to be exactly-once.

3. **Custom image is mandatory.** Two things must be added to the stock server image: the JDBC
   sink jars (finding #1) and the **target JDBC driver** (Debezium Server ships none). The
   `Dockerfile` + `jdbc-sink.pom.xml` here ARE that manifest — a Maven stage resolves
   `debezium-server-jdbc` + transitives + `postgresql`, copied into `/debezium/lib/`.

4. **Config lives at `config/application.properties`, not `conf/`.** Debezium Server 3.x uses
   Quarkus external config (`./config/application.properties` relative to CWD `/debezium`). The
   legacy `/debezium/conf` dir is empty and ignored. Mount the **file**, not the dir — `config/`
   also holds `lib/` + `metrics.yml` on the classpath.

5. **`${...}` placeholders collide with Quarkus.** The documented
   `collection.name.format=${source.table}` **cannot** be used: Quarkus/SmallRye pre-expands
   `${...}` as its own config-expression syntax, finds no `source.table`, yields null, and NPEs
   in `configToProperties`. Workaround used here: a `RegexRouter` SMT routes the topic to a bare
   table name with `$1` (no braces, survives). The engine's config renderer must escape or avoid
   `${}` in any Debezium naming placeholder.

6. **`schema.evolution=basic` only ADDs columns.** It auto-creates the target table and adds new
   columns, but never changes types, drops, or renames — "dangerous operations prohibited."
   → **Engine impact:** confirms pgmig must **pre-create** the target schema from the `guided`
   schema-translation draft (GUIDED-MIGRATION.md §7) and run the sink with `schema.evolution=none`
   in production. Relying on Debezium's auto-DDL would land MySQL `TINYINT(1)` etc. as the wrong
   Postgres types, bypassing the human-ratified decisions.

7. **No `ExtractNewRecordState` SMT needed.** The Debezium JDBC sink ingests native complex
   change events directly — one less moving part than other JDBC sinks require.

## What this does NOT cover (deferred to the engine build)

- Type-mapping fidelity (the §7 `schema_translation` gate) — spike used `basic` auto-DDL.
- Lag/offset monitoring for `watch` — Debezium Server exposes JMX/HTTP metrics; not wired here.
- The cutover write-stop gate + `IDENTITY` resync.
- SQL Server / Azure SQL source (CDC change-tables) — same sink, different source connector.
