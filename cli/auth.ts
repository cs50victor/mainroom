import { input } from "@inquirer/prompts";
import {
  fetchCliOAuthConfig,
  mintCliApiKey,
  normalizeApiUrl,
  verifyApiKey,
} from "./api";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials";
import { errorMessage, isMissingFile } from "./errors";
import { createOAuthSession, exchangeOAuthCode, openBrowser } from "./oauth";
import type { AuthCommandOptions, AuthMode } from "./types";

export async function login(
  options: AuthCommandOptions,
  command: AuthMode,
): Promise<number> {
  const apiUrl = normalizeApiUrl(options.apiUrl);

  if (options.withToken) {
    return loginWithToken(apiUrl);
  }

  return loginWithOAuth(apiUrl, command);
}

export async function logout(): Promise<number> {
  try {
    await deleteCredentials();
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error(`Could not log out: ${errorMessage(error)}`);
      return 1;
    }
  }

  console.log("Logged out of Mainroom");
  return 0;
}

export async function authStatus(): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.log("You are not logged in");
    return 1;
  }

  const result = await verifyApiKey(credentials.apiUrl, credentials.token);

  if (!result.ok) {
    console.log(
      `Login check failed for ${credentials.apiUrl}: ${result.error}`,
    );
    return 1;
  }

  console.log(`Logged in to ${credentials.apiUrl}`);
  return 0;
}

export async function ping(): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.error("You are not logged in. Run `mainroom auth signup` first.");
    return 1;
  }

  const result = await verifyApiKey(credentials.apiUrl, credentials.token);

  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  console.log(JSON.stringify(result.data));
  return 0;
}

async function loginWithToken(apiUrl: string): Promise<number> {
  const token = (await Bun.stdin.text()).trim();
  if (!token) {
    console.error("No API key provided on standard input.");
    return 1;
  }

  const result = await verifyApiKey(apiUrl, token);

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
  command: AuthMode,
): Promise<number> {
  if (await isLoggedIn(apiUrl)) {
    console.log(`Already logged in to ${apiUrl}`);
    return 0;
  }

  const config = await fetchCliOAuthConfig(apiUrl);
  if (!config.ok) {
    console.error(config.error);
    console.error(
      "To use an existing API key, run `mainroom auth login --with-token`.",
    );
    return 1;
  }

  const username = command === "signup" ? await promptForUsername() : undefined;
  const session = await createOAuthSession(config.data);

  console.log(`Opening browser: ${session.authorizeUrl}`);
  openBrowser(session.authorizeUrl);
  console.log(
    command === "signup"
      ? "Complete signup in your browser."
      : "Complete login in your browser.",
  );

  const code = await session.codePromise;
  const accessToken = await exchangeOAuthCode(config.data, {
    code,
    state: session.state,
    verifier: session.verifier,
  });
  const result = await mintCliApiKey(apiUrl, accessToken, { username });

  await writeCredentials({
    apiUrl,
    keyId: result.apiKey.id,
    token: result.apiKey.secret,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Logged in to ${apiUrl}`);
  if (command === "signup" && result.username) {
    console.log(
      `${result.username}.mainroom.sh will be ready to use after you run \`mainroom codex sync\`.`,
    );
  }
  return 0;
}

async function isLoggedIn(apiUrl: string): Promise<boolean> {
  const credentials = await readCredentials();
  if (!credentials || normalizeApiUrl(credentials.apiUrl) !== apiUrl) {
    return false;
  }

  return (await verifyApiKey(credentials.apiUrl, credentials.token)).ok;
}

async function promptForUsername(): Promise<string> {
  return input({
    message: "Choose a Mainroom username",
    required: true,
    validate(value) {
      return value.trim().length > 0 || "Username is required";
    },
  }).then((value) => value.trim());
}
