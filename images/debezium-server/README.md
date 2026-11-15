# pgmig DebeziumEngine image

The production container image for the heterogeneous data plane (`DebeziumEngine`,
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §3): Debezium Server + the no-Kafka JDBC
sink + the Postgres driver. Promoted from the proven spike (`spike/debezium-mysql/`) to a
maintained asset.

## Build

```bash
docker build -t pgmig/debezium-server:3.6.3.Final images/debezium-server/
```

The tag must match the pin in [`src/engine/debezium-runtime.ts`](../../src/engine/debezium-runtime.ts)
(`DEBEZIUM_IMAGE` / `DEBEZIUM_SERVER_VERSION`) — the engine's run-spec
([`src/engine/debezium-runspec.ts`](../../src/engine/debezium-runspec.ts)) launches exactly this
tag.

## What it adds over the stock image (spike finding #3)

| Layer | Why |
|---|---|
| `debezium-server-jdbc` + transitive deps | The stock image bundles 14 messaging sinks (kafka/kinesis/pubsub/redis/...) but **no** JDBC sink. |
| `org.postgresql:postgresql` driver | Debezium Server ships **no** target-DB driver ("add the driver to `lib/`"). |

A Maven stage resolves `jdbc-sink.pom.xml`. The Dockerfile then adds **only** the artifacts
the stock server image lacks (~22 jars at 3.6.3.Final) -- not the whole runtime tree. ~70
artifacts overlap at different versions (mutiny 3.0.1 vs 3.1.1, vertx-core 4.5.24 vs 4.5.27,
netty); copying them all put two versions of each on the classpath and Quarkus intermittently
failed at startup with `NoSuchMethodError`.

## Version pin

`debezium-server-jdbc` and the `FROM` server image are pinned **together** at `3.6.3.Final`. The
JDBC sink is a 3.6-only, not-yet-GA feature; both the `3.6.3.Final` server *image* and the matching
`3.6.3.Final` sink *jar* now ship as a matched pair (re-pinned Beta2 -> CR1 on 2026-07-01, CR1 ->
3.6.3.Final on 2026-09-28), so there is no core/sink skew. `DEBEZIUM_RUNTIME_GA` stays `false`
(the JDBC sink is still not GA-supported). Re-pin when the sink graduates.

## How the engine runs it

The engine stages the rendered `application.properties`
([`debezium-config.ts`](../../src/engine/debezium-config.ts)) and a persistent data volume, then
launches one detached container per the run-spec:

- the properties file is mounted **read-only** at `/debezium/config/application.properties`
  (Quarkus external config — mount the file, not the dir, spike finding #4);
- a persistent volume backs `/debezium/data` (offset + schema-history `*.dat`) so a restart does
  not re-snapshot the whole source;
- the Quarkus port `8080` is published for the health endpoint (`/q/health`) used by the `watch`
  step to verify connector liveness; this image ships **no** `/q/metrics` endpoint (404), so
  health + count-convergence are the observable sync-complete signals.

The container needs no command args — Debezium Server auto-loads `./config/application.properties`.
