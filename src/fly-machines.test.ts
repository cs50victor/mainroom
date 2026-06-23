import { afterEach, describe, expect, test } from "bun:test";

import {
  flyMachineApi,
  flyMachineConfig,
  flyMachineFetch,
  flyMachineName,
  positiveIntegerEnv,
  type FlyMachineConfig,
} from "./fly-machines";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function flyConfig(
  overrides: Partial<FlyMachineConfig> = {},
): FlyMachineConfig {
  return {
    apiToken: "fly-token",
    appHostname: "mainroom-tokenproxy.fly.dev",
    appName: "mainroom-tokenproxy",
    cpus: 1,
    image: "registry.fly.io/mainroom-tokenproxy:v1",
    memoryMb: 256,
    ...overrides,
  };
}

describe("flyMachineConfig", () => {
  test("is disabled until every required Fly setting is present", () => {
    expect(flyMachineConfig({})).toBeUndefined();
    expect(
      flyMachineConfig({
        FLY_API_TOKEN: "token",
        FLY_APP_NAME: "app",
      }),
    ).toBeUndefined();
  });

  test("normalizes defaults and numeric overrides", () => {
    expect(
      flyMachineConfig({
        FLY_API_TOKEN: "token",
        FLY_APP_NAME: "app",
        FLY_MACHINE_CPUS: "2",
        FLY_MACHINE_MEMORY_MB: "512",
        FLY_MACHINE_REGION: "iad",
        FLY_TOKENPROXY_IMAGE: "registry.fly.io/app:v1",
      }),
    ).toEqual({
      apiToken: "token",
      appHostname: "app.fly.dev",
      appName: "app",
      cpus: 2,
      image: "registry.fly.io/app:v1",
      memoryMb: 512,
      region: "iad",
    });
  });
});

describe("flyMachineName", () => {
  test("keeps generated Machine names Fly-safe and versioned", () => {
    expect(flyMachineName("user_ABC+icloud.com", "v0.1.16")).toBe(
      "user-user-abc-icloud-com-v0-1-16",
    );
    expect(flyMachineName("___", "v0.1.16")).toBe("user-subject-v0-1-16");
  });
});

describe("positiveIntegerEnv", () => {
  test("accepts positive integers and rejects invalid values", () => {
    expect(positiveIntegerEnv("4", 1)).toBe(4);
    expect(positiveIntegerEnv("0", 1)).toBe(1);
    expect(positiveIntegerEnv("bad", 1)).toBe(1);
    expect(positiveIntegerEnv(undefined, 1)).toBe(1);
  });
});

describe("flyMachineApi", () => {
  test("sends authenticated JSON requests to the Machines API", async () => {
    let captured: { init: RequestInit; url: string } | undefined;
    globalThis.fetch = (async (url, init) => {
      captured = { init: init ?? {}, url: String(url) };
      return Response.json({ id: "machine-id" });
    }) as typeof fetch;

    await expect(
      flyMachineApi(flyConfig({ appName: "app/name" }), "/machines", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
    ).resolves.toEqual({ id: "machine-id" });

    expect(captured?.url).toBe(
      "https://api.machines.dev/v1/apps/app%2Fname/machines",
    );
    expect(new Headers(captured?.init.headers).get("authorization")).toBe(
      "Bearer fly-token",
    );
    expect(new Headers(captured?.init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  test("surfaces Fly API failures with status and body", async () => {
    globalThis.fetch = (async () =>
      new Response("capacity", { status: 503 })) as typeof fetch;

    await expect(flyMachineApi(flyConfig(), "/machines")).rejects.toThrow(
      "failed with 503: capacity",
    );
  });
});

describe("flyMachineFetch", () => {
  test("pins requests to a specific Fly Machine and preserves Mainroom host", async () => {
    let forwarded: Request | undefined;
    globalThis.fetch = (async (request) => {
      forwarded = request as Request;
      return Response.json({ ok: true });
    }) as typeof fetch;

    await flyMachineFetch(
      flyConfig(),
      { flyMachineId: "machine-123" },
      new Request("https://victor.mainroom.sh/v1/responses", {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer provider-secret" },
      }),
    );

    expect(forwarded?.url).toBe(
      "https://mainroom-tokenproxy.fly.dev/v1/responses",
    );
    expect(forwarded?.headers.get("fly-force-instance-id")).toBe("machine-123");
    expect(forwarded?.headers.get("x-forwarded-host")).toBe(
      "victor.mainroom.sh",
    );
    expect(forwarded?.headers.get("x-mainroom-host")).toBe(
      "victor.mainroom.sh",
    );
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer provider-secret",
    );
  });

  test("returns 503 when a Fly record has not been created yet", async () => {
    const response = await flyMachineFetch(
      flyConfig(),
      {},
      new Request("https://victor.mainroom.sh/v1/responses"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Fly machine is not ready",
    });
  });
});
