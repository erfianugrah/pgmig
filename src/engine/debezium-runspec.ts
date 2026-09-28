/**
 * Renders the single-container `docker run` invocation for the Debezium Server process the
 * `DebeziumEngine` lifecycle-manages — the production analogue of the spike's docker-compose
 * `debezium` service (spike/debezium-mysql/docker-compose.yml). Pure: no IO, no spawn, just
 * structured data + argv, so the spike's proven topology is encoded as testable code (the same
 * de-risking pattern as `renderDebeziumServerConfig`).
 *
 * Production differs from the spike on two axes, both grounded in the spike, not invented:
 *  - The spike's `mysql` + `postgres` services do NOT exist here — in production those are the
 *    real source/target, reached over the network via the rendered application.properties. This
 *    spec launches ONLY the debezium container.
 *  - The spike let `/debezium/data` (offsets + schema-history — `*.dat`) live on the container's
 *    ephemeral filesystem, fine for a throwaway. Production mounts a persistent volume there: a
 *    restart that lost the offset file would re-snapshot the whole source from scratch.
 */

import type { DebeziumPlan } from "./debezium-config.ts";
import { DEBEZIUM_IMAGE } from "./debezium-runtime.ts";

/** Quarkus reads external config from `./config/application.properties` under CWD `/debezium`
 *  (spike finding #4 — mount the FILE, not the dir, which also holds lib/ + metrics.yml). */
const CONFIG_PATH_IN_CONTAINER = "/debezium/config/application.properties";

/** Debezium Server's Quarkus HTTP port (health at `/q/health`, metrics scraped by `watch`). */
const QUARKUS_PORT = 8080;

/** The container name for a migration, derived from the topic prefix (a bare ident). Stable so
 *  `replicate` and `teardown` address the same container without sharing state. */
export function debeziumContainerName(topicPrefix: string): string {
  return `pgmig-dbz-${topicPrefix}`;
}

/** The default persistent volume backing the data dir (offsets + schema-history) for a migration. */
export function debeziumDataVolume(topicPrefix: string): string {
  return `${debeziumContainerName(topicPrefix)}-data`;
}

/** `docker stop` argv for a migration's container. */
export function debeziumStopArgv(name: string): string[] {
  return ["docker", "stop", name];
}

/** `docker rm` argv (force, so a stopped-or-running container is removed idempotently). */
export function debeziumRmArgv(name: string): string[] {
  return ["docker", "rm", "-f", name];
}

/** `docker volume rm` argv for the persistent offset/schema-history volume. */
export function debeziumVolumeRmArgv(volume: string): string[] {
  return ["docker", "volume", "rm", volume];
}

export interface BindMount {
  host: string;
  container: string;
  readOnly: boolean;
}

export interface DebeziumRunSpec {
  image: string;
  /** Container name — the engine's `watch`/`teardown` address the process by this. */
  name: string;
  mounts: BindMount[];
  /** Published port maps, `host:container` (the Quarkus endpoint). */
  publish: string[];
  /** Quarkus health endpoint for `doctor`/startup readiness. */
  healthUrl: string;
  /** Base URL the `watch` step scrapes for connector lag / sink offset metrics. */
  metricsBaseUrl: string;
  /** The full detached `docker run` argv, ready to spawn. */
  argv: string[];
}

export interface RunSpecOpts {
  plan: DebeziumPlan;
  /** Host path of the rendered application.properties (mounted read-only at the Quarkus path). */
  configPath: string;
  /** Host path / named volume backing `plan.dataDir` (offset + schema-history persistence). */
  dataVolume: string;
  /** Container name. Default `pgmig-dbz-<topicPrefix>`. */
  name?: string;
  /** Host port to publish the container's 8080 on (health + metrics). Default 8080. */
  metricsPort?: number;
  /** Docker network the container joins to reach the source/target hosts. Optional. */
  network?: string;
  /** Image override (default the pinned {@link DEBEZIUM_IMAGE}). */
  image?: string;
}

/**
 * Build the run-spec for a Debezium container from a rendered {@link DebeziumPlan} plus the host
 * paths pgmig staged (the properties file + the data volume). The container needs no command
 * args — Debezium Server auto-loads `./config/application.properties`.
 */
export function debeziumRunSpec(opts: RunSpecOpts): DebeziumRunSpec {
  const { plan, configPath, dataVolume } = opts;
  if (!configPath)
    throw new Error("debeziumRunSpec: configPath (rendered properties file) is required");
  if (!dataVolume)
    throw new Error("debeziumRunSpec: dataVolume (offset/schema-history persistence) is required");
  const metricsPort = opts.metricsPort ?? QUARKUS_PORT;
  if (!Number.isInteger(metricsPort) || metricsPort <= 0) {
    throw new Error(`debeziumRunSpec: metricsPort must be a positive integer, got ${metricsPort}`);
  }
  const image = opts.image ?? DEBEZIUM_IMAGE;
  const name = opts.name ?? debeziumContainerName(plan.topicPrefix);

  const mounts: BindMount[] = [
    // the rendered config, read-only — contains secrets, never written by the container
    { host: configPath, container: CONFIG_PATH_IN_CONTAINER, readOnly: true },
    // offsets + schema-history, read-write + persistent (plan.dataDir is where the config writes them)
    { host: dataVolume, container: plan.dataDir, readOnly: false },
  ];
  const portMap = `${metricsPort}:${QUARKUS_PORT}`;
  const publish = [portMap];

  const argv = [
    "docker",
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    portMap,
    ...mounts.flatMap((m) => ["--volume", `${m.host}:${m.container}${m.readOnly ? ":ro" : ""}`]),
    ...(opts.network ? ["--network", opts.network] : []),
    image,
  ];

  return {
    image,
    name,
    mounts,
    publish,
    healthUrl: `http://localhost:${metricsPort}/q/health`,
    metricsBaseUrl: `http://localhost:${metricsPort}`,
    argv,
  };
}
