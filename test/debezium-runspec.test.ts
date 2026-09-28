import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Secrets } from "../src/config.ts";
import { debeziumPlanFromConfig } from "../src/engine/debezium-config.ts";
import { debeziumRunSpec, type RunSpecOpts } from "../src/engine/debezium-runspec.ts";
import { DEBEZIUM_IMAGE } from "../src/engine/debezium-runtime.ts";

const plan = () =>
  debeziumPlanFromConfig(
    ConfigSchema.parse({
      source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["inventory.customers"], publication: "dbz" },
      reconcile: { tables: [{ name: "inventory.customers" }] },
      watchdog: {},
    }),
    {
      SOURCE_DB_URL: "mysql://debezium:dbz@mysqlhost:3306/inventory",
      TARGET_DB_URL: "postgresql://postgres:pgpw@pghost:5432/target",
    } as Secrets,
  );

const opts = (over: Partial<RunSpecOpts> = {}): RunSpecOpts => ({
  plan: plan(),
  configPath: "/run/pgmig/dbz/application.properties",
  dataVolume: "pgmig-dbz-data",
  ...over,
});

describe("debeziumRunSpec", () => {
  test("launches the pinned custom image, detached, named from the topic prefix", () => {
    const s = debeziumRunSpec(opts());
    expect(s.image).toBe(DEBEZIUM_IMAGE);
    expect(s.name).toBe("pgmig-dbz-dbz"); // pgmig-dbz-<topicPrefix>
    expect(s.argv.slice(0, 5)).toEqual(["docker", "run", "--detach", "--name", "pgmig-dbz-dbz"]);
    expect(s.argv.at(-1)).toBe(DEBEZIUM_IMAGE); // image is the final arg
  });

  test("mounts the rendered config read-only at the Quarkus path (finding #4)", () => {
    const s = debeziumRunSpec(opts());
    expect(s.mounts).toContainEqual({
      host: "/run/pgmig/dbz/application.properties",
      container: "/debezium/config/application.properties",
      readOnly: true,
    });
    expect(s.argv).toContain(
      "/run/pgmig/dbz/application.properties:/debezium/config/application.properties:ro",
    );
  });

  test("mounts a persistent rw volume at the plan's data dir (offset/schema-history survival)", () => {
    const s = debeziumRunSpec(opts());
    expect(s.mounts).toContainEqual({
      host: "pgmig-dbz-data",
      container: "/debezium/data", // plan.dataDir
      readOnly: false,
    });
    expect(s.argv).toContain("pgmig-dbz-data:/debezium/data");
  });

  test("publishes 8080 and exposes health + metrics URLs (default port)", () => {
    const s = debeziumRunSpec(opts());
    expect(s.publish).toEqual(["8080:8080"]);
    expect(s.healthUrl).toBe("http://localhost:8080/q/health");
    expect(s.metricsBaseUrl).toBe("http://localhost:8080");
  });

  test("remaps the published host port and reflects it in the URLs", () => {
    const s = debeziumRunSpec(opts({ metricsPort: 18080 }));
    expect(s.publish).toEqual(["18080:8080"]);
    expect(s.argv).toContain("18080:8080");
    expect(s.healthUrl).toBe("http://localhost:18080/q/health");
  });

  test("joins a docker network when given, omits the flag otherwise", () => {
    expect(debeziumRunSpec(opts({ network: "pgmig-net" })).argv).toContain("pgmig-net");
    expect(debeziumRunSpec(opts({ network: "pgmig-net" })).argv).toContain("--network");
    expect(debeziumRunSpec(opts()).argv).not.toContain("--network");
  });

  test("honours an image override (e.g. a locally rebuilt tag)", () => {
    const s = debeziumRunSpec(opts({ image: "ghcr.io/me/dbz:test" }));
    expect(s.image).toBe("ghcr.io/me/dbz:test");
    expect(s.argv.at(-1)).toBe("ghcr.io/me/dbz:test");
  });

  test("rejects a missing config path, data volume, or non-positive metrics port", () => {
    expect(() => debeziumRunSpec(opts({ configPath: "" }))).toThrow(/configPath/);
    expect(() => debeziumRunSpec(opts({ dataVolume: "" }))).toThrow(/dataVolume/);
    expect(() => debeziumRunSpec(opts({ metricsPort: 0 }))).toThrow(/positive integer/);
  });
});
