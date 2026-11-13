import { describe, expect, test } from "bun:test";
import { classifyConn } from "../src/db.ts";
import {
  checkAccessToken,
  diffExtensionVersions,
  diffHashColumns,
  extensionRiskNote,
  externalDepDumpCommand,
  externalDeps,
  type Fk,
  parsePgMajor,
  providerHint,
  providerNotes,
} from "../src/steps/doctor.ts";

describe("checkAccessToken", () => {
  const never = async () => {
    throw new Error("validate should not be called when token is unset");
  };

  test("unset token -> warn, validator never called", async () => {
    const r = await checkAccessToken(undefined, never);
    expect(r.level).toBe("warn");
    expect(r.message).toContain("unset");
  });

  test("valid token -> ok (green tick means the API accepted it)", async () => {
    const r = await checkAccessToken("sbp_good", async () => ({ ok: true, status: 200 }));
    expect(r.level).toBe("ok");
    expect(r.message).toContain("valid");
  });

  test("expired/revoked token (401) -> warn, not a false green", async () => {
    const r = await checkAccessToken("sbp_dead", async () => ({ ok: false, status: 401 }));
    expect(r.level).toBe("warn");
    expect(r.message).toContain("401");
    expect(r.message).toContain("expired/revoked");
  });

  test("transient API failure (0/5xx) -> warn, distinct from 401", async () => {
    const r = await checkAccessToken("sbp_x", async () => ({ ok: false, status: 0 }));
    expect(r.level).toBe("warn");
    expect(r.message).toContain("could not be validated");
  });
});

describe("classifyConn", () => {
  test("direct Supabase host → ref extracted, not pooler", () => {
    const c = classifyConn(
      "postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres",
    );
    expect(c).toMatchObject({
      isPooler: false,
      isSupabaseDirect: true,
      ref: "abcdefghijklmnop",
      port: 5432,
    });
  });

  test("pooler host → isPooler, not direct", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isSupabaseDirect).toBe(false);
    expect(c.ref).toBeUndefined();
  });

  test("session pooler (5432) is NOT a transaction pooler — dumps are fine", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isTransactionPooler).toBe(false);
  });

  test("transaction pooler (6543) flagged — pg_dump would break over it", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isTransactionPooler).toBe(true);
  });

  test("defaults port to 5432 when absent", () => {
    expect(classifyConn("postgresql://u:p@localhost/postgres").port).toBe(5432);
  });

  test("plain host is neither pooler nor direct", () => {
    const c = classifyConn("postgresql://u:p@source:5432/postgres");
    expect(c.isPooler).toBe(false);
    expect(c.isSupabaseDirect).toBe(false);
  });
});

describe("classifyConn — provider detection", () => {
  test("Supabase direct host → provider supabase", () => {
    expect(
      classifyConn("postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres")
        .provider,
    ).toBe("supabase");
  });

  test("Supabase pooler host → provider supabase", () => {
    expect(
      classifyConn(
        "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
      ).provider,
    ).toBe("supabase");
  });

  test("RDS PostgreSQL instance host → provider rds-postgres", () => {
    expect(
      classifyConn("postgresql://u:pw@mydb.abc123xyz.eu-west-1.rds.amazonaws.com:5432/postgres")
        .provider,
    ).toBe("rds-postgres");
  });

  test("Aurora cluster endpoint → provider aurora-postgres (not plain rds)", () => {
    const writer = classifyConn(
      "postgresql://u:pw@mycluster.cluster-abc123.eu-west-1.rds.amazonaws.com:5432/postgres",
    );
    expect(writer.provider).toBe("aurora-postgres");
    const reader = classifyConn(
      "postgresql://u:pw@mycluster.cluster-ro-abc123.eu-west-1.rds.amazonaws.com:5432/postgres",
    );
    expect(reader.provider).toBe("aurora-postgres");
  });

  test("Neon host → provider neon", () => {
    expect(
      classifyConn("postgresql://u:pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb")
        .provider,
    ).toBe("neon");
    expect(
      classifyConn(
        "postgresql://u:pw@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb",
      ).provider,
    ).toBe("neon");
  });

  test("PlanetScale Postgres host → provider planetscale-postgres", () => {
    expect(
      classifyConn("postgresql://postgres.br123:pw@abcd-useast1-1.horizon.psdb.cloud:5432/db")
        .provider,
    ).toBe("planetscale-postgres");
    expect(
      classifyConn(
        "postgresql://postgres.br123:pw@ps-main.gcp-us-central1-1.private-pg.psdb.cloud:5432/db",
      ).provider,
    ).toBe("planetscale-postgres");
  });

  test("Azure Database for PostgreSQL host → provider azure-postgres", () => {
    expect(
      classifyConn("postgresql://u:pw@myserver.postgres.database.azure.com:5432/postgres").provider,
    ).toBe("azure-postgres");
  });

  test("unknown host → provider generic", () => {
    expect(classifyConn("postgresql://u:p@localhost:5432/postgres").provider).toBe("generic");
    expect(classifyConn("postgresql://u:p@source:5432/postgres").provider).toBe("generic");
  });
});

describe("providerHint", () => {
  test("RDS source → mentions custom parameter group + reboot", () => {
    const h = providerHint("rds-postgres", "source");
    expect(h).toContain("rds.logical_replication=1");
    expect(h).toMatch(/REBOOT/i);
  });

  test("Aurora source → mentions cluster parameter group + enhanced slot caveat", () => {
    const h = providerHint("aurora-postgres", "source");
    expect(h).toMatch(/CLUSTER parameter group/i);
    expect(h).toMatch(/INVALIDATES/i);
  });

  test("Neon source → warns irreversible + 40h slot reaping", () => {
    const h = providerHint("neon", "source");
    expect(h).toMatch(/IRREVERSIBLE/i);
    expect(h).toContain("40h");
  });

  test("Neon target → warns scale-to-zero", () => {
    expect(providerHint("neon", "target")).toMatch(/scale to zero/i);
  });

  test("PlanetScale source → warns port 6432 PgBouncer can't stream WAL", () => {
    const h = providerHint("planetscale-postgres", "source");
    expect(h).toContain("5432");
    expect(h).toMatch(/6432 is PgBouncer/i);
  });

  test("PlanetScale target → warns 150% disk + copy_data=false", () => {
    const h = providerHint("planetscale-postgres", "target");
    expect(h).toMatch(/150%/);
    expect(h).toContain("copy_data=false");
  });

  test("Azure source → mentions wal_level=logical + failover slots", () => {
    const h = providerHint("azure-postgres", "source");
    expect(h).toContain("wal_level=logical");
    expect(h).toMatch(/PG Failover Slots/i);
  });

  test("supabase + generic → no hint (handled elsewhere / generic check suffices)", () => {
    expect(providerHint("supabase", "source")).toBeNull();
    expect(providerHint("generic", "source")).toBeNull();
  });

  test("providers without a target-specific note return null for target role", () => {
    expect(providerHint("rds-postgres", "target")).toBeNull();
    expect(providerHint("aurora-postgres", "target")).toBeNull();
    expect(providerHint("azure-postgres", "target")).toBeNull();
  });
});

describe("providerNotes", () => {
  test("both sides have hints → source + target notes, prefixed", () => {
    const notes = providerNotes({ provider: "rds-postgres" }, { provider: "neon" });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toStartWith("source provider note — ");
    expect(notes[0]).toContain("rds.logical_replication=1");
    expect(notes[1]).toStartWith("target provider note — ");
    expect(notes[1]).toMatch(/scale to zero/i);
  });

  test("sourceOnly → target note suppressed even when target has a hint", () => {
    const notes = providerNotes(
      { provider: "rds-postgres" },
      { provider: "neon" },
      { sourceOnly: true },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith("source provider note — ");
  });

  test("null source hint omitted; null target hint omitted", () => {
    // supabase source has no hint, rds target has no target-role hint
    expect(providerNotes({ provider: "supabase" }, { provider: "rds-postgres" })).toEqual([]);
  });

  test("null source hint but live target hint → only target note", () => {
    const notes = providerNotes({ provider: "generic" }, { provider: "neon" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith("target provider note — ");
  });
});

describe("externalDepDumpCommand", () => {
  test("auth deps point at cutover --with-auth-data, not a pre-copy dump", () => {
    const fix = externalDepDumpCommand(["auth.users"]);
    expect(fix).toContain("pgmig cutover --with-auth-data");
    expect(fix).not.toContain("supabase db dump");
  });

  test("other schemas get the dump/restore, inside the write stop, one transaction", () => {
    const fix = externalDepDumpCommand(["auth.users", "billing.plans", "billing.prices"]);
    expect(fix).toContain("pgmig cutover --with-auth-data");
    expect(fix).toContain("billing: inside the write stop");
    expect(fix).toContain("--schema billing -f predeps.sql");
    expect(fix).toContain("--single-transaction");
    expect(fix).toContain("SET session_replication_role = replica");
  });
});

describe("externalDeps", () => {
  const replicated = ["public.documents", "public.aliases"];
  const fks: Fk[] = [
    { table: "public.documents", references: "auth.users" },
    { table: "public.aliases", references: "public.documents" },
  ];

  test("flags FK into a non-replicated schema (auth.users)", () => {
    expect(externalDeps(fks, replicated)).toEqual(["auth.users"]);
  });

  test("intra-set FK (aliases→documents) is not an external dep", () => {
    expect(
      externalDeps([{ table: "public.aliases", references: "public.documents" }], replicated),
    ).toEqual([]);
  });

  test("ignores FKs on tables we don't replicate", () => {
    expect(externalDeps([{ table: "other.thing", references: "auth.users" }], replicated)).toEqual(
      [],
    );
  });

  test("dedups + sorts multiple external refs", () => {
    const many: Fk[] = [
      { table: "public.documents", references: "auth.users" },
      { table: "public.aliases", references: "auth.users" },
      { table: "public.documents", references: "storage.objects" },
    ];
    expect(externalDeps(many, replicated)).toEqual(["auth.users", "storage.objects"]);
  });
});

describe("diffHashColumns", () => {
  const live = ["id", "content", "title"];
  const gen = ["search_vector"];

  test("undefined pinned (auto-detect) → no findings", () => {
    expect(diffHashColumns(undefined, live, gen)).toEqual({
      missingFromPinned: [],
      nonexistent: [],
      generatedPinned: [],
    });
  });

  test("pinned exactly matches live non-generated → clean", () => {
    expect(diffHashColumns(["id", "content", "title"], live, gen)).toEqual({
      missingFromPinned: [],
      nonexistent: [],
      generatedPinned: [],
    });
  });

  test("live column omitted from pinned → missingFromPinned (silent-skip risk)", () => {
    expect(diffHashColumns(["id", "content"], live, gen).missingFromPinned).toEqual(["title"]);
  });

  test("pinned column not on table → nonexistent (reconcile SQL error)", () => {
    expect(diffHashColumns(["id", "content", "title", "bogus"], live, gen).nonexistent).toEqual([
      "bogus",
    ]);
  });

  test("pinned a generated column → generatedPinned (false mismatch)", () => {
    expect(
      diffHashColumns(["id", "content", "title", "search_vector"], live, gen).generatedPinned,
    ).toEqual(["search_vector"]);
  });

  test("a generated column counts as existing, not nonexistent", () => {
    const d = diffHashColumns(["id", "content", "title", "search_vector"], live, gen);
    expect(d.nonexistent).toEqual([]);
  });
});

describe("diffExtensionVersions - extensions present on both sides at different versions", () => {
  test("no overlap -> no mismatches", () => {
    expect(diffExtensionVersions([{ extname: "pg_net", extversion: "0.9.0" }], [])).toEqual([]);
  });

  test("same version on both sides -> no mismatch", () => {
    const src = [{ extname: "pgaudit", extversion: "1.7" }];
    const tgt = [{ extname: "pgaudit", extversion: "1.7" }];
    expect(diffExtensionVersions(src, tgt)).toEqual([]);
  });

  test("different version on target -> reported with both versions", () => {
    const src = [{ extname: "pg_net", extversion: "0.9.0" }];
    const tgt = [{ extname: "pg_net", extversion: "0.14.0" }];
    expect(diffExtensionVersions(src, tgt)).toEqual([
      { extname: "pg_net", source: "0.9.0", target: "0.14.0" },
    ]);
  });

  test("missing on target entirely is NOT a version mismatch (that's missingExtensions' job)", () => {
    const src = [{ extname: "hypopg", extversion: "1.4.1" }];
    expect(diffExtensionVersions(src, [])).toEqual([]);
  });

  test("multiple mismatches sorted by extname", () => {
    const src = [
      { extname: "wrappers", extversion: "0.4.0" },
      { extname: "pg_cron", extversion: "1.6" },
    ];
    const tgt = [
      { extname: "wrappers", extversion: "0.4.3" },
      { extname: "pg_cron", extversion: "1.6.4" },
    ];
    expect(diffExtensionVersions(src, tgt).map((m) => m.extname)).toEqual(["pg_cron", "wrappers"]);
  });
});

describe("extensionRiskNote - known extension-update-path risk callouts", () => {
  test("pg_net -> flags binary/catalog mismatch history", () => {
    expect(extensionRiskNote("pg_net")).toContain("ALTER EXTENSION pg_net UPDATE");
  });

  test("pg_cron -> flags missing-update-path history", () => {
    expect(extensionRiskNote("pg_cron")).toMatch(/unrecoverable/);
  });

  test("pg_repack -> flags no-update-path history", () => {
    expect(extensionRiskNote("pg_repack")).toMatch(/no UPDATE path/);
  });

  test("wrappers -> flags same symptom as pg_net", () => {
    expect(extensionRiskNote("wrappers")).toContain("pg_net");
  });

  test("unknown extension -> undefined (no false alarm)", () => {
    expect(extensionRiskNote("hypopg")).toBeUndefined();
  });
});

describe("parsePgMajor", () => {
  test("dotted version string -> major number", () => {
    expect(parsePgMajor("15.8")).toBe(15);
    expect(parsePgMajor("17.6.1.140")).toBe(17);
  });

  test("server_version_num style 6-digit", () => {
    expect(parsePgMajor("160002")).toBe(16);
  });

  test("server_version_num style 5-digit (PG9)", () => {
    expect(parsePgMajor("90618")).toBe(9);
  });

  test("full banner string -> major", () => {
    expect(parsePgMajor("PostgreSQL 15.8 (Debian 15.8-1.pgdg24.04+1) on x86_64-pc-linux-gnu")).toBe(
      15,
    );
  });

  test("empty/blank -> null", () => {
    expect(parsePgMajor("")).toBeNull();
  });

  test("unparseable garbage -> null", () => {
    expect(parsePgMajor("not-a-version")).toBeNull();
  });
});
