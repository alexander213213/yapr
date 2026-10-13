import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// client transitively opens the DB (via store at import time), so pin an
// isolated dir before the dynamic import below.
const TEST_DIR = path.join(os.tmpdir(), `yapr-client-test-${process.pid}-${Date.now()}`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.env.YAPR_DATA_DIR = TEST_DIR;

const { resolveEndpoint, resolveTlsOptions, DEFAULT_HOST, DEFAULT_PORT, client } = await import("./client.js");
const { socketBus } = await import("./eventStore.js");

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

describe("groupCreatedWaiter", () => {
  // Private-member backdoor: dispatch is side-effect free for these frames
  // (no sockets touched), so the waiter lifecycle is unit-testable.
  type Backdoor = {
    dispatch: (frame: { v: 2; type: string; [k: string]: unknown }) => void;
    groupCreatedWaiter: { resolve: (c: unknown) => void; reject: (e: Error) => void } | null;
  };
  const backdoor = () => client as unknown as Backdoor;

  it("rejects the pending create on error frames instead of hanging to timeout", () => {
    const b = backdoor();
    let rejected: Error | null = null;
    let resolved: unknown = null;
    b.groupCreatedWaiter = {
      resolve: (c) => { resolved = c; },
      reject: (e) => { rejected = e; },
    };
    let toasted: unknown = null;
    const onErr = (m: unknown) => { toasted = m; };
    socketBus.on("server_error", onErr);
    try {
      b.dispatch({ v: 2, type: "error", code: "RATE_LIMITED", message: "too many group operations" });
    } finally {
      socketBus.off("server_error", onErr);
    }
    expect(rejected).toMatchObject({ message: "RATE_LIMITED: too many group operations" });
    expect(resolved).toBeNull();
    expect(b.groupCreatedWaiter).toBeNull();
    expect(toasted).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("still resolves on group_created", () => {
    const b = backdoor();
    let resolved: unknown = null;
    b.groupCreatedWaiter = {
      resolve: (c) => { resolved = c; },
      reject: () => { throw new Error("must not reject"); },
    };
    b.dispatch({ v: 2, type: "group_created", groupId: "grp_1" });
    expect(resolved).toMatchObject({ groupId: "grp_1" });
    expect(b.groupCreatedWaiter).toBeNull();
  });

  it("emits server_error normally when no create is pending", () => {
    const b = backdoor();
    b.groupCreatedWaiter = null;
    let toasted: unknown = null;
    const onErr = (m: unknown) => { toasted = m; };
    socketBus.on("server_error", onErr);
    try {
      b.dispatch({ v: 2, type: "error", code: "NOT_FOUND", message: "member not found" });
    } finally {
      socketBus.off("server_error", onErr);
    }
    expect(toasted).toMatchObject({ code: "NOT_FOUND" });
  });
});
