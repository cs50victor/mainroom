import { afterEach, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: () => {
    throw new Error("Unexpected container fallback");
  },
}));
const { default: worker } = await import("./worker");
const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

async function fixture() {
  process.env.NODE_ENV = "test";
  const objects = new Map([
    [
      "uploads/json/account-owner/saved.json",
      JSON.stringify({
        account_id: "workspace",
        access_token: "private-token",
      }),
    ],
    ["uploads/json/another-owner/other.json", "private-other-credential"],
  ]);
  let providerStatus = 401;
  let providerCalls = 0;
  let stops = 0;
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.clerk.com") {
      if (url.pathname === "/api_keys/verify") {
        const body = (await request.json()) as { secret: string };
        return body.secret === "test-mainroom-key"
          ? Response.json(
              { object: "api_key", id: "key-1", subject: "account-owner" },
              { headers: { "content-type": "application/json" } },
            )
          : Response.json(
              {
                errors: [{ code: "invalid_api_key", message: "Unauthorized" }],
              },
              { status: 401 },
            );
      }
      if (url.pathname === "/v1/users/account-owner")
        return Response.json(
          { object: "user", id: "account-owner", username: "mock" },
          { headers: { "content-type": "application/json" } },
        );
      throw new Error(`Unexpected Clerk route ${url.pathname}`);
    }
    if (url.hostname === "chatgpt.com") {
      providerCalls++;
      return Response.json(
        { models: [{ slug: "model-a" }] },
        { status: providerStatus },
      );
    }
    expect(url.hostname).toBe("storage.test");
    const prefix = url.searchParams.get("prefix");
    if (prefix !== null) {
      const contents = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => `<Contents><Key>${name}</Key></Contents>`)
        .join("");
      return new Response(`<ListBucketResult>${contents}</ListBucketResult>`);
    }
    const name = decodeURIComponent(url.pathname.replace("/bucket/", ""));
    if (request.method === "PUT") {
      objects.set(name, await request.text());
      return new Response(null, { status: 200 });
    }
    if (request.method === "DELETE") {
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    const body = objects.get(name);
    return new Response(body ?? "missing", {
      status: body === undefined ? 404 : 200,
    });
  }) as typeof fetch;
  const env = {
    AUTH_MODE: "clerk",
    CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk",
    CLERK_SECRET_KEY: "sk_test_fake",
    S3_BUCKET: "bucket",
    S3_ENDPOINT: "https://storage.test",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    MACHINE_CONTROL_TOKEN: "test-signing-key",
    USER_MACHINE_CONTAINER: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        expect(name).toContain("account-owner");
        return {
          stop: async () => {
            stops++;
          },
        };
      },
    },
    SHARE_GRANT_STORE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ tokenproxy_accounts: [] }),
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const call = (path: string, enabled?: boolean, token = "test-mainroom-key") =>
    worker.fetch(
      new Request(`https://mainroom.sh${path}`, {
        method: enabled === undefined ? "GET" : "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: enabled === undefined ? undefined : JSON.stringify({ enabled }),
      }),
      env,
      {} as Parameters<typeof worker.fetch>[2],
    );
  return {
    call,
    objects,
    setReady: () => {
      providerStatus = 200;
    },
    stats: () => ({ providerCalls, stops }),
  };
}

test("account status is owner scoped and never returns stored tokens", async () => {
  const f = await fixture();
  expect(
    (await f.call("/v0/tokenproxy/accounts", undefined, "bad")).status,
  ).toBe(401);
  expect(f.stats().providerCalls).toBe(0);
  const response = await f.call("/v0/tokenproxy/accounts");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).toContain("reauth_required");
  expect(text).not.toContain("private-token");
  expect(text).not.toContain("other.json");
  expect(
    (await f.call("/v0/tokenproxy/accounts/other.json", false)).status,
  ).toBe(404);
});

test("disable retains credential, stops runtime, and excludes account from boot config", async () => {
  const f = await fixture();
  const original = f.objects.get("uploads/json/account-owner/saved.json");
  expect(
    (await f.call("/v0/tokenproxy/accounts/saved.json", false)).status,
  ).toBe(200);
  expect(f.stats().stops).toBe(1);
  expect(f.objects.get("uploads/json/account-owner/saved.json")).toBe(original);
  const status = await f.call("/v0/tokenproxy/accounts");
  expect(await status.text()).toContain("disabled");
  expect(f.stats().providerCalls).toBe(0);
  const config = await f.call("/v0/tokenproxy/config/me");
  expect(config.status).toBe(200);
  expect(await config.text()).not.toContain("saved.json");
});

test("reconnecting requires working credentials before removing disable marker", async () => {
  const f = await fixture();
  await f.call("/v0/tokenproxy/accounts/saved.json", false);
  expect(
    (await f.call("/v0/tokenproxy/accounts/saved.json", true)).status,
  ).toBe(409);
  expect(
    f.objects.has("settings/tokenproxy/disabled/account-owner/saved.json"),
  ).toBe(true);
  f.setReady();
  expect(
    (await f.call("/v0/tokenproxy/accounts/saved.json", true)).status,
  ).toBe(200);
  expect(
    f.objects.has("settings/tokenproxy/disabled/account-owner/saved.json"),
  ).toBe(false);
  expect(await (await f.call("/v0/tokenproxy/config/me")).text()).toContain(
    "saved.json",
  );
});
