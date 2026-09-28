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
# Only the jars the stock image lacks land here; same-named same-version jars overwrite harmlessly.
COPY --from=deps /jars/ /debezium/lib/
# NB: stay as the base image's default user — the stock image runs as a numeric UID with no
# `debezium` passwd entry, so an explicit `USER debezium` makes `docker run` fail with
# "unable to find user debezium". The spike proved running as-is works.
