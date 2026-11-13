import { describe, expect, test } from "bun:test";
import {
  checkSourceRestrictions,
  ipInCidr,
  restrictionVerdict,
} from "../src/steps/network-check.ts";

describe("ipInCidr", () => {
  test("IPv4 ranges", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("203.0.113.7", "203.0.113.7/32")).toBe(true);
    expect(ipInCidr("203.0.113.8", "203.0.113.7/32")).toBe(false);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  test("IPv6 ranges, compressed and full forms", () => {
    const ip = "2001:db8:167b:f902:68f:c5c7:515b:842a";
    expect(ipInCidr(ip, "2001:db8::/32")).toBe(true);
    expect(ipInCidr(ip, `${ip}/128`)).toBe(true);
    expect(ipInCidr(ip, "2001:db8:167b:f902:68f:c5c7:515b:842b/128")).toBe(false);
    expect(ipInCidr(ip, "2001:db8:ffff::/48")).toBe(false);
    expect(ipInCidr(ip, "::/0")).toBe(true);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
  });

  test("family mismatch or garbage never matches", () => {
    expect(ipInCidr("10.1.2.3", "::/0")).toBe(false);
    expect(ipInCidr("2001:db8::1", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("10.1.2.3", "10.0.0.0/33")).toBe(false);
  });
});

describe("restrictionVerdict", () => {
  const base = { srcRef: "srcrefsrcrefsrcref12", v4: ["0.0.0.0/0"], v6: ["::/0"] };
  const tgt6 = "2001:db8:167b:f902:68f:c5c7:515b:842a";

  test("unrestricted source -> ok", () => {
    const v = restrictionVerdict({ ...base, sourceHasIpv4: false, targetV6: [tgt6] });
    expect(v.level).toBe("ok");
  });

  test("no IPv4 add-on: target AAAA inside the IPv6 list -> ok naming the address", () => {
    const v = restrictionVerdict({
      ...base,
      v4: ["198.51.100.0/24"],
      v6: ["2001:db8::/32"],
      sourceHasIpv4: false,
      targetV6: [tgt6],
    });
    expect(v.level).toBe("ok");
    expect(v.message).toContain(tgt6);
  });

  test("no IPv4 add-on: target AAAA outside the list -> fail with the /128 append command", () => {
    const v = restrictionVerdict({
      ...base,
      v4: ["198.51.100.0/24"],
      v6: ["2001:db8:ffff::/48"],
      sourceHasIpv4: false,
      targetV6: [tgt6],
    });
    expect(v.level).toBe("fail");
    expect(v.message).toContain(`--db-allow-cidr ${tgt6}/128 --append`);
    expect(v.message).toContain("--remote=srcrefsrcrefsrcref12");
  });

  test("no IPv4 add-on: target AAAA unknown -> warn, re-run once the target exists", () => {
    const v = restrictionVerdict({
      ...base,
      v6: ["2001:db8:ffff::/48"],
      sourceHasIpv4: false,
      targetV6: [],
    });
    expect(v.level).toBe("warn");
    expect(v.message).toContain("re-run doctor");
  });

  test("IPv4 add-on on the source, IPv4 restricted -> warn with the pg_net recipe and /32", () => {
    const v = restrictionVerdict({
      ...base,
      v4: ["198.51.100.0/24"],
      sourceHasIpv4: true,
      targetV6: [tgt6],
    });
    expect(v.level).toBe("warn");
    expect(v.message).toContain("api.ipify.org");
    expect(v.message).toContain("/32 --append");
  });

  test("IPv4 add-on on the source, IPv4 open -> ok even if IPv6 is restricted", () => {
    const v = restrictionVerdict({
      ...base,
      v6: ["2001:db8:ffff::/48"],
      sourceHasIpv4: true,
      targetV6: [tgt6],
    });
    expect(v.level).toBe("ok");
  });
});

describe("checkSourceRestrictions", () => {
  const tgt6 = "2001:db8:167b:f902:68f:c5c7:515b:842a";
  const deps = (over: Partial<Parameters<typeof checkSourceRestrictions>[2]> = {}) => ({
    getRestrictions: async () => ({
      status: 200,
      body: {
        config: { dbAllowedCidrs: ["198.51.100.0/24"], dbAllowedCidrsV6: ["2001:db8:ffff::/48"] },
      },
    }),
    resolve4: async () => {
      throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
    },
    resolve6: async () => [tgt6],
    ...over,
  });

  test("reads the source restrictions, resolves the target AAAA, fails when blocked", async () => {
    const v = await checkSourceRestrictions("srcrefsrcrefsrcref12", "tgtreftgtreftgtref12", deps());
    expect(v.level).toBe("fail");
    expect(v.message).toContain(tgt6);
  });

  test("source A record present = IPv4 add-on -> the IPv4 path", async () => {
    const v = await checkSourceRestrictions(
      "srcrefsrcrefsrcref12",
      "tgtreftgtreftgtref12",
      deps({ resolve4: async () => ["203.0.113.10"] }),
    );
    expect(v.level).toBe("warn");
    expect(v.message).toContain("api.ipify.org");
  });

  test("Management API refusal -> warn, never a pass", async () => {
    const v = await checkSourceRestrictions(
      "srcrefsrcrefsrcref12",
      "tgtreftgtreftgtref12",
      deps({ getRestrictions: async () => ({ status: 403, body: null }) }),
    );
    expect(v.level).toBe("warn");
    expect(v.message).toContain("HTTP 403");
  });
});
