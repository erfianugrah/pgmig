/**
 * Does the SOURCE's network restriction let the TARGET's subscription in?
 *
 * The subscription is dialled by the target's own Postgres, so the source sees the target
 * project's outbound address, and a blocked target does not get a refusal: CREATE
 * SUBSCRIPTION hangs until a statement timeout (supabase-lab replica-routing RR12/RR13,
 * 2026-11-11). Which address depends on the source:
 *  - no IPv4 add-on on the source: the target connects over IPv6 from the address its own
 *    db host resolves to (AAAA), so it can be checked here;
 *  - IPv4 add-on on the source (its db host has an A record and no AAAA): the target
 *    connects over IPv4 from an address that is not in DNS and differs per target, so it
 *    can only be read on the target itself (pg_net to an IP echo service).
 * The docs say the outbound address is not guaranteed to stay the same, so this is a
 * pre-flight check, not a guarantee.
 */

export type Verdict = { level: "ok" | "warn" | "fail"; message: string };

function parseV4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let v = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    v = (v << 8n) | BigInt(Number(x));
  }
  return v;
}

function parseV6(s: string): bigint | null {
  if (!s.includes(":")) return null;
  let str = s;
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (embedded) {
    const v4 = parseV4(embedded[2] ?? "");
    if (v4 === null) return null;
    str = `${embedded[1]}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return v;
}

/** Pure: is `ip` inside `cidr`? IPv4 or IPv6; a family mismatch or a malformed input is false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net = "", lenStr] = cidr.split("/");
  const v6 = ip.includes(":");
  if (v6 !== net.includes(":")) return false;
  const bits = v6 ? 128 : 32;
  const len = lenStr === undefined ? bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > bits) return false;
  const a = v6 ? parseV6(ip) : parseV4(ip);
  const b = v6 ? parseV6(net) : parseV4(net);
  if (a === null || b === null) return false;
  const shift = BigInt(bits - len);
  return a >> shift === b >> shift;
}

const appendCmd = (srcRef: string, cidr: string) =>
  `supabase network-restrictions update --remote=${srcRef} --db-allow-cidr ${cidr} --append --experimental`;

/** Pure: the verdict for one source/target pair. */
export function restrictionVerdict(i: {
  srcRef: string;
  v4: string[];
  v6: string[];
  /** The source's db host has an A record (IPv4 add-on). */
  sourceHasIpv4: boolean;
  /** AAAA records of the target's db host (empty = unknown). */
  targetV6: string[];
}): Verdict {
  const openV4 = i.v4.includes("0.0.0.0/0");
  const openV6 = i.v6.includes("::/0");
  if (i.sourceHasIpv4) {
    if (openV4)
      return {
        level: "ok",
        message:
          "source has the IPv4 add-on and allows all IPv4 - the target's subscription can connect",
      };
    return {
      level: "warn",
      message:
        `source has the IPv4 add-on and restricts IPv4 (${i.v4.join(", ") || "nothing allowed"}): ` +
        "the target connects over IPv4 from an address that is not in DNS and differs per " +
        "target, so it cannot be checked from here. Read it on the target: create extension if " +
        "not exists pg_net; select net.http_get('https://api.ipify.org'); then select content " +
        "from net._http_response where id = <id>; and allow it on the source: " +
        appendCmd(i.srcRef, "<target-ipv4>/32"),
    };
  }
  if (openV6)
    return {
      level: "ok",
      message: "source allows all IPv6 - the target's subscription can connect",
    };
  if (i.targetV6.length === 0)
    return {
      level: "warn",
      message:
        `source restricts IPv6 (${i.v6.join(", ") || "nothing allowed"}) and the target's db host ` +
        "did not resolve (target not created yet?) - re-run doctor once it exists, before replicate",
    };
  const allowed = i.targetV6.find((ip) => i.v6.some((c) => ipInCidr(ip, c)));
  if (allowed)
    return {
      level: "ok",
      message: `target address ${allowed} is inside the source's IPv6 allow list`,
    };
  const ip = i.targetV6[0] ?? "";
  return {
    level: "fail",
    message:
      `source network restrictions block the target: its subscription connects from ${ip}, ` +
      `which is not in the source's IPv6 allow list (${i.v6.join(", ") || "nothing allowed"}), ` +
      "and CREATE SUBSCRIPTION would hang until a statement timeout. Allow it on the source: " +
      appendCmd(i.srcRef, `${ip}/128`),
  };
}

export interface NetDeps {
  getRestrictions: (ref: string) => Promise<{ status: number; body: unknown }>;
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
}

/** Read the source's restrictions and both db hosts' records, then decide. */
export async function checkSourceRestrictions(
  srcRef: string,
  tgtRef: string,
  deps: NetDeps,
): Promise<Verdict> {
  const r = await deps
    .getRestrictions(srcRef)
    .catch((): { status: number; body: unknown } => ({ status: 0, body: null }));
  if (r.status !== 200 || !r.body)
    return {
      level: "warn",
      message:
        `could not read the source's network restrictions (HTTP ${r.status}) - check them in ` +
        "Database Settings before replicate: a blocked target hangs instead of failing",
    };
  const c =
    (r.body as { config?: { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] } }).config ??
    {};
  const sourceV4 = await deps.resolve4(`db.${srcRef}.supabase.co`).catch(() => [] as string[]);
  const targetV6 = await deps.resolve6(`db.${tgtRef}.supabase.co`).catch(() => [] as string[]);
  return restrictionVerdict({
    srcRef,
    v4: c.dbAllowedCidrs ?? [],
    v6: c.dbAllowedCidrsV6 ?? [],
    sourceHasIpv4: sourceV4.length > 0,
    targetV6,
  });
}
