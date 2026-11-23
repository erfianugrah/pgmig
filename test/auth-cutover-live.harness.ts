/**
 * Live check of `cutover --with-auth-data` against a REAL cross-region pair.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... bun run test/auth-cutover-live.harness.ts <org-slug> [rows]
 *
 * The integration tier proves the auth reload on docker; this proves it between
 * two managed projects in different regions, with GoTrue on both ends:
 *
 *   1. Before bootstrap, on the source: user A logs in (password); user B logs in
 *      and completes a TOTP challenge (an aal2 session).
 *   2. bootstrap --with-auth-data copies a snapshot of those rows.
 *   3. After bootstrap, on the source: user C is created and A's session is
 *      refreshed, so C and A's new refresh token exist only on the source.
 *      Control: at the target, C's password login and A's new refresh token are
 *      both refused before cutover.
 *   4. replicate, watch, reconcile, then cutover with the auth reload (timed; no
 *      writer runs, so the duration is the write-stop before the app repoint).
 *   5. At the target: A and C log in (200), A's post-bootstrap refresh token
 *      refreshes (200), B's refresh token refreshes and the new access token
 *      still says aal2 with a totp amr entry.
 *
 * Creates two Micro projects (SRC_REGION, TGT_REGION; default ap-southeast-1 ->
 * ap-northeast-1) and deletes both in the finally block. Costs real money for
 * the few minutes they exist.
 */
import { createHmac, randomBytes } from "node:crypto";
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { log } from "../src/log.ts";
import { MgmtApi } from "../src/mgmt.ts";
import { bootstrap } from "../src/steps/bootstrap.ts";
import { cutover } from "../src/steps/cutover.ts";
import { doctor } from "../src/steps/doctor.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { watch } from "../src/steps/watch.ts";
import { createSchema, seedSource } from "./annoying-schema.ts";
import { diagnose } from "./live-diagnose.ts";

const ORG = process.argv[2] ?? "";
if (!ORG) {
  console.error("usage: bun run test/auth-cutover-live.harness.ts <org-slug> [rows]");
  process.exit(1);
}
const ROWS = Number(process.argv[3] ?? 5_000);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOKEN.startsWith("sbp_")) {
  console.error("SUPABASE_ACCESS_TOKEN (sbp_...) is required");
  process.exit(1);
}
const SRC_REGION = process.env.SRC_REGION ?? "ap-southeast-1";
const TGT_REGION = process.env.TGT_REGION ?? "ap-northeast-1";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/pgmig-auth-cutover-live";
const TABLES = ["public.users", "public.documents", "public.events", "public.audit"];

const secs = (t0: number): number => Math.round((Date.now() - t0) / 100) / 10;
const randPw = () => randomBytes(21).toString("base64").replace(/[/+=]/g, "").slice(0, 28);

/** What the run measured, printed as one JSON line at the end for the RUNLOG. */
const result: Record<string, unknown> = {
  srcRegion: SRC_REGION,
  tgtRegion: TGT_REGION,
  rows: ROWS,
};

// ------------------------------------------------------------------ auth HTTP

interface Keys {
  anon: string;
  service: string;
}

async function keys(ref: string): Promise<Keys> {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const arr = (await r.json()) as Array<{ name: string; api_key: string }>;
  const anon = arr.find((k) => k.name === "anon")?.api_key ?? "";
  const service = arr.find((k) => k.name === "service_role")?.api_key ?? "";
  if (!anon || !service) throw new Error(`api-keys for ${ref}: HTTP ${r.status}`);
  return { anon, service };
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
}

async function auth(
  ref: string,
  path: string,
  apikey: string,
  body?: unknown,
  bearer?: string,
): Promise<Resp> {
  const r = await fetch(`https://${ref}.supabase.co/auth/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      apikey,
      Authorization: `Bearer ${bearer ?? apikey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body: parsed };
}

const login = (ref: string, k: Keys, email: string, password: string) =>
  auth(ref, "/token?grant_type=password", k.anon, { email, password });
const refresh = (ref: string, k: Keys, rt: string) =>
  auth(ref, "/token?grant_type=refresh_token", k.anon, { refresh_token: rt });

function claims(jwt: string): Record<string, unknown> {
  const p = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
}

function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretB32.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", bytes).update(counter).digest();
  const o = (h[h.length - 1] ?? 0) & 0xf;
  const n = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return n.padStart(6, "0");
}

function check(name: string, cond: boolean, detail: string): void {
  (result.checks as Record<string, string>)[name] = `${cond ? "PASS" : "FAIL"} ${detail}`;
  if (cond) log.ok(`${name}: ${detail}`);
  else log.warn(`${name}: ${detail}`);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const api = new MgmtApi(TOKEN);
  let srcRef = "";
  let tgtRef = "";
  result.checks = {};
  try {
    const srcPw = randPw();
    const tgtPw = randPw();
    log.step(`creating projects (src=${SRC_REGION} tgt=${TGT_REGION} micro)`);
    const tCreate = Date.now();
    [srcRef, tgtRef] = await Promise.all([
      api.createProject("pgmig-authcut-src", ORG, srcPw, SRC_REGION, { instanceSize: "micro" }),
      api.createProject("pgmig-authcut-tgt", ORG, tgtPw, TGT_REGION, { instanceSize: "micro" }),
    ]);
    await api.waitHealthy([srcRef, tgtRef], { pollSec: 10, timeoutMin: 15 });
    result.createToHealthyS = secs(tCreate);
    // ACTIVE_HEALTHY can arrive before db.<ref> resolves (supabase-lab region-move,
    // 2026-11-23: ENOTFOUND right after the status flipped). Wait for both names.
    for (const ref of [srcRef, tgtRef]) {
      for (let i = 0; ; i++) {
        // dig, not getaddrinfo: a machine with no global IPv6 address gets no
        // answer for the IPv6-only name from the system resolver at all.
        const aaaa = (await Bun.$`dig +short AAAA db.${ref}.supabase.co`.quiet().nothrow()).stdout
          .toString()
          .trim();
        if (aaaa) break;
        if (i > 120) throw new Error(`db.${ref}.supabase.co never resolved`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    result.createToResolvableS = secs(tCreate);
    await new Promise((r) => setTimeout(r, 20_000));

    const [srcPooler, tgtPooler] = await Promise.all([
      api.getPooler(srcRef),
      api.getPooler(tgtRef),
    ]);
    const srcPool = `postgresql://${srcPooler.user}:${srcPw}@${srcPooler.host}:5432/postgres?sslmode=require`;
    const tgtPool = `postgresql://${tgtPooler.user}:${tgtPw}@${tgtPooler.host}:5432/postgres?sslmode=require`;
    const srcDirect = `postgresql://postgres:${srcPw}@db.${srcRef}.supabase.co:5432/postgres?sslmode=require`;
    const secrets = SecretsSchema.parse({
      SOURCE_DB_URL: srcPool,
      TARGET_DB_URL: tgtPool,
      SOURCE_REPLICATION_URL: srcDirect,
      SUPABASE_ACCESS_TOKEN: TOKEN,
    });
    const cfg = ConfigSchema.parse({
      source: { ref: srcRef },
      target: { ref: tgtRef },
      replication: {
        publication: "pgmig_pub",
        slot: "pgmig_slot",
        subscription: "pgmig_sub",
        copyData: true,
        tables: TABLES,
      },
      reconcile: { tables: TABLES.map((name) => ({ name })) },
      watchdog: { maxRetainedWalMb: 4096, pollIntervalSec: 5, syncTimeoutMin: 30 },
    });
    const [sk, tk] = await Promise.all([keys(srcRef), keys(tgtRef)]);
    const { source, target, close } = connect(secrets);

    try {
      // Status is not readiness: wait for a real login through each pooler.
      for (const [name, db] of [
        ["source", source],
        ["target", target],
      ] as const) {
        for (let i = 0; ; i++) {
          try {
            await db`select 1`;
            break;
          } catch (e) {
            if (i > 120) throw new Error(`${name} pooler never accepted a login: ${String(e)}`);
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }
      }
      result.createToLoginS = secs(tCreate);
      // 1. sessions on the source, before the snapshot
      const pwA = randPw();
      const pwB = randPw();
      const pwC = randPw();
      const A = `a-${Date.now()}@example.com`;
      const B = `b-${Date.now()}@example.com`;
      const C = `c-${Date.now()}@example.com`;
      for (const [email, password] of [
        [A, pwA],
        [B, pwB],
      ] as const) {
        const r = await auth(srcRef, "/admin/users", sk.service, {
          email,
          password,
          email_confirm: true,
        });
        if (r.status >= 300)
          throw new Error(`create ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      const a0 = await login(srcRef, sk, A, pwA);
      if (a0.status !== 200) throw new Error(`A login at source: ${a0.status}`);
      const b0 = await login(srcRef, sk, B, pwB);
      if (b0.status !== 200) throw new Error(`B login at source: ${b0.status}`);

      let bRefresh = "";
      const enroll = await auth(
        srcRef,
        "/factors",
        sk.anon,
        { factor_type: "totp" },
        String(b0.body.access_token),
      );
      const factorId = String(enroll.body.id ?? "");
      const secret = String((enroll.body.totp as { secret?: string } | undefined)?.secret ?? "");
      if (enroll.status === 200 && factorId && secret) {
        const ch = await auth(
          srcRef,
          `/factors/${factorId}/challenge`,
          sk.anon,
          {},
          String(b0.body.access_token),
        );
        const v = await auth(
          srcRef,
          `/factors/${factorId}/verify`,
          sk.anon,
          { challenge_id: ch.body.id, code: totp(secret) },
          String(b0.body.access_token),
        );
        if (v.status === 200) {
          bRefresh = String(v.body.refresh_token);
          const c = claims(String(v.body.access_token));
          result.bSourceAal = c.aal;
          log.ok(`B enrolled TOTP; source session aal=${String(c.aal)}`);
        } else {
          result.bTotp = `verify ${v.status} ${JSON.stringify(v.body).slice(0, 200)}`;
        }
      } else {
        result.bTotp = `enroll ${enroll.status} ${JSON.stringify(enroll.body).slice(0, 200)}`;
      }

      // 2. schema + auth snapshot
      log.step("loading schema on the SOURCE, then bootstrap --with-auth-data");
      await createSchema(source);
      const tBoot = Date.now();
      const boot = await bootstrap(source, target, cfg, secrets, {
        confirm: true,
        outDir: `${OUT_DIR}/bootstrap`,
        withAuthData: true,
      });
      if (!boot.ok) throw new Error("bootstrap FAILED");
      result.bootstrapS = secs(tBoot);

      // 3. auth writes after the snapshot
      const rc = await auth(srcRef, "/admin/users", sk.service, {
        email: C,
        password: pwC,
        email_confirm: true,
      });
      if (rc.status >= 300) throw new Error(`create C: ${rc.status}`);
      const a1 = await refresh(srcRef, sk, String(a0.body.refresh_token));
      if (a1.status !== 200) throw new Error(`A refresh at source: ${a1.status}`);
      const aRefresh = String(a1.body.refresh_token);

      const preC = await login(tgtRef, tk, C, pwC);
      check(
        "control: C login at target before cutover",
        preC.status !== 200,
        `HTTP ${preC.status} ${String(preC.body.error_code ?? preC.body.error ?? "")}`,
      );
      const preA = await refresh(tgtRef, tk, aRefresh);
      check(
        "control: A's post-snapshot refresh token at target before cutover",
        preA.status !== 200,
        `HTTP ${preA.status} ${String(preA.body.error_code ?? preA.body.error ?? "")}`,
      );

      // 4. data + pipeline
      log.step(`seeding source (${ROWS} documents + deps)`);
      await seedSource(source, ROWS);
      await doctor(cfg, secrets);
      await preflight(source, target, cfg);
      const tCopy = Date.now();
      await replicate(source, target, cfg, secrets);
      await watch(source, target, cfg);
      result.initialCopyS = secs(tCopy);
      if (!(await reconcile(source, target, cfg))) throw new Error("reconcile FAILED");

      log.step("cutover --with-auth-data (write-stop)");
      const tCut = Date.now();
      await cutover(source, target, cfg, {
        maxLagWaitSec: 120,
        authData: { sourceUrl: srcPool, targetUrl: tgtPool, outDir: `${OUT_DIR}/cutover` },
      });
      result.cutoverWithAuthS = secs(tCut);
      log.ok(`cutover with auth reload took ${String(result.cutoverWithAuthS)} s`);

      // 5. at the target
      const [sc] = await source.unsafe(
        "select (select count(*) from auth.users) u, (select count(*) from auth.sessions) s, (select count(*) from auth.refresh_tokens) r, (select count(*) from auth.mfa_factors) f",
      );
      const [tc] = await target.unsafe(
        "select (select count(*) from auth.users) u, (select count(*) from auth.sessions) s, (select count(*) from auth.refresh_tokens) r, (select count(*) from auth.mfa_factors) f",
      );
      result.authCounts = { source: sc, target: tc };

      const postA = await refresh(tgtRef, tk, aRefresh);
      check(
        "A's post-snapshot refresh token refreshes at target",
        postA.status === 200,
        `HTTP ${postA.status} ${String(postA.body.error_code ?? "")}`,
      );
      const postC = await login(tgtRef, tk, C, pwC);
      check(
        "C (created after bootstrap) logs in at target",
        postC.status === 200,
        `HTTP ${postC.status}`,
      );
      const postApw = await login(tgtRef, tk, A, pwA);
      check("A password login at target", postApw.status === 200, `HTTP ${postApw.status}`);
      if (bRefresh) {
        const postB = await refresh(tgtRef, tk, bRefresh);
        const c = postB.status === 200 ? claims(String(postB.body.access_token)) : {};
        const amr = JSON.stringify(c.amr ?? []);
        check(
          "B's aal2 refresh token refreshes at target and stays aal2",
          postB.status === 200 && c.aal === "aal2" && amr.includes("totp"),
          `HTTP ${postB.status} aal=${String(c.aal)} amr=${amr}`,
        );
      } else {
        check("B aal2 carry", false, `skipped: ${String(result.bTotp)}`);
      }
      // The access token A held before the move is still refused (different signing key).
      const user = await auth(tgtRef, "/user", tk.anon, undefined, String(a1.body.access_token));
      result.heldAccessTokenAtTarget = `HTTP ${user.status} ${String(user.body.error_code ?? "")}`;
      log.ok(`held source access token at target /user: ${String(result.heldAccessTokenAtTarget)}`);
    } catch (e) {
      log.warn(`pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
      result.error = e instanceof Error ? e.message : String(e);
      await diagnose(api, source, target, srcRef, tgtRef).catch(() => undefined);
      throw e;
    } finally {
      await close();
    }
  } finally {
    log.step("teardown - deleting throwaway projects");
    await Promise.allSettled(
      [srcRef, tgtRef]
        .filter(Boolean)
        .map((ref) => api.deleteProject(ref).then(() => log.ok(`deleted ${ref}`))),
    );
    console.log(`RESULT ${JSON.stringify(result)}`);
  }
}

await main();
