import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "./credentials";

const originalConfigDir = process.env.MAINROOM_CONFIG_DIR;
let directory: string | undefined;
afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.MAINROOM_CONFIG_DIR;
  else process.env.MAINROOM_CONFIG_DIR = originalConfigDir;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("credential writes stay private and concurrent readers only see complete records", async () => {
  directory = await mkdtemp(join(tmpdir(), "mainroom-credentials-test-"));
  const configDir = join(directory, "config");
  process.env.MAINROOM_CONFIG_DIR = configDir;
  const base = {
    apiUrl: "https://mainroom.test",
    updatedAt: new Date().toISOString(),
  };
  const tokens = Array.from(
    { length: 12 },
    (_, i) => `token-${i}-${"x".repeat(8192)}`,
  );
  await writeCredentials({ ...base, token: tokens[0] });
  expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  let finished = false;
  const writes = Promise.all(
    tokens.map((token) => writeCredentials({ ...base, token })),
  ).finally(() => {
    finished = true;
  });
  try {
    do {
      expect(tokens).toContain((await readCredentials())?.token);
      expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
    } while (!finished);
  } finally {
    await writes;
  }
  expect(await readdir(configDir)).toEqual(["credentials.json"]);
});
