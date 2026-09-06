import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function recoveryCase(
  mode: string,
  args = ["reauth", "--account", "saved.json"],
) {
  const directory = await mkdtemp(join(tmpdir(), "mainroom-recovery-test-"));
  const uploads: { filename: string | null; body: string }[] = [];
  let ready = false;
  let disabled = false;
  let reloads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe("Bearer mainroom-test");
      if (path === "/v0/ping")
        return Response.json({ ok: true, version: "test" });
      if (path === "/v0/tokenproxy/accounts") {
        let status = "reauth_required";
        if (ready) status = "ready";
        if (disabled) status = "disabled";
        return Response.json({
          username: "mock",
          accounts: [
            {
              uploadName: "saved.json",
              accountId: "workspace-1",
              email: "owner@example.test",
              models: ["test-model"],
              status,
            },
          ],
        });
      }
      if (path === "/v0/uploads/json") {
        uploads.push({
          filename: request.headers.get("x-mainroom-upload-name"),
          body: await request.text(),
        });
        ready = true;
        return Response.json({ bucket: "test", key: "saved.json", size: 1 });
      }
      if (
        path === "/v0/tokenproxy/accounts/saved.json" &&
        request.method === "PATCH"
      ) {
        const { enabled } = (await request.json()) as { enabled: boolean };
        disabled = !enabled;
        return Response.json({ uploadName: "saved.json", enabled });
      }
      if (path === "/v0/tokenproxy/config/reload") {
        reloads++;
        return Response.json({ created: false, restarted: true });
      }
      if (path === "/v1/models")
        return Response.json({
          data: [{ id: "anthropic-peer-model" }, { id: "test-model" }],
        });
      if (path === "/v1/responses") {
        const body = (await request.json()) as {
          model: string;
          stream: boolean;
        };
        expect(body.model).toBe("test-model");
        expect(body.stream).toBe(true);
        const status = mode === "inference-failed" ? "failed" : "completed";
        return new Response(
          `data: ${JSON.stringify({ type: `response.${status}`, response: { status } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("Unexpected test route", { status: 404 });
    },
  });
  try {
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "normal-codex"));
    await Bun.write(
      join(directory, "normal-codex/auth.json"),
      "original-local-login",
    );
    await Bun.write(
      join(directory, "config/credentials.json"),
      JSON.stringify({
        apiUrl: server.url.origin,
        token: "mainroom-test",
        updatedAt: new Date().toISOString(),
      }),
    );
    await Bun.write(
      join(directory, "bin/codex"),
      '#!/bin/sh\nexec "$TEST_BUN" "$TEST_LOGIN_SCRIPT" "$@"\n',
    );
    await chmod(join(directory, "bin/codex"), 0o700);
    await Bun.write(
      join(directory, "login.ts"),
      `
      import { stat } from "node:fs/promises";
      const home = process.env.CODEX_HOME!;
      await Bun.write(process.env.TEST_RECORD!, JSON.stringify({ home, mode: (await stat(home)).mode & 0o777, args: process.argv.slice(2) }));
      if (process.env.TEST_MODE === "cancelled") process.exit(7);
      const jwt = (value: unknown) => "header." + Buffer.from(JSON.stringify(value)).toString("base64url") + ".signature";
      const email = process.env.TEST_MODE === "wrong-email" ? "other@example.test" : "owner@example.test";
      await Bun.write(home + "/auth.json", JSON.stringify({
        auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
        tokens: { account_id: process.env.TEST_MODE === "wrong-account" ? "workspace-2" : "workspace-1", access_token: jwt({ exp: Math.floor(Date.now()/1000)+3600 }), id_token: jwt({ email }), refresh_token: "private-refresh-token" }
      }));
    `,
    );
    await Bun.write(
      join(directory, "preload.ts"),
      `
      const original = globalThis.fetch;
      globalThis.fetch = ((input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "mock.127.0.0.1") url.hostname = "127.0.0.1";
        return original(url, init);
      }) as typeof fetch;
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(directory, "preload.ts"),
        join(import.meta.dir, "mainroom.ts"),
        "codex",
        ...args,
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}/bin:${process.env.PATH}`,
          MAINROOM_CONFIG_DIR: join(directory, "config"),
          CODEX_HOME: join(directory, "normal-codex"),
          TEST_BUN: process.execPath,
          TEST_LOGIN_SCRIPT: join(directory, "login.ts"),
          TEST_RECORD: join(directory, "record.json"),
          TEST_MODE: mode,
        },
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
    const output = stdout + stderr;
    expect(output).not.toContain("private-refresh-token");
    expect(
      await Bun.file(join(directory, "normal-codex/auth.json")).text(),
    ).toBe("original-local-login");
    if (await Bun.file(join(directory, "record.json")).exists()) {
      const record = await Bun.file(join(directory, "record.json")).json();
      expect(record.home).not.toBe(join(directory, "normal-codex"));
      expect(record.mode).toBe(0o700);
      expect(await stat(record.home).catch(() => undefined)).toBeUndefined();
      expect(await Bun.file(join(record.home, "auth.json")).exists()).toBe(
        false,
      );
      expect(record.args).toContain('cli_auth_credentials_store="file"');
    }
    return { code, output, uploads, reloads, disabled };
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

test("reauth replaces the selected remote record and verifies real inference", async () => {
  const result = await recoveryCase("success");
  expect(result.code).toBe(0);
  expect(result.uploads).toHaveLength(1);
  expect(result.uploads[0].filename).toBe("saved.json");
  expect(result.reloads).toBe(1);
  expect(result.output).toContain("Inference verified");
});

test("cancellation and another account or workspace member cannot overwrite remote auth", async () => {
  for (const mode of ["cancelled", "wrong-account", "wrong-email"]) {
    const result = await recoveryCase(mode);
    expect(result.code).toBe(1);
    expect(result.uploads).toHaveLength(0);
    expect(result.reloads).toBe(0);
    expect(result.output.toLowerCase()).toContain(
      "remote credentials were not changed",
    );
  }
});

test("HTTP 200 with failed inference never reports recovery", async () => {
  const result = await recoveryCase("inference-failed");
  expect(result.code).toBe(1);
  expect(result.output).toContain("inference verification failed");
  expect(result.output).not.toContain("Inference verified");
});

test("disabling the last account retains credentials and skips restart", async () => {
  const result = await recoveryCase("disable", [
    "disable",
    "saved.json",
    "--yes",
  ]);
  expect(result.disabled).toBe(true);
  expect(result.uploads).toHaveLength(0);
  expect(result.reloads).toBe(0);
  expect(result.output).toContain("No enabled Codex accounts");
});
