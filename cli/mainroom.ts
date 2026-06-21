#!/usr/bin/env bun

const version = "0.1.0";
const defaultApiUrl = "https://mainroom.sh";

type Credentials = {
  apiUrl: string;
  keyId?: string;
  token: string;
  updatedAt: string;
};

type CliOAuthConfig = {
  authorizeUrl: string;
  clientId: string;
  tokenUrl: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type CliExchangeResponse = {
  apiKey: {
    id: string;
    subject: string;
    secret: string;
  };
};

type RequestOptions = {
  method?: "GET" | "POST";
  token?: string;
};

const usage = `Mainroom CLI ${version}

Use Mainroom from your terminal.

Usage:
  mainroom <command> <subcommand> [flags]
  mainroom --help
  mainroom --version

Commands:
  auth         Create accounts, log in, and manage local credentials
  ping         Call the authenticated ping endpoint
  hello        Print hello

Options:
  -h, --help           Show help
  -v, --version        Show version

Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom auth status
  $ mainroom ping`;

async function main(args: string[]): Promise<number> {
  const [command, subcommand] = args;

  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }

  if (command === "hello") {
    console.log("hello");
    return 0;
  }

  if (command === "auth") {
    return auth(args.slice(1));
  }

  if (command === "ping") {
    return ping();
  }

  console.error(`Unknown command: ${args.join(" ")}`);
  console.error("Run `mainroom --help` for usage.");
  return 1;
}

async function auth(args: string[]): Promise<number> {
  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    console.log(authUsage);
    return 0;
  }

  if (command === "login" || command === "signup") {
    return login(args.slice(1), command);
  }

  if (command === "logout") {
    return logout();
  }

  if (command === "status") {
    return authStatus();
  }

  console.error(`Unknown command: auth ${args.join(" ")}`);
  console.error("Run `mainroom auth --help` for usage.");
  return 1;
}

const authUsage = `Authenticate Mainroom and manage local credentials.

First-time users should run signup. The browser flow can create a Clerk account,
then Mainroom stores a local API key for future CLI commands.

Usage:
  mainroom auth signup [--api-url <url>]
  mainroom auth login [--api-url <url>]
  mainroom auth login --with-token [--api-url <url>]
  mainroom auth logout
  mainroom auth status

Available Commands:
  signup   Create a Clerk account or sign in, then save a local API key
  login    Log in to an existing account, with account creation available
  logout   Remove saved authentication
  status   Display saved authentication state

Flags:
      --api-url <url>  Mainroom API origin (default: ${defaultApiUrl})
      --with-token     Read an existing Mainroom API key from stdin
  -h, --help           Show help

Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom auth login --with-token < mainroom-api-key.txt
  $ mainroom auth logout`;

async function login(
  args: string[],
  command: "login" | "signup",
): Promise<number> {
  const apiUrl = normalizeApiUrl(
    parseOption(args, "--api-url") ?? defaultApiUrl,
  );

  if (args.includes("--with-token")) {
    return loginWithToken(apiUrl);
  }

  return loginWithOAuth(apiUrl, command);
}

async function loginWithToken(apiUrl: string): Promise<number> {
  const token = (await Bun.stdin.text()).trim();
  if (!token) {
    console.error("No API key received on stdin.");
    return 1;
  }

  const result = await requestJson<{ ok: boolean; version: string }>(
    apiUrl,
    "/v0/ping",
    { token },
  );

  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  await writeCredentials({
    apiUrl,
    token,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Logged in to ${apiUrl}`);
  return 0;
}

async function loginWithOAuth(
  apiUrl: string,
  command: "login" | "signup",
): Promise<number> {
  const config = await requestJson<CliOAuthConfig>(
    apiUrl,
    "/v0/auth/cli/config",
  );
  if (!config.ok) {
    console.error(config.error);
    console.error("You can still use `mainroom auth login --with-token`.");
    return 1;
  }

  const redirectUri = "http://127.0.0.1:8989/callback";
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const codePromise = waitForOAuthCode(state);
  const authorizeUrl = buildAuthorizeUrl(config.data, {
    redirectUri,
    state,
    challenge,
  });

  console.log(`Opening ${authorizeUrl}`);
  openBrowser(authorizeUrl);
  console.log(
    command === "signup"
      ? "Waiting for browser sign-up..."
      : "Waiting for browser sign-in...",
  );

  const code = await codePromise;
  const accessToken = await exchangeOAuthCode(config.data, {
    code,
    redirectUri,
    verifier,
  });
  const apiKey = await mintCliApiKey(apiUrl, accessToken);

  await writeCredentials({
    apiUrl,
    keyId: apiKey.id,
    token: apiKey.secret,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Logged in to ${apiUrl}`);
  return 0;
}

async function logout(): Promise<number> {
  const path = credentialsPath();

  try {
    await Bun.file(path).delete();
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error(`Failed to remove credentials: ${errorMessage(error)}`);
      return 1;
    }
  }

  console.log("Logged out");
  return 0;
}

async function authStatus(): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.log("Not logged in");
    return 1;
  }

  const result = await requestJson<{ ok: boolean; version: string }>(
    credentials.apiUrl,
    "/v0/ping",
    { token: credentials.token },
  );

  if (!result.ok) {
    console.log(`Not logged in to ${credentials.apiUrl}: ${result.error}`);
    return 1;
  }

  console.log(`Logged in to ${credentials.apiUrl}`);
  return 0;
}

async function ping(): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.error("Not logged in. Run `mainroom auth signup` first.");
    return 1;
  }

  const result = await requestJson<{ ok: boolean; version: string }>(
    credentials.apiUrl,
    "/v0/ping",
    { token: credentials.token },
  );

  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  console.log(JSON.stringify(result.data));
  return 0;
}

function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function normalizeApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function requestJson<T>(
  apiUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(new URL(path, `${apiUrl}/`), {
      method: options.method ?? "GET",
      headers: options.token
        ? { Authorization: `Bearer ${options.token}` }
        : undefined,
    });
    const body = await response.json().catch(() => undefined);

    if (!response.ok) {
      return {
        ok: false,
        error:
          errorFromBody(body) ??
          `Mainroom request failed with HTTP ${response.status}`,
      };
    }

    return { ok: true, data: body as T };
  } catch (error) {
    return {
      ok: false,
      error: `Mainroom request failed: ${errorMessage(error)}`,
    };
  }
}

async function exchangeOAuthCode(
  config: CliOAuthConfig,
  params: { code: string; redirectUri: string; verifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await response.json().catch(() => undefined)) as
    | OAuthTokenResponse
    | undefined;

  if (!response.ok || !token?.access_token) {
    throw new Error(
      token?.error_description ??
        token?.error ??
        `OAuth token exchange failed with HTTP ${response.status}`,
    );
  }

  return token.access_token;
}

async function mintCliApiKey(
  apiUrl: string,
  oauthToken: string,
): Promise<CliExchangeResponse["apiKey"]> {
  const result = await requestJson<CliExchangeResponse>(
    apiUrl,
    "/v0/auth/cli/exchange",
    { method: "POST", token: oauthToken },
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data.apiKey;
}

function buildAuthorizeUrl(
  config: CliOAuthConfig,
  params: { redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function waitForOAuthCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 8989,
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          server.stop(true);
          reject(new Error(error));
          return new Response(
            "Mainroom login failed. You can close this tab.",
            {
              status: 400,
            },
          );
        }

        if (url.searchParams.get("state") !== state) {
          server.stop(true);
          reject(new Error("OAuth state mismatch"));
          return new Response(
            "Mainroom login failed. You can close this tab.",
            {
              status: 400,
            },
          );
        }

        const code = url.searchParams.get("code");
        if (!code) {
          server.stop(true);
          reject(new Error("OAuth callback did not include a code"));
          return new Response(
            "Mainroom login failed. You can close this tab.",
            {
              status: 400,
            },
          );
        }

        server.stop(true);
        resolve(code);
        return new Response("Mainroom login complete. You can close this tab.");
      },
    });
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];

  try {
    Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The printed URL is enough when no system browser opener is available.
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function errorFromBody(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }

  return undefined;
}

async function readCredentials(): Promise<Credentials | undefined> {
  try {
    const parsed = JSON.parse(
      await Bun.file(credentialsPath()).text(),
    ) as unknown;
    if (!isCredentials(parsed)) {
      throw new Error("Credentials file is invalid");
    }

    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeCredentials(credentials: Credentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(configDir());
  await Bun.write(path, `${JSON.stringify(credentials, null, 2)}\n`);
  await chmod(path, 0o600);
}

function credentialsPath(): string {
  return `${configDir()}/credentials.json`;
}

function configDir(): string {
  const configured = Bun.env.MAINROOM_CONFIG_DIR;
  if (configured) return configured;

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is required to store Mainroom credentials");

  return `${home}/.config/mainroom`;
}

async function chmod(path: string, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    import("node:fs").then(({ chmod }) => {
      chmod(path, mode, (error) => (error ? reject(error) : resolve()));
    }, reject);
  });
}

async function mkdir(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    import("node:fs").then(({ mkdir }) => {
      mkdir(path, { recursive: true }, (error) =>
        error ? reject(error) : resolve(),
      );
    }, reject);
  });
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== "object" || value === null) return false;

  return (
    hasString(value, "apiUrl") &&
    hasString(value, "token") &&
    hasString(value, "updatedAt")
  );
}

function hasString(value: object, key: string): boolean {
  return key in value && typeof value[key as keyof typeof value] === "string";
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

export {};
