import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenproxyStartup } from "./fly-machines";

test("each boot fetches fresh private config and rejects invalid credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mainroom-startup-"));
  let revision = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "Bearer test-client-key") {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(`revision = ${++revision}\n`);
    },
  });

  try {
    const binary = join(directory, "tokenproxy");
    await writeFile(binary, '#!/bin/sh\nprintf "%s" "$2"\n');
    await chmod(binary, 0o700);
    async function boot(token: string) {
      const process = Bun.spawn(tokenproxyStartup(server.url.toString()), {
        env: {
          PATH: `${directory}:${Bun.env.PATH}`,
          TMPDIR: directory,
          TOKENPROXY_CLIENT_KEY: token,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      return { code, output };
    }

    for (const expected of [1, 2]) {
      const result = await boot("test-client-key");
      expect(result.code).toBe(0);
      expect(await readFile(result.output, "utf8")).toBe(
        `revision = ${expected}\n`,
      );
      expect((await stat(result.output)).mode & 0o777).toBe(0o600);
    }
    const denied = await boot("wrong-key");
    expect(denied.code).not.toBe(0);
    expect(denied.output).toBe("");
    expect(revision).toBe(2);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
