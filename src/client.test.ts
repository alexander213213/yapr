import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// client transitively opens the DB (via store at import time), so pin an
// isolated dir before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-client-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { resolveEndpoint, resolveTlsOptions, DEFAULT_HOST, DEFAULT_PORT } = await import("./client.js");

describe("resolveEndpoint", () => {
  it("defaults to the staging relay", () => {
    expect(resolveEndpoint({})).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, fromDefault: true });
    expect(DEFAULT_HOST).toBe("nozomi.proxy.rlwy.net");
    expect(DEFAULT_PORT).toBe(15038);
  });

  it("prefers explicit env", () => {
    expect(resolveEndpoint({ HOST: "example.com", PORT: "1234" })).toEqual({
      host: "example.com",
      port: 1234,
      fromDefault: false,
    });
  });

  it("trims and falls back on blank host", () => {
    expect(resolveEndpoint({ HOST: "  " }).host).toBe(DEFAULT_HOST);
  });

  it("rejects bad ports like before", () => {
    expect(() => resolveEndpoint({ PORT: "abc" })).toThrow(/Invalid PORT/);
    expect(() => resolveEndpoint({ PORT: "0" })).toThrow(/Invalid PORT/);
    expect(() => resolveEndpoint({ PORT: "70000" })).toThrow(/Invalid PORT/);
  });
});

describe("resolveTlsOptions", () => {
  it("verifies against YAPR_CA_FILE", () => {
    const r = resolveTlsOptions({ YAPR_CA_FILE: "/ca.pem" }, () => "CERT");
    expect(r.verified).toBe(true);
    expect(r.source).toBe("ca-file");
    expect(r.options).toEqual({ ca: "CERT" });
  });

  it("is insecure by staging default", () => {
    const r = resolveTlsOptions({});
    expect(r.verified).toBe(false);
    expect(r.source).toBe("insecure-default");
    expect(r.options).toEqual({ rejectUnauthorized: false });
  });

  it("honors the explicit insecure flag", () => {
    const r = resolveTlsOptions({ YAPR_INSECURE: "1" });
    expect(r.verified).toBe(false);
    expect(r.source).toBe("insecure-explicit");
  });
});
