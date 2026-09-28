/**
 * The Debezium runtime pin — the resolved "delivery-vehicle decision" the spike left open
 * (spike/debezium-mysql/README.md finding #1, HETEROGENEOUS.md §5).
 *
 * DECISION (2026-06-24): pin a 3.6 PRE-RELEASE (the no-Kafka JDBC sink is 3.6-only and not yet
 * GA), NOT wait for GA, NOT fall back to Kafka Connect.
 *
 * Evidence gathered the day of the decision:
 *  - `io.debezium:debezium-server-jdbc` on Maven Central: newest = 3.6.0.CR1, no 3.6.0.Final
 *    (`maven-metadata.xml` lastUpdated 2026-06-23). The sink exists ONLY from 3.6.0.Alpha2.
 *  - quay.io/debezium/server images: the 3.6 line was published only up to **3.6.0.Beta2** (no
 *    CR1 / Final image); the newest GA `Final` overall is 3.5.2.Final, which has NO JDBC sink.
 *  - Therefore "wait for GA" is blocked (3.6 GA is unscheduled; CR1 jar only landed 2026-06-23),
 *    and "fall back to single-node Kafka Connect" reintroduces the Kafka dependency the whole
 *    no-Kafka design (HETEROGENEOUS.md §1) rejected.
 *
 * The custom image layers the JDBC-sink jar onto the stock server image (finding #3), so the sink
 * jar version must MATCH the server-core version in the base image. On 2026-06-24 the base image
 * topped out at Beta2 with no CR1 image, so both were pinned at Beta2 (a CR1 jar on a Beta2 core
 * would have been an unsupported skew).
 *
 * RE-PIN (2026-07-01): `quay.io/debezium/server:3.6.0.CR1` has since shipped and the matching
 * `debezium-server-jdbc:3.6.0.CR1` jar is on Maven Central, so the matched image+jar pair now
 * exists at CR1 - one step closer to GA with no core/sink skew. Re-pinned Beta2 -> CR1. 3.6.0.Final
 * is still unscheduled (no Final image, no Final jar), so this stays a pre-release and
 * DEBEZIUM_RUNTIME_GA stays false. Re-pin CR1 -> Final when a matching Final image+jar pair ships.
 *
 * RE-PIN (2026-09-28): `3.6.3.Final` ships as a matched image+jar pair and fixes a
 * `NoSuchMethodError` on Vert.x `setFileCacheDirAsExactPath` that CR1's Quarkus/Vert.x combo
 * hits at startup. Re-pinned CR1 -> 3.6.3.Final. DEBEZIUM_RUNTIME_GA stays false (still pre-GA).
 *
 * Why a pre-release is acceptable at all: finding #2 — Debezium Server's JDBC sink gives weaker
 * delivery guarantees than Kafka Connect (no exactly-once, no offset management, no auto-retry).
 * pgmig therefore NEVER trusts the sink: the count + per-column-aggregate reconcile and the
 * fail-closed cutover gate are load-bearing for the heterogeneous path. That distrust is
 * independent of GA status, so a pre-release build changes the support label, not the safety model.
 */

/** The Debezium Server core + JDBC-sink version the engine runs. Pre-GA, image+jar aligned. */
export const DEBEZIUM_SERVER_VERSION = "3.6.3.Final";

/**
 * The custom engine image tag, built from `images/debezium-server/` (the stock server image +
 * the JDBC-sink jars + the Postgres driver layered in — finding #3). Tagged with the pinned
 * version so the build and the runtime can never silently diverge.
 */
export const DEBEZIUM_IMAGE = `pgmig/debezium-server:${DEBEZIUM_SERVER_VERSION}`;

/** Maven coordinates of the no-Kafka JDBC sink (must be layered into a custom image — finding #3). */
export const DEBEZIUM_JDBC_SINK_ARTIFACT = "io.debezium:debezium-server-jdbc";

/** The PostgreSQL JDBC driver the sink writes through (server image ships none — finding #3). */
export const DEBEZIUM_TARGET_DRIVER = "org.postgresql:postgresql:42.7.4";

/** False until 3.6.0.Final ships. Gates any "production-supported" claim in CLI/docs output. */
export const DEBEZIUM_RUNTIME_GA = false;

/**
 * One-line provenance string for logs / `doctor` output / the not-implemented error, so the
 * pre-release pin is always visible to an operator rather than buried in a constant.
 */
export function debeziumRuntimePin(): string {
  return `Debezium Server ${DEBEZIUM_SERVER_VERSION} (${DEBEZIUM_JDBC_SINK_ARTIFACT}, pre-GA — no-Kafka JDBC sink)`;
}
