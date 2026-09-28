import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema, type Secrets } from "../src/config.ts";
import type { MySqlConn } from "../src/engine/mysql.ts";
import type { SqlServerConn } from "../src/engine/sqlserver.ts";
import {
  assertSchemaSignedOff,
  buildManifest,
  groupTablesByDatabase,
  type SchemaManifest,
  schemaArtifactPaths,
  signOffSchema,
  translate,
} from "../src/steps/translate.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pgmig-translate-test-"));

const mysqlCfg = (tables: string[]): Config =>
  ConfigSchema.parse({
    source: {
      engine: "mysql",
      serverId: 1,
      databases: [...new Set(tables.map((t) => t.split(".")[0]))],
    },
    target: { ref: "translate-test-ref0" },
    replication: { tables, publication: "t" },
    reconcile: { tables: tables.map((name) => ({ name })) },
    watchdog: {},
  });

const secrets = { SOURCE_DB_URL: "mysql://u:p@127.0.0.1:3306/inventory" } as Secrets;

/** A fake information_schema: maps `db.table` → its columns + primary key. */
function fakeMySql(schema: Record<string, { cols: Record<string, unknown>[]; pk: string[] }>): {
  conn: MySqlConn;
  ended: () => boolean;
} {
  let closed = false;
  const conn: MySqlConn = {
    // biome-ignore lint/suspicious/noExplicitAny: test double returns shaped rows
    async query<T = any>(sql: string): Promise<T[]> {
      const dbMatch = /TABLE_SCHEMA = '([^']+)' AND TABLE_NAME = '([^']+)'/.exec(sql);
      if (!dbMatch) return [] as T[];
      const key = `${dbMatch[1]}.${dbMatch[2]}`;
      const entry = schema[key];
      if (!entry) return [] as T[];
      if (sql.includes("KEY_COLUMN_USAGE")) {
        return entry.pk.map((COLUMN_NAME) => ({ COLUMN_NAME })) as T[];
      }
      return entry.cols as T[];
    },
    async end() {
      closed = true;
    },
  };
  return { conn, ended: () => closed };
}

const intCol = (name: string) => ({
  COLUMN_NAME: name,
  DATA_TYPE: "int",
  COLUMN_TYPE: "int",
  IS_NULLABLE: "NO",
  COLUMN_KEY: "PRI",
  EXTRA: "",
  CHARACTER_MAXIMUM_LENGTH: null,
  NUMERIC_PRECISION: 10,
  NUMERIC_SCALE: 0,
});
const tinyint1Col = (name: string) => ({
  COLUMN_NAME: name,
  DATA_TYPE: "tinyint",
  COLUMN_TYPE: "tinyint(1)",
  IS_NULLABLE: "YES",
  COLUMN_KEY: "",
  EXTRA: "",
  CHARACTER_MAXIMUM_LENGTH: null,
  NUMERIC_PRECISION: 3,
  NUMERIC_SCALE: 0,
});

describe("groupTablesByDatabase", () => {
  test("groups schema.table idents by the schema part", () => {
    const g = groupTablesByDatabase([
      "inventory.customers",
      "inventory.orders",
      "billing.invoices",
    ]);
    expect([...g.keys()].sort()).toEqual(["billing", "inventory"]);
    expect(g.get("inventory")).toEqual(["customers", "orders"]);
    expect(g.get("billing")).toEqual(["invoices"]);
  });
});

describe("buildManifest", () => {
  test("derives databases, lists tables, starts UNSIGNED", () => {
    const cfg = mysqlCfg(["inventory.customers", "shop.items"]);
    const m = buildManifest(cfg, {
      sql: "...",
      decisions: [{ table: "customers", column: "active", review: "TINYINT(1)→boolean" }],
    });
    expect(m.source.engine).toBe("mysql");
    expect(m.source.databases.sort()).toEqual(["inventory", "shop"]);
    expect(m.tables).toEqual(["inventory.customers", "shop.items"]);
    expect(m.decisions).toHaveLength(1);
    expect(m.signedOff).toBe(false);
    expect(m.signedOffAt).toBeUndefined();
  });
});

describe("translate — write artifacts", () => {
  test("drafts + writes UNSIGNED sql + manifest, closes the connection", async () => {
    const outDir = tmp();
    const { conn, ended } = fakeMySql({
      "inventory.customers": { cols: [intCol("id"), tinyint1Col("active")], pk: ["id"] },
    });
    const result = await translate(mysqlCfg(["inventory.customers"]), secrets, {
      outDir,
      mysqlConnect: async () => conn,
    });
    expect(ended()).toBe(true);

    const { sql, manifest } = schemaArtifactPaths(outDir);
    const sqlText = readFileSync(sql, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "public"."customers"');
    expect(sqlText).toContain('"active" boolean');
    expect(sqlText).toContain("NEVER auto-applies");

    const m = JSON.parse(readFileSync(manifest, "utf8")) as SchemaManifest;
    expect(m.signedOff).toBe(false);
    expect(m.decisions.some((d) => d.column === "active")).toBe(true);
    expect(result.manifest.tables).toEqual(["inventory.customers"]);
  });

  test("spans multiple databases", async () => {
    const outDir = tmp();
    const { conn } = fakeMySql({
      "inventory.customers": { cols: [intCol("id")], pk: ["id"] },
      "billing.invoices": { cols: [intCol("invoice_id")], pk: ["invoice_id"] },
    });
    await translate(mysqlCfg(["inventory.customers", "billing.invoices"]), secrets, {
      outDir,
      mysqlConnect: async () => conn,
    });
    const sqlText = readFileSync(schemaArtifactPaths(outDir).sql, "utf8");
    expect(sqlText).toContain('"public"."customers"');
    expect(sqlText).toContain('"public"."invoices"');
  });

  test("rejects a postgres source (no translation needed)", async () => {
    const cfg = ConfigSchema.parse({
      source: { ref: "pg-source-ref-000000" },
      target: { ref: "pg-target-ref-000000" },
      replication: { tables: ["public.documents"] },
      reconcile: { tables: [{ name: "public.documents" }] },
      watchdog: {},
    });
    await expect(translate(cfg, secrets, { outDir: tmp() })).rejects.toThrow(
      /needs no schema translation/,
    );
  });

  test("drafts a SQL Server source via the T-SQL translator + injected connector", async () => {
    const cfg = ConfigSchema.parse({
      source: { engine: "sqlserver", databases: ["dbo"] },
      target: { ref: "ss-target-ref-000000" },
      replication: { tables: ["dbo.customers"] },
      reconcile: { tables: [{ name: "dbo.customers" }] },
      watchdog: {},
    });
    let closed = false;
    const conn: SqlServerConn = {
      // biome-ignore lint/suspicious/noExplicitAny: test double returns shaped rows
      async query<T = any>(text: string): Promise<T[]> {
        if (text.includes("TABLE_CONSTRAINTS")) return [{ COLUMN_NAME: "id" }] as T[];
        if (text.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return [
            {
              COLUMN_NAME: "id",
              DATA_TYPE: "int",
              IS_NULLABLE: "NO",
              CHARACTER_MAXIMUM_LENGTH: null,
              NUMERIC_PRECISION: 10,
              NUMERIC_SCALE: 0,
              DATETIME_PRECISION: null,
              IS_IDENTITY: 1,
              IS_COMPUTED: 0,
            },
          ] as T[];
        }
        return [] as T[];
      },
      async end() {
        closed = true;
      },
    };
    const out = tmp();
    const res = await translate(cfg, secrets, { outDir: out, sqlServerConnect: async () => conn });
    expect(res.draft.sql).toContain('CREATE TABLE IF NOT EXISTS "public"."customers"');
    expect(res.draft.sql).toContain('"id" integer NOT NULL');
    expect(res.manifest.source.engine).toBe("sqlserver");
    expect(res.draft.decisions).toContainEqual({
      table: "customers",
      column: "id",
      review: expect.stringMatching(/IDENTITY/),
    });
    expect(closed).toBe(true);
    expect(readFileSync(res.paths.sql, "utf8")).toContain("from sqlserver dbo");
  });

  test("--apply without a target connection throws", async () => {
    const { conn } = fakeMySql({ "inventory.customers": { cols: [intCol("id")], pk: ["id"] } });
    await expect(
      translate(mysqlCfg(["inventory.customers"]), secrets, {
        outDir: tmp(),
        apply: true,
        mysqlConnect: async () => conn,
      }),
    ).rejects.toThrow(/--apply requires a target/);
  });
});

describe("sign-off + cutover gate", () => {
  function draftInto(outDir: string): void {
    const cfg = mysqlCfg(["inventory.customers"]);
    const m = buildManifest(cfg, { sql: "x", decisions: [] });
    const { sql, manifest } = schemaArtifactPaths(outDir);
    writeFileSync(sql, "CREATE TABLE ...;\n");
    writeFileSync(manifest, `${JSON.stringify(m, null, 2)}\n`);
  }

  test("assertSchemaSignedOff throws when no manifest exists", () => {
    expect(() => assertSchemaSignedOff(tmp())).toThrow(/no schema manifest/);
  });

  test("assertSchemaSignedOff throws when drafted but UNSIGNED", () => {
    const outDir = tmp();
    draftInto(outDir);
    expect(() => assertSchemaSignedOff(outDir)).toThrow(/NOT signed off/);
  });

  test("signOffSchema flips signedOff + stamps time; gate then passes", () => {
    const outDir = tmp();
    draftInto(outDir);
    const signed = signOffSchema(outDir);
    expect(signed.signedOff).toBe(true);
    expect(signed.signedOffAt).toBeTruthy();
    // persisted
    const m = JSON.parse(
      readFileSync(schemaArtifactPaths(outDir).manifest, "utf8"),
    ) as SchemaManifest;
    expect(m.signedOff).toBe(true);
    expect(() => assertSchemaSignedOff(outDir)).not.toThrow();
  });

  test("signOffSchema is idempotent and keeps the original timestamp", () => {
    const outDir = tmp();
    draftInto(outDir);
    const first = signOffSchema(outDir);
    const second = signOffSchema(outDir);
    expect(second.signedOffAt).toBe(first.signedOffAt);
  });

  test("signOffSchema throws when nothing has been drafted", () => {
    expect(() => signOffSchema(tmp())).toThrow(/no schema manifest/);
  });
});
