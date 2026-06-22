import { checkbox } from "@inquirer/prompts";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { reloadTokenproxyConfig, uploadJson, verifyApiKey } from "./api";
import { readCredentials } from "./credentials";
import { isMissingFile } from "./errors";
import type { CodexSyncOptions } from "./types";

const cliProxyDir = ".cli-proxy-api";
const codexAuthFile = "auth.json";

const cliProxyCodexAuthSchema = z.object({
  access_token: z.string(),
  account_id: z.string(),
  disabled: z.boolean().optional(),
  email: z.string(),
  expired: z.string(),
  id_token: z.string(),
  last_refresh: z.string(),
  refresh_token: z.string(),
  type: z.literal("codex"),
});

const codexAuthSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  last_refresh: z.string(),
  tokens: z.object({
    access_token: z.string(),
    account_id: z.string(),
    id_token: z.string(),
    refresh_token: z.string(),
  }),
});

type AuthCandidate = {
  email?: string;
  expiresAt: string;
  lastRefresh: string;
  path: string;
  text: string;
  uploadName: string;
};

export async function syncCodex(options: CodexSyncOptions): Promise<number> {
  console.log("Checking Mainroom sign-in...");
  const credentials = await readCredentials();
  if (!credentials) {
    console.error("You are not logged in. Run `mainroom auth signup` first.");
    return 1;
  }

  const authCheck = await verifyApiKey(credentials.apiUrl, credentials.token);
  if (!authCheck.ok) {
    console.error(
      `Login check failed for ${credentials.apiUrl}: ${authCheck.error}`,
    );
    return 1;
  }

  console.log("Scanning Codex auth files...");
  const eligible = (await readAuthCandidates())
    .filter((candidate) => isFutureDate(candidate.expiresAt))
    .sort((a, b) => Date.parse(b.lastRefresh) - Date.parse(a.lastRefresh));

  if (eligible.length === 0) {
    console.log("No unexpired Codex auth JSON files found.");
    return 1;
  }

  console.log(`Found ${eligible.length} eligible Codex auth file(s).`);

  const selected = options.yes
    ? eligible
    : await checkbox<AuthCandidate>({
        message: "Select Codex auth files to upload",
        choices: eligible.map((candidate) => ({
          name: authLabel(candidate),
          value: candidate,
          description: candidate.path,
          checked: true,
        })),
        pageSize: 10,
        required: true,
      });

  console.log(`Uploading ${selected.length} Codex auth file(s)...`);
  for (const candidate of selected) {
    const result = await uploadJson(
      credentials.apiUrl,
      credentials.token,
      candidate.text,
      candidate.uploadName,
    );

    if (!result.ok) {
      console.error(`${candidate.path}: ${result.error}`);
      return 1;
    }

    console.log(
      `${candidate.path} -> s3://${result.data.bucket}/${result.data.key}`,
    );
  }

  const reload = await reloadTokenproxyConfig(
    credentials.apiUrl,
    credentials.token,
  );
  if (!reload.ok) {
    console.error(
      `Uploaded auth JSON, but tokenproxy reload failed: ${reload.error}`,
    );
    return 1;
  }

  console.log(
    reload.data.created
      ? "Tokenproxy started with the updated config."
      : reload.data.restarted
        ? "Tokenproxy restarted with the updated config."
        : "Tokenproxy config reload requested.",
  );

  return 0;
}

async function readAuthCandidates(): Promise<AuthCandidate[]> {
  const codexAuth = await readCodexAuthCandidate();
  const cliProxyAuths = await readCliProxyCodexAuthCandidates();

  return codexAuth ? [codexAuth, ...cliProxyAuths] : cliProxyAuths;
}

async function readCodexAuthCandidate(): Promise<AuthCandidate | undefined> {
  const path = codexAuthPath();

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const parsed = codexAuthSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return undefined;

  const expiresAt = jwtExpiresAt(parsed.data.tokens.access_token);
  if (!expiresAt) return undefined;

  const idToken = jwtPayload(parsed.data.tokens.id_token);
  const accessToken = jwtPayload(parsed.data.tokens.access_token);
  const profile = accessToken?.["https://api.openai.com/profile"];
  const profileEmail =
    typeof profile === "object" && profile !== null
      ? (profile as Record<string, unknown>).email
      : undefined;
  const email =
    typeof idToken?.email === "string"
      ? idToken.email
      : typeof profileEmail === "string"
        ? profileEmail
        : undefined;
  const accountId = uploadNamePart(parsed.data.tokens.account_id);

  return {
    expiresAt,
    lastRefresh: parsed.data.last_refresh,
    path,
    text,
    uploadName: email
      ? `codex-${accountId}-${uploadNamePart(email)}.json`
      : `codex-${accountId}.json`,
  };
}

async function readCliProxyCodexAuthCandidates(): Promise<AuthCandidate[]> {
  const dir = join(homeDir(), cliProxyDir);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const candidates: AuthCandidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const path = join(dir, entry);
    const text = await Bun.file(path).text();
    const parsed = cliProxyCodexAuthSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.disabled) continue;

    candidates.push({
      email: parsed.data.email,
      expiresAt: parsed.data.expired,
      lastRefresh: parsed.data.last_refresh,
      path,
      text,
      uploadName: basename(path),
    });
  }

  return candidates;
}

function authLabel(candidate: AuthCandidate): string {
  const account = candidate.email ?? basename(candidate.path);
  return `${account} (refresh ${candidate.lastRefresh}, expires ${candidate.expiresAt})`;
}

function codexAuthPath(): string {
  const codexHome = Bun.env.CODEX_HOME;
  if (codexHome) return join(codexHome, codexAuthFile);

  return join(homeDir(), ".codex", codexAuthFile);
}

function homeDir(): string {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is required to find Codex auth files");
  return home;
}

function isFutureDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function jwtExpiresAt(token: string): string | undefined {
  const parsed = z.object({ exp: z.number() }).safeParse(jwtPayload(token));
  if (!parsed.success) return undefined;

  return new Date(parsed.data.exp * 1000).toISOString();
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (!payload) return undefined;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  const parsed = z.record(z.string(), z.unknown()).safeParse(claims);

  return parsed.success ? parsed.data : undefined;
}

function uploadNamePart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._@+-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}
