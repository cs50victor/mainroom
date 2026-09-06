import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: () => {
    throw new Error("Unexpected container fallback");
  },
}));
const { default: worker, ShareGrantStore } = await import("../../src/worker");

export async function sharingFixture() {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const directory = await mkdtemp(join(tmpdir(), "mainroom-sharing-"));
  const users = ["alice", "bob", "carol"].map((username) => ({
    id: `user_${username}`,
    username,
    object: "user",
    email_addresses: [
      {
        id: `email_${username}`,
        email_address: `${username}+clerk_test@example.com`,
        linked_to: [],
      },
    ],
    primary_email_address_id: `email_${username}`,
  }));
  const keys = new Map(
    users.map((user) => [
      `sk_${user.username}_test`,
      {
        object: "api_key",
        id: `ak_${user.username}`,
        type: "api_key",
        name: "Mainroom CLI",
        subject: user.id,
        scopes: [],
        claims: null,
        revoked: false,
        revocation_reason: null,
        expired: false,
        expiration: null,
        created_by: user.id,
        description: null,
        last_used_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]),
  );
  // Synthetic $200/month Pro accounts; price does not imply a fixed token allowance.
  const objects = new Map(
    users.map((user) => {
      const claims = {
        sub: `openai_${user.username}`,
        "https://api.openai.com/auth": {
          chatgpt_account_id: `codex_${user.username}`,
          chatgpt_plan_type: "pro",
        },
      };
      const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`;
      return [
        `uploads/json/${user.id}/codex.json`,
        JSON.stringify({
          tokens: {
            account_id: `codex_${user.username}`,
            access_token: token,
            refresh_token: `private-refresh-${user.username}`,
          },
        }),
      ];
    }),
  );
  const storage = new Map<string, unknown>();
  const store = Object.create(ShareGrantStore.prototype) as InstanceType<
    typeof ShareGrantStore
  >;
  Object.defineProperty(store, "ctx", {
    value: {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => {
          storage.set(key, value);
        },
        list: async ({ prefix }: { prefix: string }) =>
          new Map([...storage].filter(([key]) => key.startsWith(prefix))),
      },
    },
  });
  const forwarded: string[] = [];
  const reconciled: string[] = [];
  let reconcileFails = false;
  const env = {
    AUTH_MODE: "clerk",
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk",
    S3_BUCKET: "bucket",
    S3_ENDPOINT: "https://storage.test",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    MACHINE_CONTROL_TOKEN: "test-signing-key",
    SHARE_GRANT_STORE: { idFromName: (name: string) => name, get: () => store },
    USER_MACHINE_CONTAINER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        restartForShareChange: async () => {
          reconciled.push(name);
          if (reconcileFails) throw new Error("fixture node unavailable");
          return { created: false, restarted: true };
        },
        fetch: async () => {
          forwarded.push(name);
          return Response.json({
            status: "completed",
            output: [{ text: "OK" }],
          });
        },
        info: async () => ({ subject: name }),
      }),
    },
  };
  const denied = () =>
    HttpResponse.json(
      { errors: [{ code: "invalid_api_key", message: "Unauthorized" }] },
      { status: 401 },
    );
  function matches(request: Request) {
    const names = new URL(request.url).searchParams.getAll("username");
    return users.filter((user) => names.includes(user.username));
  }
  const server = setupServer(
    http.post("https://api.clerk.com/api_keys/verify", async ({ request }) => {
      const { secret } = (await request.json()) as { secret: string };
      const key = keys.get(secret);
      return key && !key.revoked && !key.expired
        ? HttpResponse.json(key)
        : denied();
    }),
    http.post(
      "https://api.clerk.com/oauth_applications/access_tokens/verify",
      async ({ request }) => {
        const { access_token } = (await request.json()) as {
          access_token: string;
        };
        const user = users.find(
          (user) => access_token === `oat_${user.username}_test`,
        );
        if (!user)
          return HttpResponse.json(
            {
              errors: [{ code: "not_found", message: "OAuth token not found" }],
            },
            { status: 404 },
          );
        return HttpResponse.json({
          object: "clerk_idp_oauth_access_token",
          id: `oat_id_${user.username}`,
          client_id: "test-client",
          type: "oauth_token",
          subject: user.id,
          scopes: ["profile", "email"],
          revoked: false,
          expired: false,
          expiration: Date.now() + 60000,
          created_at: 1,
          updated_at: 1,
        });
      },
    ),
    http.post("https://api.clerk.com/api_keys", async ({ request }) => {
      const { subject } = (await request.json()) as { subject: string };
      const entry = [...keys].find(([, key]) => key.subject === subject);
      return entry
        ? HttpResponse.json({ ...entry[1], secret: entry[0] })
        : denied();
    }),
    http.get("https://api.clerk.com/v1/users/count", ({ request }) =>
      HttpResponse.json({
        object: "total_count",
        total_count: matches(request).length,
      }),
    ),
    http.get("https://api.clerk.com/v1/users", ({ request }) =>
      HttpResponse.json(matches(request)),
    ),
    http.get("https://api.clerk.com/v1/users/:id", ({ params }) => {
      const user = users.find((user) => user.id === params.id);
      return user ? HttpResponse.json(user) : denied();
    }),
    http.get("https://chatgpt.com/backend-api/codex/models", ({ request }) => {
      const user = users.find(
        (user) =>
          request.headers.get("chatgpt-account-id") ===
          `codex_${user.username}`,
      );
      if (!user) return denied();
      const credential = JSON.parse(
        objects.get(`uploads/json/${user.id}/codex.json`)!,
      );
      return request.headers.get("authorization") ===
        `Bearer ${credential.tokens.access_token}`
        ? HttpResponse.json({ models: [{ slug: "test-pro-model" }] })
        : denied();
    }),
    http.get("https://storage.test/bucket", ({ request }) => {
      const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
      const contents = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => `<Contents><Key>${key}</Key></Contents>`)
        .join("");
      return HttpResponse.xml(
        `<ListBucketResult>${contents}</ListBucketResult>`,
      );
    }),
    http.get("https://storage.test/bucket/*", ({ request }) => {
      const key = decodeURIComponent(
        new URL(request.url).pathname.slice("/bucket/".length),
      );
      const value = objects.get(key);
      return new HttpResponse(value ?? "missing", {
        status: value ? 200 : 404,
      });
    }),
  );
  server.listen({ onUnhandledRequest: "error" });
  const call = (
    username: string,
    path: string,
    method = "GET",
    body?: object,
    origin = "https://mainroom.sh",
  ) =>
    worker.fetch(
      new Request(new URL(path, origin), {
        method,
        headers: {
          authorization: `Bearer sk_${username}_test`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env as never,
      {} as never,
    );
  return {
    call,
    users,
    keys,
    objects,
    forwarded,
    reconciled,
    store,
    failReconcile: () => {
      reconcileFails = true;
    },
    exchange: (username: string) =>
      worker.fetch(
        new Request("https://mainroom.sh/v0/auth/cli/exchange", {
          method: "POST",
          headers: {
            authorization: `Bearer oat_${username}_test`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
        env as never,
        {} as never,
      ),
    cli: async (username: string, args: string[]) => {
      const local = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => worker.fetch(request, env as never, {} as never),
      });
      const config = join(directory, username);
      try {
        await Bun.write(
          join(config, "credentials.json"),
          JSON.stringify({
            apiUrl: local.url.origin,
            token: `sk_${username}_test`,
            updatedAt: new Date().toISOString(),
          }),
        );
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../../cli/mainroom.ts"),
            "share",
            ...args,
          ],
          {
            env: { ...process.env, MAINROOM_CONFIG_DIR: config },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, output: stdout + stderr };
      } finally {
        local.stop(true);
      }
    },
    close: async () => {
      server.close();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
