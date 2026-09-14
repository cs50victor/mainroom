import { expect, test } from "bun:test";
import { join } from "node:path";

test("Worker account checks discover models, identify rejected credentials, and refuse redirects", async () => {
  const child = Bun.spawn(
    [
      "node",
      join(import.meta.dir, "../test/support/codex-accounts-runtime.mjs"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject([
    {
      account: { status: "ready", models: ["test-model"] },
      hosts: ["chatgpt.com"],
    },
    { account: { status: "reauth_required" }, hosts: ["chatgpt.com"] },
    { account: { status: "unavailable" }, hosts: ["chatgpt.com"] },
  ]);
}, 30000);
