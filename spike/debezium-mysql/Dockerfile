# Debezium Server + the JDBC sink adapter + the PostgreSQL driver.
#
# SPIKE FINDINGS baked in here:
#  - The base image ships NO JDBC sink (debezium-server-jdbc is absent — only messaging sinks
#    like kafka/kinesis/redis are bundled). We resolve it + its transitive deps via Maven.
#  - The base image ships NO target-DB driver (docs: "add the driver to lib/"). Pulled by the pom.
# This stage's /jars is the exact extra-jar manifest pgmig's production DebeziumEngine image
# needs over the stock server image.
FROM maven:3.9-eclipse-temurin-21 AS deps
WORKDIR /build
COPY jdbc-sink.pom.xml pom.xml
RUN mvn -q -B dependency:copy-dependencies -DoutputDirectory=/jars -DincludeScope=runtime

FROM quay.io/debezium/server:3.6.0.Beta2
USER root
# Only the jars the stock image lacks land here; same-named same-version jars overwrite harmlessly.
COPY --from=deps /jars/ /debezium/lib/
