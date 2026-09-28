import { describe, expect, test } from "bun:test";
import {
  buildEngineGuide,
  preppableEngines,
  sourcePrep,
  sourcePrepFor,
} from "../src/kb/engine-prep.ts";
import { SourcePrepItems } from "../src/kb/schema.ts";
import { evalRule } from "../src/kb/source-prep-eval.ts";

describe("source-prep catalog", () => {
  test("the whole catalog parses against the schema", () => {
    expect(() => SourcePrepItems.parse(sourcePrep)).not.toThrow();
  });

  test("ids are unique and engine-prefixed", () => {
    const ids = sourcePrep.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of sourcePrep) expect(i.id.startsWith(`${i.engine}.`)).toBe(true);
  });

  test("every item carries a drift-checkable provenance source + ISO-dated lastSynced", () => {
    for (const i of sourcePrep) {
      expect(i.provenance.source).toMatch(/^(\/docs\/|https?:\/\/)/);
      expect(i.provenance.lastSynced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("a guided/fail item never auto-applies and gates its phase", () => {
    const guided = sourcePrep.filter((i) => i.klass === "guided");
    for (const i of guided) expect(i.severity).toBe("fail");
  });
});

describe("buildEngineGuide", () => {
  test("groups items by phase in canonical migration order", () => {
    const g = buildEngineGuide("sqlserver");
    expect(g.engine).toBe("sqlserver");
    expect(g.phases.map((p) => p.phase)).toEqual([
      "preflight",
      "source-prep",
      "snapshot",
      "cutover",
    ]);
    expect(g.itemCount).toBe(sourcePrepFor("sqlserver").length);
  });

  test("omits phases with no items and sums itemCount across phases", () => {
    const g = buildEngineGuide("mysql");
    expect(g.phases.every((p) => p.items.length > 0)).toBe(true);
    expect(g.phases.reduce((n, p) => n + p.items.length, 0)).toBe(g.itemCount);
    expect(g.itemCount).toBe(7);
  });
});

describe("preppableEngines", () => {
  test("lists the heterogeneous engines that have a playbook, deduped", () => {
    const engines = preppableEngines();
    expect(new Set(engines)).toEqual(new Set(["mysql", "sqlserver"]));
    expect(engines.length).toBe(new Set(engines).size);
  });
});

describe("MySQL source-prep playbook (§7)", () => {
  const items = sourcePrepFor("mysql");
  const byId = (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new Error(`missing mysql item: ${id}`);
    return found;
  };

  test("covers the six source-prep enablement items plus schema-translation + identity-resync", () => {
    expect(items.map((i) => i.id)).toEqual([
      "mysql.user_grants",
      "mysql.binlog_enabled",
      "mysql.gtid_mode",
      "mysql.binlog_retention",
      "mysql.binlog_row_value_options",
      "mysql.schema_translation",
      "mysql.identity_resync",
    ]);
  });

  test("binlog item demands ROW format + FULL row image (the Debezium hard requirement)", () => {
    const binlog = byId("mysql.binlog_enabled");
    expect(binlog.severity).toBe("fail");
    expect(binlog.guidance).toContain("binlog_format    = ROW");
    expect(binlog.guidance).toContain("binlog_row_image = FULL");
    expect(binlog.verify?.expect).toContain("ROW");
  });

  test("CDC user grants include the two replication privileges Debezium needs", () => {
    const grants = byId("mysql.user_grants");
    expect(grants.guidance).toContain("REPLICATION SLAVE");
    expect(grants.guidance).toContain("REPLICATION CLIENT");
  });

  test("schema-translation is the guided heart: snapshot phase, fail, never auto-applies", () => {
    const st = byId("mysql.schema_translation");
    expect(st.phase).toBe("snapshot");
    expect(st.klass).toBe("guided");
    expect(st.severity).toBe("fail");
    expect(st.guidance).toContain("never auto-applies");
    expect(st.guidance).toContain("pgmig translate");
    expect(st.guidance).toContain("--sign-off");
    expect(st.detect).toBeUndefined(); // a human-ratified draft, not a probe
  });

  test("identity-resync mirrors native cutover sequence-resync (cutover phase, auto)", () => {
    const ir = byId("mysql.identity_resync");
    expect(ir.phase).toBe("cutover");
    expect(ir.klass).toBe("auto");
    expect(ir.guidance).toContain("MAX(pk)+1");
  });
});

describe("SQL Server / Azure SQL source-prep playbook (§7b)", () => {
  const items = sourcePrepFor("sqlserver");
  const byId = (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new Error(`missing sqlserver item: ${id}`);
    return found;
  };

  test("covers flavour preflight, CDC enablement, the guided translation, and identity resync", () => {
    expect(items.map((i) => i.id)).toEqual([
      "sqlserver.flavour",
      "sqlserver.azure_tier",
      "sqlserver.cdc_enable",
      "sqlserver.cdc_retention",
      "sqlserver.change_tracking_alt",
      "sqlserver.schema_translation",
      "sqlserver.identity_resync",
    ]);
  });

  test("azure_tier is a fail-severity source-prep gate that asserts a computed tier_ok verdict", () => {
    const t = byId("sqlserver.azure_tier");
    expect(t.phase).toBe("source-prep");
    expect(t.severity).toBe("fail");
    expect(t.assert?.rules).toEqual([
      expect.objectContaining({ kind: "eq", column: "tier_ok", value: "ok" }),
    ]);
    // built-in function, compiles on every edition (not the Azure-only catalog view)
    expect(t.assert?.sql).toContain("DATABASEPROPERTYEX");
    expect(t.assert?.sql).toContain("EngineEdition");
    expect(t.assert?.sql).toContain("'Basic','S0','S1','S2'");
  });

  test("azure_tier verdict: N/A off-Azure, ok on vCore/S3+, blocked on Basic/S0-S2", () => {
    const rule = byId("sqlserver.azure_tier").assert?.rules[0];
    if (!rule) throw new Error("azure_tier assert rule missing");
    // The DB computes tier_ok; doctor only judges its value. Simulate each server-side outcome.
    expect(evalRule(rule, [{ tier_ok: "ok" }]).ok).toBe(true); // off-Azure or vCore or DTU S3+
    expect(evalRule(rule, [{ tier_ok: "blocked" }]).ok).toBe(false); // DTU Basic/S0/S1/S2
  });

  test("flavour is a preflight informed item probing EngineEdition (the discovery question)", () => {
    const f = byId("sqlserver.flavour");
    expect(f.phase).toBe("preflight");
    expect(f.klass).toBe("informed");
    expect(f.detect?.sql).toContain("EngineEdition");
  });

  test("cdc_enable carries the Azure SQL DB tier gate (Basic/S0-S2 unsupported)", () => {
    const cdc = byId("sqlserver.cdc_enable");
    expect(cdc.severity).toBe("fail");
    expect(cdc.guidance).toContain("sp_cdc_enable_db");
    expect(cdc.guidance).toContain("vCore");
    expect(cdc.guidance).toContain("Basic / S0 / S1 / S2 are NOT supported");
  });

  test("change_tracking is explicitly flagged insufficient for the Debezium path", () => {
    const ct = byId("sqlserver.change_tracking_alt");
    expect(ct.severity).toBe("info");
    expect(ct.guidance).toContain("insufficient");
  });

  test("schema-translation flags the no-clean-equivalent types and the case-sensitivity trap", () => {
    const st = byId("sqlserver.schema_translation");
    expect(st.klass).toBe("guided");
    expect(st.guidance).toContain("HIERARCHYID");
    expect(st.guidance).toContain("Case sensitivity");
    expect(st.guidance).toContain("PL/pgSQL");
  });
});
