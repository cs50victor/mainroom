import { chmod, mkdir } from "node:fs/promises";
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
  await mkdir(configDir(), { recursive: true });
  await Bun.write(path, `${JSON.stringify(credentials, null, 2)}\n`);
  await chmod(path, 0o600);
}

export async function deleteCredentials(): Promise<void> {
  await Bun.file(credentialsPath()).delete();
}

export function credentialsPath(): string {
  return `${configDir()}/credentials.json`;
}

function configDir(): string {
  const configured = Bun.env.MAINROOM_CONFIG_DIR;
  if (configured) return configured;

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is required to store Mainroom credentials");

  return `${home}/.config/mainroom`;
}
