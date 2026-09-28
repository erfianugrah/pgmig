import { describe, expect, test } from "bun:test";
import {
  dumpAuthDataCmd,
  dumpRolesCmd,
  dumpSchemaCmd,
  extensionStatements,
  filterSupabaseRoles,
  filterSupabaseSchema,
  isSupabaseSource,
  missingExtensions,
  redactArgv,
  redactUrl,
  restoreAuthDataCmd,
  restoreRolesCmd,
  restoreSchemaCmd,
  SUPABASE_MANAGED_SCHEMAS,
  SUPABASE_RESERVED_ROLES,
} from "../src/steps/bootstrap.ts";
import { externalDepDumpCommand } from "../src/steps/doctor.ts";

describe("missingExtensions", () => {
  test("returns source extensions absent on target, sorted", () => {
    expect(missingExtensions(["postgis", "pg_trgm", "citext"], ["citext"])).toEqual([
      "pg_trgm",
      "postgis",
    ]);
  });

  test("excludes the always-present plpgsql", () => {
    expect(missingExtensions(["plpgsql", "pg_trgm"], [])).toEqual(["pg_trgm"]);
  });

  test("empty when target already has everything", () => {
    expect(missingExtensions(["pg_trgm"], ["pg_trgm", "plpgsql"])).toEqual([]);
  });
});

describe("extensionStatements", () => {
  test("idempotent CREATE EXTENSION, identifier-quoted (hyphenated names safe)", () => {
    expect(extensionStatements(["pg_trgm", "uuid-ossp"])).toEqual([
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm";',
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
    ]);
  });

  test("empty input → no statements", () => {
    expect(extensionStatements([])).toEqual([]);
  });
});

describe("redactUrl / redactArgv", () => {
  test("redacts the password in a connection URL", () => {
    expect(redactUrl("postgresql://postgres:s3cr3t@db.host:5432/postgres")).toBe(
      "postgresql://postgres:***@db.host:5432/postgres",
    );
  });

  test("leaves a passwordless URL untouched", () => {
    expect(redactUrl("postgresql://postgres@db.host:5432/postgres")).toBe(
      "postgresql://postgres@db.host:5432/postgres",
    );
  });

  test("non-URL strings pass through", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });

  test("redactArgv only redacts URL-shaped args, preserves the rest", () => {
    const argv = ["pg_dump", "--schema-only", "-d", "postgresql://u:pw@h/db", "-f", "out.sql"];
    expect(redactArgv(argv)).toBe("pg_dump --schema-only -d postgresql://u:***@h/db -f out.sql");
  });
});

describe("dump/restore command builders", () => {
  const SRC = "postgresql://u:pw@src/postgres";
  const TGT = "postgresql://u:pw@tgt/postgres";

  test("dumpRolesCmd: roles-only, no passwords, quoted identifiers (for the role filter)", () => {
    expect(dumpRolesCmd(SRC, "/o/roles.sql")).toEqual([
      "pg_dumpall",
      "--roles-only",
      "--no-role-passwords",
      "--quote-all-identifiers",
      "--no-comments",
      "-d",
      SRC,
      "-f",
      "/o/roles.sql",
    ]);
  });

  test("dumpSchemaCmd: schema-only, strips pgmig-managed pub/sub + owners/ACLs", () => {
    expect(dumpSchemaCmd(SRC, "/o/schema.sql")).toEqual([
      "pg_dump",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-publications",
      "--no-subscriptions",
      "-d",
      SRC,
      "-f",
      "/o/schema.sql",
    ]);
  });

  test("dumpSchemaCmd: excludeSchemas emits one --exclude-schema per schema (Supabase source)", () => {
    const cmd = dumpSchemaCmd(SRC, "/o/schema.sql", ["auth", "storage"]);
    expect(cmd).toContain("--exclude-schema=auth");
    expect(cmd).toContain("--exclude-schema=storage");
    // exclusions sit before the connection/file args
    expect(cmd.indexOf("--exclude-schema=auth")).toBeLessThan(cmd.indexOf("-d"));
  });

  test("restoreRolesCmd: lenient (ON_ERROR_STOP=0, no single-transaction) — roles may pre-exist", () => {
    expect(restoreRolesCmd(TGT, "/o/roles.sql")).toEqual([
      "psql",
      "--variable",
      "ON_ERROR_STOP=0",
      "-d",
      TGT,
      "-f",
      "/o/roles.sql",
    ]);
  });

  test("restoreSchemaCmd: atomic, stop-on-error", () => {
    expect(restoreSchemaCmd(TGT, "/o/schema.sql")).toEqual([
      "psql",
      "--variable",
      "ON_ERROR_STOP=1",
      "--single-transaction",
      "-d",
      TGT,
      "-f",
      "/o/schema.sql",
    ]);
  });

  test("dumpAuthDataCmd: data-only, defaults to the auth schema", () => {
    expect(dumpAuthDataCmd(SRC, "/o/auth.sql")).toEqual([
      "pg_dump",
      "--data-only",
      "--no-owner",
      "--no-privileges",
      "--exclude-table-data=auth.schema_migrations",
      "--schema=auth",
      "-d",
      SRC,
      "-f",
      "/o/auth.sql",
    ]);
  });

  test("dumpAuthDataCmd: excludes auth.schema_migrations (SELECT-only for postgres on managed targets)", () => {
    expect(dumpAuthDataCmd(SRC, "/o/auth.sql")).toContain(
      "--exclude-table-data=auth.schema_migrations",
    );
  });

  test("dumpAuthDataCmd: multiple dep schemas emit one --schema each, no --disable-triggers", () => {
    const cmd = dumpAuthDataCmd(SRC, "/o/auth.sql", ["auth", "storage"]);
    expect(cmd.filter((a) => a.startsWith("--schema="))).toEqual([
      "--schema=auth",
      "--schema=storage",
    ]);
    expect(cmd).not.toContain("--disable-triggers");
  });

  test("restoreAuthDataCmd: defers FK triggers via session_replication_role, atomic", () => {
    expect(restoreAuthDataCmd(TGT, "/o/auth.sql")).toEqual([
      "psql",
      "--single-transaction",
      "--variable",
      "ON_ERROR_STOP=1",
      "--command",
      "SET session_replication_role = replica",
      "-f",
      "/o/auth.sql",
      "-d",
      TGT,
    ]);
  });
});

describe("isSupabaseSource", () => {
  test("direct Supabase host", () => {
    expect(
      isSupabaseSource("postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres"),
    ).toBe(true);
  });
  test("Supavisor pooler host", () => {
    expect(
      isSupabaseSource(
        "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
      ),
    ).toBe(true);
  });
  test("plain Postgres host is NOT Supabase (full dump)", () => {
    expect(isSupabaseSource("postgresql://u:pw@localhost:5432/postgres")).toBe(false);
  });
});

describe("SUPABASE_MANAGED_SCHEMAS", () => {
  test("covers the schemas a real Supabase pg_dump emits", () => {
    for (const s of ["auth", "storage", "extensions", "graphql", "realtime", "vault", "pgbouncer"])
      expect(SUPABASE_MANAGED_SCHEMAS).toContain(s);
  });
});

describe("filterSupabaseRoles", () => {
  test("keeps app roles, comments out reserved CREATE ROLE", () => {
    const dump = [
      'CREATE ROLE "anon";',
      'CREATE ROLE "authenticated";',
      'CREATE ROLE "supabase_admin";',
      'CREATE ROLE "app_worker";',
      'CREATE ROLE "postgres";',
    ].join("\n");
    const out = filterSupabaseRoles(dump);
    expect(out).toContain('CREATE ROLE "app_worker";');
    expect(out).toContain('-- CREATE ROLE "anon";');
    expect(out).toContain('-- CREATE ROLE "authenticated";');
    expect(out).toContain('-- CREATE ROLE "supabase_admin";'); // supabase_.* wildcard
    expect(out).toContain('-- CREATE ROLE "postgres";');
  });

  test("strips NOSUPERUSER / NOREPLICATION attributes", () => {
    const out = filterSupabaseRoles(
      'ALTER ROLE "app_worker" WITH NOSUPERUSER NOREPLICATION LOGIN;',
    );
    expect(out).toContain('ALTER ROLE "app_worker" WITH LOGIN;');
    expect(out).not.toContain("NOSUPERUSER");
    expect(out).not.toContain("NOREPLICATION");
  });

  test("re-enables a safe SET on a reserved role (allowed config)", () => {
    const out = filterSupabaseRoles('ALTER ROLE "postgres" SET "statement_timeout" TO \'30s\';');
    // commented as a reserved ALTER, then re-enabled because statement_timeout is allowed
    expect(out).toContain('ALTER ROLE "postgres" SET "statement_timeout" TO \'30s\';');
    expect(out).not.toContain('-- ALTER ROLE "postgres" SET "statement_timeout"');
  });

  test("leaves an unsafe SET on a reserved role commented out", () => {
    const out = filterSupabaseRoles('ALTER ROLE "postgres" SET "log_statement" TO \'all\';');
    expect(out).toContain('-- ALTER ROLE "postgres" SET "log_statement" TO \'all\';');
  });

  test("comments out GRANT ... TO a reserved role", () => {
    const out = filterSupabaseRoles('GRANT "app_worker" TO "supabase_admin";');
    expect(out).toContain('-- GRANT "app_worker" TO "supabase_admin";');
  });

  test("comments out \\restrict / \\unrestrict psql meta-commands", () => {
    const out = filterSupabaseRoles("\\restrict abc123\n\\unrestrict abc123");
    expect(out).toContain("-- \\restrict abc123");
    expect(out).toContain("-- \\unrestrict abc123");
  });

  test("always appends RESET ALL;", () => {
    expect(filterSupabaseRoles("").trimEnd().endsWith("RESET ALL;")).toBe(true);
  });

  test("reserved list matches the verified Supabase CLI source", () => {
    for (const r of ["anon", "authenticated", "service_role", "supabase_.*", "postgres"])
      expect(SUPABASE_RESERVED_ROLES).toContain(r);
  });
});

describe("filterSupabaseSchema", () => {
  test("comments out a multi-line event trigger (CREATE + WHEN TAG IN + EXECUTE FUNCTION)", () => {
    const dump = [
      "CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop",
      "         WHEN TAG IN ('DROP EXTENSION')",
      "   EXECUTE FUNCTION extensions.set_graphql_placeholder();",
    ].join("\n");
    const out = filterSupabaseSchema(dump);
    expect(out).toContain("-- CREATE EVENT TRIGGER issue_graphql_placeholder");
    expect(out).toContain("--          WHEN TAG IN");
    expect(out).toContain("--    EXECUTE FUNCTION extensions.set_graphql_placeholder();");
    expect(out).not.toMatch(/^CREATE EVENT TRIGGER/m);
    expect(out).not.toMatch(/^ {3}EXECUTE FUNCTION/m);
  });

  test("comments out SET transaction_timeout (pg17 GUC) and COMMENT ON EXTENSION", () => {
    const out = filterSupabaseSchema(
      "SET transaction_timeout = 0;\nCOMMENT ON EXTENSION citext IS 'ci text';",
    );
    expect(out).toContain("-- SET transaction_timeout = 0;");
    expect(out).toContain("-- COMMENT ON EXTENSION citext");
  });

  test("comments out ALTER EVENT TRIGGER and the supabase_realtime publication", () => {
    const out = filterSupabaseSchema(
      'ALTER EVENT TRIGGER "x" OWNER TO "y";\nCREATE PUBLICATION "supabase_realtime" FOR ALL TABLES;',
    );
    expect(out).toContain('-- ALTER EVENT TRIGGER "x"');
    expect(out).toContain('-- CREATE PUBLICATION "supabase_realtime"');
  });

  test("makes CREATE SCHEMA/TABLE idempotent, VIEW/FUNCTION/TRIGGER replaceable", () => {
    const out = filterSupabaseSchema(
      [
        'CREATE SCHEMA "public";',
        'CREATE TABLE "public"."t" (id int);',
        'CREATE VIEW "public"."v" AS SELECT 1;',
        'CREATE FUNCTION "public"."f"() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
      ].join("\n"),
    );
    expect(out).toContain('CREATE SCHEMA IF NOT EXISTS "public";');
    expect(out).toContain('CREATE TABLE IF NOT EXISTS "public"."t"');
    expect(out).toContain('CREATE OR REPLACE VIEW "public"."v"');
    expect(out).toContain('CREATE OR REPLACE FUNCTION "public"."f"');
  });

  test("strips the version clause off the pg_tle/pgsodium/pgmq CREATE EXTENSION lines", () => {
    const out = filterSupabaseSchema(
      'CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium" VERSION \'3.1.8\';',
    );
    expect(out).toContain('CREATE EXTENSION IF NOT EXISTS "pgsodium";');
    expect(out).not.toContain("VERSION");
  });

  test("leaves an ordinary app table/trigger intact (idempotent rewrite aside)", () => {
    const out = filterSupabaseSchema(
      'CREATE OR REPLACE TRIGGER "audit_trg" AFTER INSERT ON "public"."t" FOR EACH ROW EXECUTE FUNCTION "public"."audit"();',
    );
    // single-line regular trigger: EXECUTE FUNCTION is mid-line, must NOT be commented
    expect(out).not.toMatch(/^-- /);
    expect(out).toContain('CREATE OR REPLACE TRIGGER "audit_trg"');
  });
});

describe("externalDepDumpCommand (doctor remediation)", () => {
  test("dedups + sorts the schemas behind the FK deps", () => {
    const cmd = externalDepDumpCommand(["auth.users", "storage.objects", "auth.identities"]);
    expect(cmd).toContain("--schema auth,storage");
    expect(cmd).toContain("SET session_replication_role = replica");
  });

  test("single schema", () => {
    expect(externalDepDumpCommand(["auth.users"])).toContain("--schema auth");
  });
});
