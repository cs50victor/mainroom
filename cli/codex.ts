import { checkbox, confirm, select } from "@inquirer/prompts";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import {
  fetchCodexAccounts,
  reloadTokenproxyConfig,
  setCodexAccountEnabled,
  uploadJson,
  verifyApiKey,
} from "./api";
import { readCredentials } from "./credentials";
import { isMissingFile } from "./errors";
import type {
  CodexReauthOptions,
  CodexSyncOptions,
  Credentials,
} from "./types";
import { codexAuthIdentity } from "../src/codex-accounts";
import type { CodexAccountStatus } from "../src/schemas/codex-accounts";
import { verifyInference } from "./inference";

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
  accountId?: string;
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
    if (
      !options.yes &&
      process.stdin.isTTY &&
      (await confirm({ message: "Sign in to Codex now?", default: true }))
    ) {
      return reauthCodex({});
    }
    console.error("Run `mainroom codex reauth` to connect a fresh login.");
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

  return finishCodexRecovery(credentials, !options.yes);
}

async function checkedCredentials(): Promise<Credentials | undefined> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.error("Run `mainroom auth login` first.");
    return undefined;
  }
  const auth = await verifyApiKey(credentials.apiUrl, credentials.token);
  if (!auth.ok) {
    console.error(
      `Mainroom login failed: ${auth.error}. Run \`mainroom auth login\`.`,
    );
    return undefined;
  }
  return credentials;
}

function showAccounts(accounts: CodexAccountStatus[]): void {
  for (const account of accounts) {
    console.log(
      `${account.uploadName}: ${account.status}${account.email ? ` (${account.email})` : ""}`,
    );
    if (account.detail) console.log(`  ${account.detail}`);
    if (account.status === "reauth_required")
      console.log(`  mainroom codex reauth --account ${account.uploadName}`);
    if (account.status === "invalid")
      console.log(`  mainroom codex disable ${account.uploadName}`);
  }
}

export async function codexStatus(): Promise<number> {
  const credentials = await checkedCredentials();
  if (!credentials) return 1;
  const result = await fetchCodexAccounts(
    credentials.apiUrl,
    credentials.token,
  );
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (!result.data.accounts.length)
    console.log("No Codex accounts connected. Run `mainroom codex reauth`.");
  showAccounts(result.data.accounts);
  const enabled = result.data.accounts.filter(
    (account) => account.status !== "disabled",
  );
  return enabled.length > 0 &&
    enabled.every((account) => account.status === "ready")
    ? 0
    : 1;
}

export async function reauthCodex(
  options: CodexReauthOptions,
): Promise<number> {
  const credentials = await checkedCredentials();
  if (!credentials) return 1;
  const codex = Bun.which("codex");
  if (!codex) {
    console.error(
      "Codex CLI is required for sign-in. Install it from https://developers.openai.com/codex/cli, then rerun this command.",
    );
    return 1;
  }
  const result = await fetchCodexAccounts(
    credentials.apiUrl,
    credentials.token,
  );
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  const accounts = result.data.accounts;
  let target = accounts.find(
    (account) => account.uploadName === options.account,
  );
  if (options.account && !target) {
    console.error("Account not found. Run `mainroom codex status`.");
    return 1;
  }
  if (!target && accounts.length === 1) target = accounts[0];
  if (!target && accounts.length > 1) {
    if (!process.stdin.isTTY) {
      console.error(
        "Choose an account with --account. Run `mainroom codex status`.",
      );
      return 1;
    }
    target = await select({
      message: "Which account should sign in again?",
      choices: accounts.map((account) => ({
        name: `${account.email ?? account.uploadName} (${account.status})`,
        value: account,
      })),
    });
  }
  if (target && !target.accountId) {
    console.error(
      "This stored file has no account identity. Disable it with `mainroom codex disable`, then use `mainroom codex sync` to upload a valid account.",
    );
    return 1;
  }
  console.log(
    target
      ? `Sign in to Codex as ${target.email ?? target.accountId}.`
      : "Sign in to the Codex account you want to connect.",
  );
  console.log(
    `The refreshed credential will be uploaded to ${credentials.apiUrl} for your remote tokenproxy.`,
  );
  const directory = await mkdtemp(join(tmpdir(), "mainroom-codex-"));
  await chmod(directory, 0o700);
  try {
    const args = [codex, "-c", 'cli_auth_credentials_store="file"', "login"];
    if (options.deviceAuth) args.push("--device-auth");
    const child = Bun.spawn(args, {
      cwd: directory,
      env: { ...Bun.env, CODEX_HOME: directory },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    if (cancelled || exitCode !== 0) {
      console.error(
        "Codex sign-in did not complete. Remote credentials were not changed.",
      );
      return 1;
    }
    const candidate = await readCodexAuthCandidate(
      join(directory, "auth.json"),
    );
    if (!candidate || !isFutureDate(candidate.expiresAt)) {
      console.error(
        "Codex did not produce a usable ChatGPT credential. Remote credentials were not changed.",
      );
      return 1;
    }
    if (
      target &&
      (candidate.accountId !== target.accountId ||
        (target.email &&
          target.email.toLowerCase() !== candidate.email?.toLowerCase()))
    ) {
      console.error(
        `Signed in to a different account. Expected ${target.email ?? target.accountId}; remote credentials were not changed.`,
      );
      return 1;
    }
    const uploadName = target?.uploadName ?? candidate.uploadName;
    const upload = await uploadJson(
      credentials.apiUrl,
      credentials.token,
      candidate.text,
      uploadName,
    );
    if (!upload.ok) {
      console.error(`Credential upload failed: ${upload.error}`);
      return 1;
    }
    const enabled = await setCodexAccountEnabled(
      credentials.apiUrl,
      credentials.token,
      uploadName,
      true,
    );
    if (!enabled.ok) {
      console.error(
        `Credential uploaded, but account validation failed: ${enabled.error}`,
      );
      return 1;
    }
    console.log(`Updated ${uploadName}.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return finishCodexRecovery(credentials, false);
}

export async function disableCodex(
  uploadName: string,
  options: CodexSyncOptions,
): Promise<number> {
  const credentials = await checkedCredentials();
  if (!credentials) return 1;
  const result = await fetchCodexAccounts(
    credentials.apiUrl,
    credentials.token,
  );
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (
    !result.data.accounts.some((account) => account.uploadName === uploadName)
  ) {
    console.error("Account not found. Run `mainroom codex status`.");
    return 1;
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error("Use --yes to disable this account without a prompt.");
      return 1;
    }
    if (
      !(await confirm({
        message: `Disable ${uploadName}? Its credential will be kept.`,
        default: false,
      }))
    )
      return 0;
  }
  const disabled = await setCodexAccountEnabled(
    credentials.apiUrl,
    credentials.token,
    uploadName,
    false,
  );
  if (!disabled.ok) {
    console.error(disabled.error);
    return 1;
  }
  console.log(
    `Disabled ${uploadName}. Run \`mainroom codex reauth --account ${uploadName}\` to reconnect it.`,
  );
  return finishCodexRecovery(credentials, false);
}

async function finishCodexRecovery(
  credentials: Credentials,
  prompt: boolean,
): Promise<number> {
  console.log("Checking remote Codex accounts...");
  const result = await fetchCodexAccounts(
    credentials.apiUrl,
    credentials.token,
  );
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  const enabled = result.data.accounts.filter(
    (account) => account.status !== "disabled",
  );
  const blocked = enabled.filter((account) => account.status !== "ready");
  if (blocked.length) {
    showAccounts(blocked);
    const reauth = blocked.find(
      (account) => account.status === "reauth_required",
    );
    if (
      prompt &&
      reauth &&
      process.stdin.isTTY &&
      (await confirm({
        message: `Sign in again as ${reauth.email ?? reauth.uploadName}?`,
        default: true,
      }))
    ) {
      return reauthCodex({ account: reauth.uploadName });
    }
    console.error(
      "The remote endpoint is not ready. Reauthenticate rejected accounts or disable accounts you no longer use.",
    );
    return 1;
  }
  if (!enabled.length) {
    console.log(
      "No enabled Codex accounts. Run `mainroom codex reauth` to connect one.",
    );
    return 1;
  }
  console.log("Reloading remote tokenproxy...");
  const reload = await reloadTokenproxyConfig(
    credentials.apiUrl,
    credentials.token,
  );
  if (!reload.ok) {
    console.error(`Tokenproxy reload failed: ${reload.error}`);
    return 1;
  }
  if (!result.data.username) {
    console.error(
      "No Mainroom username is configured; inference could not be verified.",
    );
    return 1;
  }
  try {
    await verifyInference(
      credentials.apiUrl,
      credentials.token,
      result.data.username,
      enabled.flatMap((account) => account.models ?? []),
    );
    return 0;
  } catch (error) {
    console.error(
      `Credentials saved, but inference verification failed: ${error instanceof Error ? error.message : "request failed"}. Run \`mainroom codex status\` for account details.`,
    );
    return 1;
  }
}

async function readAuthCandidates(): Promise<AuthCandidate[]> {
  const codexAuth = await readCodexAuthCandidate();
  const cliProxyAuths = await readCliProxyCodexAuthCandidates();

  return codexAuth ? [codexAuth, ...cliProxyAuths] : cliProxyAuths;
}

async function readCodexAuthCandidate(
  path = codexAuthPath(),
): Promise<AuthCandidate | undefined> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = codexAuthSchema.safeParse(value);
  const identity = codexAuthIdentity(text);
  if (!parsed.success || !identity?.expiresAt) return undefined;
  const { email, expiresAt } = identity;

  const accountId = uploadNamePart(parsed.data.tokens.account_id);

  return {
    email,
    expiresAt,
    lastRefresh: parsed.data.last_refresh,
    path,
    text,
    accountId: identity.accountId,
    uploadName: email
      ? `codex-${accountId}-${uploadNamePart(email)}.json`
      : `codex-${accountId}.json`,
  };
}

async function readCliProxyCodexAuthCandidates(): Promise<AuthCandidate[]> {
  const dir = join(homedir(), cliProxyDir);

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

  return join(homedir(), ".codex", codexAuthFile);
}

function isFutureDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
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
