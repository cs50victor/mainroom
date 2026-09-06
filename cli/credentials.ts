import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { isMissingFile } from "./errors";
import type { Credentials } from "./types";

const credentialsSchema = z.object({
  apiUrl: z.string(),
  keyId: z.string().optional(),
  token: z.string(),
  updatedAt: z.string(),
});

export async function readCredentials(): Promise<Credentials | undefined> {
  try {
    return credentialsSchema.parse(
      JSON.parse(await Bun.file(credentialsPath()).text()),
    );
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function writeCredentials(
  credentials: Credentials,
): Promise<void> {
  const path = credentialsPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function deleteCredentials(): Promise<void> {
  await Bun.file(credentialsPath()).delete();
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

function configDir(): string {
  const configured = Bun.env.MAINROOM_CONFIG_DIR;
  if (configured) return configured;

  return join(homedir(), ".config", "mainroom");
}
