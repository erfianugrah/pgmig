# pgmig DebeziumEngine image - Debezium Server + the no-Kafka JDBC sink + the Postgres driver.
#
# This is the production image the DebeziumEngine runs (the heterogeneous data plane,
# HETEROGENEOUS.md §3). Built from the spike-proven manifest (spike/debezium-mysql/), promoted
# to a maintained asset. Tag it to match the pin: `pgmig/debezium-server:3.6.3.Final`
# (src/engine/debezium-runtime.ts: DEBEZIUM_IMAGE / DEBEZIUM_SERVER_VERSION).
#
# Two things the stock server image lacks and this image adds (spike finding #3):
#  - the JDBC sink (`debezium-server-jdbc`) — the base image bundles 14 messaging sinks
#    (kafka/kinesis/pubsub/redis/…) but NOT the JDBC sink; resolved via Maven below.
#  - the target DB driver — Debezium Server ships none ("add the driver to lib/"); the pom pulls it.
#
# Version alignment (HETEROGENEOUS.md §5 decision): the sink jar version MUST match the server
# core in the FROM image. As of 2026-07-01 the 3.6.0.CR1 server image + matching CR1 sink jar both
# ship (re-pinned Beta2 -> CR1), so both are pinned at CR1 with no skew. 3.6.0.Final is still
# unscheduled. Re-pin both together to Final when a matching image+jar pair ships.

# 2026-09-28: re-pinned CR1 -> 3.6.3.Final (fixes Quarkus/Vert.x NoSuchMethodError at startup).

FROM maven:3.9-eclipse-temurin-21 AS deps
WORKDIR /build
COPY jdbc-sink.pom.xml pom.xml
RUN mvn -q -B dependency:copy-dependencies -DoutputDirectory=/jars -DincludeScope=runtime

FROM quay.io/debezium/server:3.6.3.Final
USER root
# Only artifacts the stock image LACKS are added. copy-dependencies resolves the sink's whole
# runtime tree, which overlaps ~70 artifacts the server already ships at other versions
# (mutiny 3.0.1 vs 3.1.1, vertx-core 4.5.24 vs 4.5.27, netty, smallrye-common, ...); copying
# them all put two versions of each on the classpath and Quarkus intermittently loaded the
# wrong one (NoSuchMethodError on mutiny Infrastructure.setDefaultExecutor, CI runs 17/18,
# 2026-11). The server's copy wins for every shared artifact.
COPY --from=deps /jars/ /tmp/sink-jars/
RUN set -e; added=0; \
    for j in /tmp/sink-jars/*.jar; do \
      a=$(basename "$j" | sed -E 's/-[0-9][0-9A-Za-z._-]*\.jar$//'); \
      if ! ls /debezium/lib/"$a"-[0-9]*.jar >/dev/null 2>&1; then cp "$j" /debezium/lib/; added=$((added+1)); fi; \
    done; \
    rm -rf /tmp/sink-jars; echo "added $added sink-only jars"; \
    ls /debezium/lib/debezium-server-jdbc-*.jar /debezium/lib/postgresql-*.jar
# NB: stay as the base image's default user — the stock image runs as a numeric UID with no
# `debezium` passwd entry, so an explicit `USER debezium` makes `docker run` fail with
# "unable to find user debezium". The spike proved running as-is works.
