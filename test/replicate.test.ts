import { describe, expect, test } from "bun:test";
import {
  SERVICE_OWNED_SCHEMAS,
  serviceOwnedTables,
  syncSlotConflict,
} from "../src/steps/replicate.ts";

describe("serviceOwnedTables", () => {
  test("flags auth/storage/realtime/vault tables, keeps app schemas", () => {
    expect(
      serviceOwnedTables([
        "public.orders",
        "auth.users",
        "storage.objects",
        "realtime.messages",
        "vault.secrets",
        "app.events",
      ]),
    ).toEqual(["auth.users", "storage.objects", "realtime.messages", "vault.secrets"]);
  });

  test("schemas that only look managed (pgmq queues, extensions) are not refused", () => {
    expect(serviceOwnedTables(["pgmq.q_jobs", "extensions.spatial_ref_sys", "cron.job"])).toEqual(
      [],
    );
  });

  test("every listed schema is matched exactly, not as a prefix", () => {
    for (const s of SERVICE_OWNED_SCHEMAS)
      expect(serviceOwnedTables([`${s}.t`])).toEqual([`${s}.t`]);
    expect(serviceOwnedTables(["authz.users", "storage_app.files"])).toEqual([]);
  });
});

describe("syncSlotConflict", () => {
  test("no slots or only ordinary slots -> null", () => {
    expect(syncSlotConflict([])).toBeNull();
    expect(
      syncSlotConflict([
        { slot_name: "itest_slot", active: true },
        { slot_name: "supabase_realtime_replication_slot", active: true },
      ]),
    ).toBeNull();
  });

  test("a tablesync slot from another subscription -> message naming it, its state and the cleanup", () => {
    const m = syncSlotConflict([
      { slot_name: "pg_17650_sync_17643_7703759698107299042", active: true },
      { slot_name: "itest_slot", active: false },
    ]);
    expect(m).toContain("pg_17650_sync_17643_7703759698107299042 (active)");
    expect(m).not.toContain("itest_slot");
    expect(m).toContain("one at a time");
    expect(m).toContain("pg_drop_replication_slot");
  });

  test("an inactive tablesync slot is still refused (a stuck target retries between attempts)", () => {
    const m = syncSlotConflict([{ slot_name: "pg_1_sync_2_3", active: false }]);
    expect(m).toContain("pg_1_sync_2_3 (inactive)");
  });

  test("names that only resemble the tablesync pattern are ignored", () => {
    expect(syncSlotConflict([{ slot_name: "pg_sync_backup", active: true }])).toBeNull();
    expect(syncSlotConflict([{ slot_name: "pg_1_sync_2", active: true }])).toBeNull();
  });
});
