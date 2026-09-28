import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import { dumpDataCmd, restoreDataCmd } from "../src/upgrade/capture.ts";
import {
  DEFAULT_DOWNTIME_OPTS,
  deprecatedOnTarget,
  estimateUpgradeDowntime,
  extrapolateProdDowntime,
  filterGrantsForLab,
  filterManagedTables,
  partitionRegTypeColumns,
  preUpgradeChecklist,
  renderEstimate,
  SUPABASE_POSTGRES_IMAGES,
  stripUnsupportedExtensions,
} from "../src/upgrade/kb.ts";
import {
  labContainerName,
  labImageTag,
  labUrls,
  median,
  oldContainerName,
} from "../src/upgrade/lab.ts";

describe("deprecatedOnTarget", () => {
  test("flags PG17-deprecated extensions", () => {
    const hits = deprecatedOnTarget(["pgjwt", "plv8", "pgcrypto"], 17);
    expect(hits.map((h) => h.extname)).toEqual(["pgjwt", "plv8"]);
    expect(hits.find((h) => h.extname === "pgjwt")?.note).toContain("sign()/verify()");
  });

  test("PG15 target deprecates nothing in the KB", () => {
    expect(deprecatedOnTarget(["pgjwt", "plv8", "timescaledb"], 15)).toEqual([]);
  });

  test("unknown target major -> empty", () => {
    expect(deprecatedOnTarget(["pgjwt"], 99)).toEqual([]);
  });
});

describe("estimateUpgradeDowntime", () => {
  test("2 GiB at 100 Mbps: copy ~172s, low bound dominated by fixed overhead", () => {
    const e = estimateUpgradeDowntime(2 * 1_073_741_824);
    expect(e.dataCopySec).toBeCloseTo(171.8, 0);
    expect(e.totalSecLow).toBe(Math.ceil(171.79869184 + 900));
    expect(e.totalSecHigh).toBeGreaterThan(e.totalSecLow);
  });

  test("custom overhead + throughput flow through", () => {
    const e = estimateUpgradeDowntime(1_000_000_000, { copyMbps: 1000, fixedOverheadSec: 60 });
    expect(e.dataCopySec).toBeCloseTo(8, 1);
    expect(e.totalSecLow).toBe(68);
    expect(e.assumptions.join(" ")).toContain("1000 Mbps");
  });

  test("renderEstimate renders a minute range", () => {
    const e = estimateUpgradeDowntime(2 * 1_073_741_824);
    expect(renderEstimate(e)).toMatch(/^~\d+-\d+ min$/);
  });
});

describe("extrapolateProdDowntime", () => {
  test("scales the lab-measured upgrade linearly and adds fixed overhead", () => {
    const e = extrapolateProdDowntime(10, 1_073_741_824, 2 * 1_073_741_824);
    expect(e.dataCopySec).toBe(20);
    expect(e.totalSecLow).toBe(920);
    expect(e.totalSecHigh).toBe(Math.ceil(30 + 1125));
  });

  test("zero lab bytes -> scale 1 (no divide-by-zero)", () => {
    const e = extrapolateProdDowntime(10, 0, 5 * 1_073_741_824);
    expect(e.dataCopySec).toBe(10);
  });
});

describe("filterManagedTables", () => {
  test("drops managed schemas, keeps user schemas", () => {
    const out = filterManagedTables(
      ["public.documents", "auth.users", "storage.objects", "app.things"],
      ["auth", "storage", "realtime"],
    );
    expect(out).toEqual(["public.documents", "app.things"]);
  });
});

describe("partitionRegTypeColumns", () => {
  test("splits platform-managed reg* columns from user ones", () => {
    const { user, managed } = partitionRegTypeColumns(
      [
        { schema: "realtime", table: "subscription", column: "entity", type: "regclass" },
        { schema: "public", table: "t", column: "c", type: "regtype" },
      ],
      ["realtime", "auth"],
    );
    expect(user.map((c) => c.table)).toEqual(["t"]);
    expect(managed.map((c) => c.table)).toEqual(["subscription"]);
  });
});

describe("stripUnsupportedExtensions", () => {
  test("drops CREATE/COMMENT ON EXTENSION for non-lab extensions, keeps contrib", () => {
    const input = [
      'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";',
      "COMMENT ON EXTENSION \"pg_net\" IS 'x';",
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";',
      'CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";',
      'CREATE TABLE "public"."t" ("id" int);',
    ].join("\n");
    const { sql, skipped } = stripUnsupportedExtensions(input);
    expect(skipped).toEqual(["pg_net", "pgjwt"]);
    expect(sql).toContain("pgcrypto");
    expect(sql).toContain('CREATE TABLE "public"."t"');
    expect(sql).not.toContain("pg_net");
    expect(sql).not.toContain("pgjwt");
  });

  test("supabase_vault + pg_graphql are stripped; unquoted names work", () => {
    const { skipped } = stripUnsupportedExtensions(
      "CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;\n" +
        "COMMENT ON EXTENSION pg_graphql IS 'g';",
    );
    expect(skipped).toEqual(["pg_graphql", "supabase_vault"]);
  });
});

describe("preUpgradeChecklist", () => {
  test("core items are provider-agnostic and grounded", () => {
    const core = preUpgradeChecklist("generic").join("\n");
    expect(core).toContain("read replicas");
    expect(core).toContain("logical replication slots");
    expect(core).toContain("reg* columns");
    expect(core).toContain("scram-sha-256");
    expect(core).toContain("cron.job_run_details");
  });

  test("supabase adds platform-specific items", () => {
    const supa = preUpgradeChecklist("supabase");
    expect(supa.length).toBeGreaterThan(preUpgradeChecklist("generic").length);
    expect(supa.join("\n")).toContain("right-sizes the disk");
  });
});

describe("median", () => {
  test("odd + even + empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("lab naming + urls", () => {
  test("deterministic names per major pair", () => {
    expect(oldContainerName(15)).toBe("pgmig-pgup-old-15");
    expect(labContainerName(15, 17)).toBe("pgmig-pgup-lab-15-17");
    expect(labImageTag(15, 17)).toBe("pgmig-pgupgrade:15-17");
    expect(labImageTag(15, 17, "supabase")).toBe("pgmig-pgupgrade-sb:15-17");
    expect(labUrls().source).toContain(":55440/");
    expect(labUrls().target).toContain(":55441/");
  });
});

describe("filterGrantsForLab", () => {
  test("comments out grants OF reserved roles, keeps everything else", () => {
    const input = [
      'GRANT "anon" TO "my_app_role" GRANTED BY "postgres";',
      'GRANT "my_app_role" TO "other_role";',
      'CREATE ROLE "my_app_role";',
    ].join("\n");
    const out = filterGrantsForLab(input, ["anon", "authenticated"]);
    expect(out).toContain('-- GRANT "anon" TO "my_app_role"');
    expect(out).toContain('GRANT "my_app_role" TO "other_role";');
    expect(out).toContain('CREATE ROLE "my_app_role";');
  });

  test("empty reserved list is a no-op", () => {
    expect(filterGrantsForLab("GRANT x TO y;", [])).toBe("GRANT x TO y;");
  });
});

describe("supabase lab images", () => {
  test("default supabase/postgres tags exist for the 15->17 path", () => {
    expect(SUPABASE_POSTGRES_IMAGES[15]).toContain("supabase/postgres:15");
    expect(SUPABASE_POSTGRES_IMAGES[17]).toContain("supabase/postgres:17");
  });
});

describe("capture command builders", () => {
  test("dumpDataCmd excludes managed schemas and keeps hygiene flags", () => {
    const cmd = dumpDataCmd("postgres://u:p@h:5432/db", "data.sql", ["auth", "storage"]).join(" ");
    expect(cmd).toContain("--data-only");
    expect(cmd).toContain("--no-owner");
    expect(cmd).toContain("--exclude-schema=auth");
    expect(cmd).toContain("--exclude-schema=storage");
    expect(cmd).not.toContain("--schema-only");
  });

  test("restoreDataCmd defers FK enforcement in the same session", () => {
    const cmd = restoreDataCmd("postgres://u:p@h:5432/db", "data.sql");
    expect(cmd.join(" ")).toContain("session_replication_role = replica");
    // -c must come before -f so the SET applies to the file load
    expect(cmd.indexOf("--command")).toBeLessThan(cmd.indexOf("-f"));
  });
});

describe("upgrade verify synthetic config", () => {
  test("ConfigSchema.parse fills defaults for a minimal verify config", () => {
    const cfg = ConfigSchema.parse({
      source: { ref: "upgrade-verify-src" },
      target: { ref: "upgrade-verify-tgt" },
      replication: { tables: ["public._placeholder"] },
      reconcile: { tables: [{ name: "public.documents" }] },
      watchdog: {},
    });
    expect(cfg.source.engine).toBe("postgres");
    expect(cfg.reconcile.tables[0]?.name).toBe("public.documents");
    expect(cfg.replication.copyData).toBe(true);
    expect(cfg.watchdog.maxRetainedWalMb).toBeGreaterThan(0);
  });
});

describe("downtime defaults", () => {
  test("grounded in the Supabase platform guide (GP3 ~100 Mbps, ~15 min fixed)", () => {
    expect(DEFAULT_DOWNTIME_OPTS.copyMbps).toBe(100);
    expect(DEFAULT_DOWNTIME_OPTS.fixedOverheadSec).toBe(900);
  });
});
