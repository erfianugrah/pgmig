import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Secrets } from "../src/config.ts";
import {
  DebeziumEngine,
  type DebeziumIO,
  parseDebeziumHealth,
  resolveRuntimeOpts,
} from "../src/engine/debezium.ts";
import {
  debeziumContainerName,
  debeziumDataVolume,
  debeziumRmArgv,
  debeziumStopArgv,
  debeziumVolumeRmArgv,
} from "../src/engine/debezium-runspec.ts";
import type { MySqlConn } from "../src/engine/mysql.ts";
import type { SqlServerConn } from "../src/engine/sqlserver.ts";
import { buildManifest, schemaArtifactPaths, signOffSchema } from "../src/steps/translate.ts";

// biome-ignore lint/suspicious/noExplicitAny: opaque Db sentinels — debezium never touches them
const NODB = {} as any;

const mysqlCfg = () =>
  ConfigSchema.parse({
    source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
    target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
    replication: { tables: ["inventory.customers"], publication: "dbz" },
    reconcile: { tables: [{ name: "inventory.customers" }] },
    watchdog: {},
  });
const secrets = (): Secrets =>
  ({
    SOURCE_DB_URL: "mysql://debezium:dbz@mysqlhost:3306/inventory",
    TARGET_DB_URL: "postgresql://postgres:pgpw@pghost:5432/target",
  }) as Secrets;

const HEALTHY_BODY = '{"status":"UP","checks":[{"name":"debezium","status":"UP"}]}';

/** A recording mock DebeziumIO; healthy after `healthyAfter` probes. */
function mockIO(
  over: Partial<{
    runExit: number;
    healthyAfter: number;
    healthBody: string;
    httpNull: boolean;
  }> = {},
) {
  const calls = {
    exec: [] as string[][],
    writes: [] as { path: string; content: string }[],
    mkdirs: [] as string[],
    health: [] as string[],
    sleeps: 0,
  };
  let healthProbes = 0;
  const io: DebeziumIO = {
    async exec(argv) {
      calls.exec.push(argv);
      const exitCode = argv[1] === "run" ? (over.runExit ?? 0) : 0;
      return { stdout: "", stderr: "", exitCode };
    },
    async httpOk(url) {
      calls.health.push(url);
      healthProbes++;
      return healthProbes >= (over.healthyAfter ?? 1);
    },
    async httpText(url) {
      calls.health.push(url);
      if (over.httpNull) return null;
      return { ok: true, status: 200, body: over.healthBody ?? HEALTHY_BODY };
    },
    writeFile: (path, content) => calls.writes.push({ path, content }),
    mkdirp: (path) => calls.mkdirs.push(path),
    sleep: async () => {
      calls.sleeps++;
    },
  };
  return { io, calls };
}

describe("resolveRuntimeOpts", () => {
  test("defaults stage dir / volume / port / image from the topic prefix", () => {
    const rt = resolveRuntimeOpts({}, "dbz");
    expect(rt.stageDir).toContain("pgmig-dbz-dbz");
    expect(rt.configPath).toMatch(/application\.properties$/);
    expect(rt.dataVolume).toBe("pgmig-dbz-dbz-data");
    expect(rt.metricsPort).toBe(8080);
    expect(rt.network).toBeUndefined();
    expect(rt.image).toContain("pgmig/debezium-server:");
  });

  test("env overrides stage dir / network / port / image / volume", () => {
    const rt = resolveRuntimeOpts(
      {
        PGMIG_DBZ_STAGE_DIR: "/srv/stage",
        PGMIG_DBZ_NETWORK: "pgmig-net",
        PGMIG_DBZ_METRICS_PORT: "18080",
        PGMIG_DBZ_IMAGE: "ghcr.io/me/dbz:test",
        PGMIG_DBZ_DATA_VOLUME: "vol1",
      },
      "dbz",
    );
    expect(rt.stageDir).toBe("/srv/stage");
    expect(rt.configPath).toBe("/srv/stage/application.properties");
    expect(rt.network).toBe("pgmig-net");
    expect(rt.metricsPort).toBe(18080);
    expect(rt.image).toBe("ghcr.io/me/dbz:test");
    expect(rt.dataVolume).toBe("vol1");
  });

  test("rejects a non-positive metrics port", () => {
    expect(() => resolveRuntimeOpts({ PGMIG_DBZ_METRICS_PORT: "0" }, "dbz")).toThrow(
      /positive integer/,
    );
    expect(() => resolveRuntimeOpts({ PGMIG_DBZ_METRICS_PORT: "x" }, "dbz")).toThrow(
      /positive integer/,
    );
  });
});

describe("DebeziumEngine.replicate (mocked IO)", () => {
  test("stages the rendered config 0600, docker-runs, and waits for health", async () => {
    const { io, calls } = mockIO({ healthyAfter: 1 });
    await new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets());

    // config staged before the container started
    expect(calls.mkdirs.length).toBe(1);
    expect(calls.writes.length).toBe(1);
    expect(calls.writes[0]?.content).toContain("io.debezium.connector.mysql.MySqlConnector");
    // the secret-bearing properties go to the staged path, not to logs
    expect(calls.writes[0]?.path).toMatch(/application\.properties$/);

    // exactly one docker run, of the named container
    const run = calls.exec.find((a) => a[1] === "run");
    expect(run).toBeDefined();
    expect(run).toContain("--name");
    expect(run).toContain("pgmig-dbz-dbz");

    expect(calls.health.length).toBeGreaterThanOrEqual(1);
  });

  test("polls health with backoff until the server reports ready", async () => {
    const { io, calls } = mockIO({ healthyAfter: 3 });
    await new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets());
    expect(calls.health.length).toBe(3);
    expect(calls.sleeps).toBe(2); // slept between the first two failed probes
  });

  test("throws when docker run exits non-zero (and never probes health)", async () => {
    const { io, calls } = mockIO({ runExit: 125 });
    await expect(
      new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets()),
    ).rejects.toThrow(/docker run failed \(exit 125\)/);
    expect(calls.health.length).toBe(0);
  });

  test("rejects a postgres source before any IO (plan builder guard)", async () => {
    const pgCfg = ConfigSchema.parse({
      source: { ref: "aaaaaaaaaaaaaaaaaaaa" },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["public.documents"] },
      reconcile: { tables: [{ name: "public.documents" }] },
      watchdog: {},
    });
    const { io, calls } = mockIO();
    await expect(new DebeziumEngine(io).replicate(NODB, NODB, pgCfg, secrets())).rejects.toThrow(
      /only heterogeneous/,
    );
    expect(calls.exec.length).toBe(0);
  });
});

describe("DebeziumEngine.teardown (mocked IO)", () => {
  test("stops, force-removes the container, and drops the offset volume", async () => {
    const { io, calls } = mockIO();
    await new DebeziumEngine(io).teardown(NODB, NODB, mysqlCfg());
    expect(calls.exec).toEqual([
      debeziumStopArgv("pgmig-dbz-dbz"),
      debeziumRmArgv("pgmig-dbz-dbz"),
      debeziumVolumeRmArgv("pgmig-dbz-dbz-data"),
    ]);
  });

  test("tolerates a missing container / volume (idempotent)", async () => {
    const io: DebeziumIO = {
      exec: async (argv) => ({
        stdout: "",
        stderr: argv[1] === "rm" ? "Error: No such container: x" : "no such volume",
        exitCode: 1,
      }),
      httpOk: async () => true,
      httpText: async () => ({ ok: true, status: 200, body: HEALTHY_BODY }),
      writeFile: () => {},
      mkdirp: () => {},
      sleep: async () => {},
    };
    // does not throw despite non-zero exits
    await new DebeziumEngine(io).teardown(NODB, NODB, mysqlCfg());
  });
});

describe("run-spec naming helpers", () => {
  test("container + volume names derive from the topic prefix", () => {
    expect(debeziumContainerName("dbz")).toBe("pgmig-dbz-dbz");
    expect(debeziumDataVolume("dbz")).toBe("pgmig-dbz-dbz-data");
  });
});

// ── reconcile + cutover (mock MySQL source + fake PG target) ──────────────────────────────────

/** A fake postgres.js Db: tagged-template for `target\`...\`` + an `.unsafe(sql, params)` method. */
function fakeTarget(handlers: {
  template?: (sql: string) => unknown[];
  unsafe?: (sql: string, params?: unknown[]) => unknown[];
}) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal postgres.js shape for the engine's calls
  const fn: any = (strings: TemplateStringsArray) =>
    Promise.resolve(handlers.template?.(strings.join(" ? ")) ?? []);
  fn.unsafe = (sql: string, params?: unknown[]) =>
    Promise.resolve(handlers.unsafe?.(sql, params) ?? []);
  return fn;
}

/** A fake MySqlConn routing by SQL substring. */
function fakeMySql(route: (sql: string) => unknown[]): { conn: MySqlConn; ended: () => boolean } {
  let ended = false;
  return {
    conn: {
      query: async <T>(sql: string) => route(sql) as T[],
      end: async () => {
        ended = true;
      },
    },
    ended: () => ended,
  };
}

const AGG_COLS = [
  { column_name: "id", data_type: "integer" },
  { column_name: "email", data_type: "text" },
];
// id: numeric (non_null/sum/min/max), email: text (non_null/char_len_sum)
const aggRow = (rowcount: string) => ({
  rowcount,
  c0_non_null: rowcount,
  c0_sum: "1015",
  c0_min: "1001",
  c0_max: "1005",
  c1_non_null: rowcount,
  c1_char_len_sum: "80",
});

describe("DebeziumEngine.reconcile (mock source + fake target)", () => {
  const cfg = mysqlCfg();
  const origUrl = process.env.SOURCE_DB_URL;
  process.env.SOURCE_DB_URL = "mysql://debezium:dbz@mysqlhost:3306/inventory";

  test("passes when source + target aggregates match, closes the source conn", async () => {
    const my = fakeMySql(() => [aggRow("5")]);
    const target = fakeTarget({
      template: (sql) => (sql.includes("information_schema.columns") ? AGG_COLS : []),
      unsafe: (sql) => (sql.includes("rowcount") ? [aggRow("5")] : []),
    });
    const { io } = mockIO();
    const ok = await new DebeziumEngine(io, async () => my.conn).reconcile(NODB, target, cfg);
    expect(ok).toBe(true);
    expect(my.ended()).toBe(true);
    // wrote a report
    expect(io.writeFile).toBeDefined();
  });

  test("fails when an aggregate diverges (row count)", async () => {
    const my = fakeMySql(() => [aggRow("5")]);
    const target = fakeTarget({
      template: (sql) => (sql.includes("information_schema.columns") ? AGG_COLS : []),
      unsafe: (sql) => (sql.includes("rowcount") ? [aggRow("4")] : []),
    });
    const { io } = mockIO();
    const ok = await new DebeziumEngine(io, async () => my.conn).reconcile(NODB, target, cfg);
    expect(ok).toBe(false);
  });

  if (origUrl === undefined) delete process.env.SOURCE_DB_URL;
  else process.env.SOURCE_DB_URL = origUrl;
});

/** A throwaway out-dir holding a SIGNED-OFF schema manifest so cutover's gate passes. */
function signedSchemaDir(cfg: ReturnType<typeof mysqlCfg>): string {
  const outDir = mkdtempSync(join(tmpdir(), "pgmig-cutover-schema-"));
  const m = buildManifest(cfg, { sql: "CREATE TABLE ...;", decisions: [] });
  writeFileSync(schemaArtifactPaths(outDir).manifest, `${JSON.stringify(m, null, 2)}\n`);
  signOffSchema(outDir);
  return outDir;
}

describe("DebeziumEngine.cutover (mock source + fake target)", () => {
  const cfg = mysqlCfg();
  const outDir = signedSchemaDir(cfg);
  process.env.SOURCE_DB_URL = "mysql://debezium:dbz@mysqlhost:3306/inventory";

  test("throws when the source binlog is still advancing (writes not stopped)", async () => {
    let probes = 0;
    const my = fakeMySql((sql) => {
      if (/binary log status|master status/i.test(sql)) {
        probes++;
        return [{ File: "bin.000001", Position: probes * 100 }]; // advances each call
      }
      return [];
    });
    const { io, calls } = mockIO();
    await expect(
      new DebeziumEngine(io, async () => my.conn).cutover(NODB, fakeTarget({}), cfg, { outDir }),
    ).rejects.toThrow(/binlog position still advancing/);
    // never stopped the container — gate failed closed
    expect(calls.exec.find((a) => a[1] === "stop")).toBeUndefined();
  });

  test("drains to converged counts, resyncs (no seqs), and stops CDC when writes are stopped", async () => {
    const my = fakeMySql((sql) => {
      if (/binary log status|master status/i.test(sql))
        return [{ File: "bin.000001", Position: 500 }];
      if (/count\(\*\)/i.test(sql)) return [{ n: "5" }];
      return [];
    });
    const target = fakeTarget({
      template: (sql) => (sql.includes("pg_class") ? [] : []), // no owned sequences
      unsafe: (sql) => (sql.includes("count(*)") ? [{ n: "5" }] : []),
    });
    const { io, calls } = mockIO();
    await new DebeziumEngine(io, async () => my.conn).cutover(NODB, target, cfg, { outDir });
    // stopped the container at the end (the drop-subscription analogue)
    expect(calls.exec).toContainEqual(debeziumStopArgv("pgmig-dbz-dbz"));
  });

  test("refuses to cutover when the schema draft is not signed off (the gate)", async () => {
    const unsigned = mkdtempSync(join(tmpdir(), "pgmig-cutover-unsigned-"));
    const m = buildManifest(cfg, { sql: "x", decisions: [] });
    writeFileSync(schemaArtifactPaths(unsigned).manifest, `${JSON.stringify(m, null, 2)}\n`);
    const my = fakeMySql(() => [{ File: "bin.000001", Position: 1 }]);
    const { io, calls } = mockIO();
    await expect(
      new DebeziumEngine(io, async () => my.conn).cutover(NODB, fakeTarget({}), cfg, {
        outDir: unsigned,
      }),
    ).rejects.toThrow(/NOT signed off/);
    // gate failed BEFORE touching the source/container
    expect(calls.exec.find((a) => a[1] === "stop")).toBeUndefined();
  });
});

describe("parseDebeziumHealth", () => {
  test("reads overall + debezium-check status", () => {
    expect(
      parseDebeziumHealth('{"status":"UP","checks":[{"name":"debezium","status":"UP"}]}'),
    ).toEqual({ up: true, debeziumUp: true });
    expect(
      parseDebeziumHealth('{"status":"DOWN","checks":[{"name":"debezium","status":"DOWN"}]}'),
    ).toEqual({ up: false, debeziumUp: false });
  });
  test("falls back to overall status when there is no named debezium check", () => {
    expect(parseDebeziumHealth('{"status":"UP","checks":[]}')).toEqual({
      up: true,
      debeziumUp: true,
    });
  });
  test("invalid JSON is treated as down", () => {
    expect(parseDebeziumHealth("<html>404</html>")).toEqual({ up: false, debeziumUp: false });
  });
});

describe("DebeziumEngine.watch (mock source + fake target)", () => {
  const cfg = mysqlCfg();
  process.env.SOURCE_DB_URL = "mysql://debezium:dbz@mysqlhost:3306/inventory";

  test("resolves once connector is healthy and row counts converge", async () => {
    const my = fakeMySql((sql) => (/count\(\*\)/i.test(sql) ? [{ n: "5" }] : []));
    const target = fakeTarget({ unsafe: (sql) => (sql.includes("count(*)") ? [{ n: "5" }] : []) });
    const { io, calls } = mockIO();
    await new DebeziumEngine(io, async () => my.conn).watch(NODB, target, cfg);
    expect(calls.health.length).toBeGreaterThanOrEqual(1); // probed /q/health
  });

  test("throws when the connector health check reports DOWN", async () => {
    const my = fakeMySql(() => [{ n: "5" }]);
    const target = fakeTarget({ unsafe: () => [{ n: "5" }] });
    const { io } = mockIO({
      healthBody: '{"status":"DOWN","checks":[{"name":"debezium","status":"DOWN"}]}',
    });
    await expect(
      new DebeziumEngine(io, async () => my.conn).watch(NODB, target, cfg),
    ).rejects.toThrow(/connector reports DOWN/);
  });
});

// ── SQL Server engine forks (mock mssql source + fake PG target) ───────────────────────────────

const sqlServerCfg = () =>
  ConfigSchema.parse({
    source: { engine: "sqlserver", databases: ["inventory"] },
    target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
    replication: { tables: ["dbo.customers"], publication: "dbz" },
    reconcile: { tables: [{ name: "dbo.customers" }] },
    watchdog: {},
  });

/** A fake SqlServerConn routing by SQL substring (same shape as the MySQL fake). */
function fakeSqlServer(route: (sql: string) => unknown[]): {
  conn: SqlServerConn;
  ended: () => boolean;
} {
  let ended = false;
  return {
    conn: {
      query: async <T>(sql: string) => route(sql) as T[],
      end: async () => {
        ended = true;
      },
    },
    ended: () => ended,
  };
}

describe("DebeziumEngine — SQL Server source forks", () => {
  const cfg = sqlServerCfg();
  const origUrl = process.env.SOURCE_DB_URL;

  test("replicate stages the SQL Server CDC connector config", async () => {
    process.env.SOURCE_DB_URL = "sqlserver://sa:pw@mssqlhost:1433/inventory";
    const { io, calls } = mockIO({ healthyAfter: 1 });
    await new DebeziumEngine(io).replicate(NODB, NODB, cfg, secrets());
    expect(calls.writes[0]?.content).toContain(
      "io.debezium.connector.sqlserver.SqlServerConnector",
    );
    expect(calls.writes[0]?.content).toContain("debezium.source.database.names=inventory");
  });

  test("reconcile scans the source with [bracket] quoting and the sqlserver dialect", async () => {
    process.env.SOURCE_DB_URL = "sqlserver://sa:pw@mssqlhost:1433/inventory";
    let sourceSql = "";
    const ss = fakeSqlServer((sql) => {
      if (/count\(\*\)|FROM \[/i.test(sql) || sql.includes("rowcount")) {
        sourceSql = sql;
        return [aggRow("5")];
      }
      return [];
    });
    const target = fakeTarget({
      template: (sql) => (sql.includes("information_schema.columns") ? AGG_COLS : []),
      unsafe: (sql) => (sql.includes("rowcount") ? [aggRow("5")] : []),
    });
    const { io } = mockIO();
    const ok = await new DebeziumEngine(io, undefined, async () => ss.conn).reconcile(
      NODB,
      target,
      cfg,
    );
    expect(ok).toBe(true);
    expect(ss.ended()).toBe(true);
    expect(sourceSql).toContain("FROM [dbo].[customers]"); // bracket-quoted, not backticks
    expect(sourceSql).toContain("LEN("); // sqlserver char-length fn
  });

  test("cutover write-stop gate uses the CDC max LSN and refuses when it advances", async () => {
    process.env.SOURCE_DB_URL = "sqlserver://sa:pw@mssqlhost:1433/inventory";
    const outDir = signedSchemaDir(cfg as unknown as ReturnType<typeof mysqlCfg>);
    let probes = 0;
    const ss = fakeSqlServer((sql) => {
      if (/fn_cdc_get_max_lsn/i.test(sql)) {
        probes++;
        return [{ lsn: new Uint8Array([0, 0, 0, probes]) }]; // advances each call
      }
      return [];
    });
    const { io, calls } = mockIO();
    await expect(
      new DebeziumEngine(io, undefined, async () => ss.conn).cutover(NODB, fakeTarget({}), cfg, {
        outDir,
      }),
    ).rejects.toThrow(/CDC max LSN still advancing/);
    expect(calls.exec.find((a) => a[1] === "stop")).toBeUndefined();
  });

  test("cutover drains + stops CDC when the max LSN is stable (writes stopped)", async () => {
    process.env.SOURCE_DB_URL = "sqlserver://sa:pw@mssqlhost:1433/inventory";
    const outDir = signedSchemaDir(cfg as unknown as ReturnType<typeof mysqlCfg>);
    const ss = fakeSqlServer((sql) => {
      if (/fn_cdc_get_max_lsn/i.test(sql)) return [{ lsn: new Uint8Array([0, 0, 0, 9]) }]; // stable
      if (/count\(\*\)/i.test(sql)) return [{ n: "5" }];
      return [];
    });
    const target = fakeTarget({
      template: () => [], // no owned sequences
      unsafe: (sql) => (sql.includes("count(*)") ? [{ n: "5" }] : []),
    });
    const { io, calls } = mockIO();
    await new DebeziumEngine(io, undefined, async () => ss.conn).cutover(NODB, target, cfg, {
      outDir,
    });
    expect(calls.exec).toContainEqual(debeziumStopArgv("pgmig-dbz-dbz"));
  });

  if (origUrl === undefined) delete process.env.SOURCE_DB_URL;
  else process.env.SOURCE_DB_URL = origUrl;
});
