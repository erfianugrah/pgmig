/**
 * The platform's in-place major upgrade, timed at a chosen data size, as the
 * comparison arm for a pgmig major-version move (live.harness.ts with
 * SRC_ENGINE=15).
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... bun run test/inplace-upgrade.harness.ts <org-id> [rows]
 *
 * Creates ONE throwaway project on Postgres SRC_ENGINE (default 15), loads the
 * annoying schema and seeds it with the same generator live.harness.ts uses,
 * reads the upgrade eligibility estimate, POSTs the upgrade to TARGET_VERSION
 * (default 17), and while it runs:
 *   - every 2 s opens a fresh session-pooler connection and runs
 *     `select version(), pg_postmaster_start_time()` (availability + which server),
 *   - every 1 s inserts a numbered row into public.upgrade_probe and records the
 *     ids the server acknowledged, with the server version that acknowledged them,
 *   - every 10 s reads the upgrade status.
 * After ACTIVE_HEALTHY on the new major plus a settle, it counts which
 * acknowledged ids exist. Deletes the project in `finally`. Costs money while
 * the project exists. Env: SRC_ENGINE, TARGET_VERSION, REGION, INSTANCE_SIZE,
 * DISK_GB (grow before seeding), SETTLE_SEC (180).
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { log } from "../src/log.ts";
import { MgmtApi } from "../src/mgmt.ts";
import { createSchema, seedSource } from "./annoying-schema.ts";
import { growDisk } from "./disk.ts";

const ORG_ID = process.argv[2] ?? "";
if (!ORG_ID) {
  console.error("usage: bun run test/inplace-upgrade.harness.ts <org-id> [rows]");
  process.exit(1);
}
const ROWS = Number(process.argv[3] ?? 50_000);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOKEN.startsWith("sbp_")) {
  console.error("SUPABASE_ACCESS_TOKEN (sbp_...) is required");
  process.exit(1);
}
const SRC_ENGINE = process.env.SRC_ENGINE || "15";
const TARGET_VERSION = process.env.TARGET_VERSION || "17";
const REGION = process.env.REGION || "ap-southeast-1";
const INSTANCE_SIZE = process.env.INSTANCE_SIZE || undefined;
const SETTLE_SEC = Number(process.env.SETTLE_SEC ?? 180);
const DISK_GB = Number(process.env.DISK_GB || 0);
// Acknowledged probe ids are written here before the survival check, so a failed check can be redone by hand.
const ACKED_FILE = process.env.ACKED_FILE || "";
const API = "https://api.supabase.com/v1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (t0: number): number => Math.round((Date.now() - t0) / 100) / 10;
const short = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 80);

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {}
  return { status: res.status, json, text };
}

async function main(): Promise<void> {
  const mg = new MgmtApi(TOKEN);
  let ref = "";
  try {
    const pw = randomBytes(21).toString("base64").replace(/[/+=]/g, "").slice(0, 28);
    log.step(
      `creating project (pg${SRC_ENGINE}, ${REGION}${INSTANCE_SIZE ? `, ${INSTANCE_SIZE}` : ""})`,
    );
    ref = await mg.createProject("pgmig-inplace", ORG_ID, pw, REGION, {
      postgresEngine: SRC_ENGINE,
      instanceSize: INSTANCE_SIZE,
    });
    await mg.waitHealthy([ref], { pollSec: 15, timeoutMin: 15 });
    if (DISK_GB) log.ok(`disk grown to ${DISK_GB} GB in ${await growDisk(mg, ref, DISK_GB)} s`);
    await sleep(20_000);
    const pooler = await mg.getPooler(ref);
    const url = `postgresql://${pooler.user}:${pw}@${pooler.host}:5432/postgres?sslmode=require`;
    const db = postgres(url, {
      max: 3,
      connect_timeout: 30,
      idle_timeout: 20,
      prepare: false,
      onnotice: () => {},
    });
    try {
      const [v] = await db`SELECT version() AS v`;
      log.ok(`project ${ref}: ${String(v?.v ?? "").slice(0, 40)}`);
      await createSchema(db);
      const tSeed = Date.now();
      await seedSource(db, ROWS);
      await db.unsafe(
        "CREATE TABLE public.upgrade_probe (id int PRIMARY KEY, acked_by text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())",
      );
      const [sz] = await db`SELECT pg_database_size(current_database())::bigint AS b`;
      log.ok(
        `seeded ${ROWS.toLocaleString()} documents in ${secs(tSeed)} s; database ${(Number(sz?.b ?? 0) / 1024 ** 3).toFixed(2)} GB`,
      );
    } finally {
      await db.end({ timeout: 5 });
    }

    const elig = await api<{
      eligible?: boolean;
      duration_estimate_hours?: number;
      target_upgrade_versions?: unknown;
    }>("GET", `/projects/${ref}/upgrade/eligibility`);
    log.ok(
      `eligibility HTTP ${elig.status}: eligible ${elig.json?.eligible}, duration_estimate_hours ${elig.json?.duration_estimate_hours}, targets ${JSON.stringify(elig.json?.target_upgrade_versions ?? null).slice(0, 160)}`,
    );

    // Probe loops run until `stop`.
    let stop = false;
    const acked: { id: number; by: string; t: number }[] = [];
    const avail: { t: number; ok: boolean; by: string }[] = [];
    const stages: string[] = [];
    const t0 = Date.now();
    const oneShot = () =>
      postgres(url, {
        max: 1,
        connect_timeout: 5,
        idle_timeout: 1,
        prepare: false,
        onnotice: () => {},
      });
    const writer = (async () => {
      for (let id = 1; !stop; id++) {
        const c = oneShot();
        try {
          const [r] = await c.unsafe(
            `INSERT INTO public.upgrade_probe (id, acked_by) VALUES (${id}, split_part(version(), ' ', 2) || '@' || extract(epoch from pg_postmaster_start_time())::bigint) RETURNING acked_by`,
          );
          acked.push({ id, by: String(r?.acked_by ?? "?"), t: secs(t0) });
        } catch {
          /* refused or failed: not acknowledged */
        } finally {
          await c.end({ timeout: 1 }).catch(() => {});
        }
        await sleep(1_000);
      }
    })();
    const sampler = (async () => {
      while (!stop) {
        const c = oneShot();
        try {
          const [r] =
            await c`SELECT split_part(version(), ' ', 2) || '@' || extract(epoch from pg_postmaster_start_time())::bigint AS by`;
          avail.push({ t: secs(t0), ok: true, by: String(r?.by ?? "?") });
        } catch (e) {
          avail.push({ t: secs(t0), ok: false, by: short(e) });
        } finally {
          await c.end({ timeout: 1 }).catch(() => {});
        }
        await sleep(2_000);
      }
    })();

    const up = await api<{ tracking_id?: string }>("POST", `/projects/${ref}/upgrade`, {
      target_version: TARGET_VERSION,
      release_channel: "ga",
    });
    log.ok(`upgrade POST HTTP ${up.status} ${up.text.slice(0, 120)}`);
    if (up.status >= 300) throw new Error("upgrade POST refused");

    let healthyS: number | string = "never";
    let lastStage = "";
    const deadline = Date.now() + 6 * 3600_000;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const st = await api<{
        databaseUpgradeStatus?: {
          progress?: string;
          status?: number | string;
          error?: string;
        } | null;
      }>("GET", `/projects/${ref}/upgrade/status`);
      const s = st.json?.databaseUpgradeStatus;
      const stage = `${s?.status ?? "?"}/${s?.progress ?? "?"}${s?.error ? ` err=${s.error}` : ""}`;
      if (stage !== lastStage) {
        stages.push(`+${secs(t0)}s ${stage}`);
        log.detail(`+${secs(t0)}s ${stage}`);
        lastStage = stage;
      }
      const p = await mg.getProject(ref).catch(() => ({ status: "?" }));
      const lastAvail = avail[avail.length - 1];
      if (
        p.status === "ACTIVE_HEALTHY" &&
        lastAvail?.ok &&
        lastAvail.by.startsWith(TARGET_VERSION)
      ) {
        healthyS = secs(t0);
        break;
      }
      if (s?.error) break;
    }
    log.ok(
      `ACTIVE_HEALTHY on ${TARGET_VERSION} at ${healthyS} s after the POST; settling ${SETTLE_SEC} s`,
    );
    await sleep(SETTLE_SEC * 1000);
    stop = true;
    await Promise.all([writer, sampler]);

    // Availability: the longest run of failed samples, and every distinct server seen.
    let worst = { from: 0, to: 0 };
    let cur: { from: number; to: number } | null = null;
    for (const a of avail) {
      if (!a.ok) {
        cur = cur ? { from: cur.from, to: a.t } : { from: a.t, to: a.t };
        if (cur.to - cur.from > worst.to - worst.from) worst = { ...cur };
      } else cur = null;
    }
    const firstFail = avail.find((a) => !a.ok)?.t ?? "none";
    const firstNew = avail.find((a) => a.ok && a.by.startsWith(TARGET_VERSION))?.t ?? "never";
    const servers = [...new Set(avail.filter((a) => a.ok).map((a) => a.by))];
    log.ok(
      `availability: first failed sample +${firstFail}s, longest failed run +${worst.from}s..+${worst.to}s, first ${TARGET_VERSION} answer +${firstNew}s; servers seen ${servers.join(", ")}`,
    );

    if (ACKED_FILE)
      writeFileSync(ACKED_FILE, JSON.stringify({ ref, acked, avail, stages }, null, 1));
    // Which acknowledged writes survived on the upgraded server. The read is
    // retried: a run on 2026-11-09 lost its check to a one-off getaddrinfo ENOTFOUND.
    const check = postgres(url, {
      max: 1,
      connect_timeout: 30,
      prepare: false,
      onnotice: () => {},
    });
    try {
      let rows: { id: number }[] = [];
      for (let i = 0; ; i++) {
        try {
          rows = (await check`SELECT id FROM public.upgrade_probe`) as unknown as { id: number }[];
          break;
        } catch (e) {
          if (i >= 5) throw e;
          log.warn(`survival check read failed (${short(e)}); retrying in 10 s`);
          await sleep(10_000);
        }
      }
      const have = new Set(rows.map((r) => Number(r.id)));
      const byServer: Record<string, { acked: number; lost: number }> = {};
      for (const a of acked) {
        byServer[a.by] ??= { acked: 0, lost: 0 };
        const b = byServer[a.by] as { acked: number; lost: number };
        b.acked++;
        if (!have.has(a.id)) b.lost++;
      }
      const lost = acked.filter((a) => !have.has(a.id));
      log.ok(
        `probe writes: ${acked.length} acknowledged, ${lost.length} absent after the upgrade; by server ${JSON.stringify(byServer)}`,
      );
      if (lost.length)
        log.warn(
          `absent ids (t = s after POST): ${lost
            .map((a) => `${a.id}@${a.t}s(${a.by})`)
            .join(" ")
            .slice(0, 1500)}`,
        );
    } finally {
      await check.end({ timeout: 5 });
    }
    log.ok(`stages: ${stages.join(" | ")}`);
  } finally {
    if (ref) {
      log.step("teardown: deleting the throwaway project");
      await mg.deleteProject(ref).then(() => log.ok(`deleted ${ref}`));
    }
  }
}

await main();
