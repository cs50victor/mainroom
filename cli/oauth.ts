import * as oauth from "oauth4webapi";
import type { CliOAuthConfig } from "./types";

const redirectUri = "http://127.0.0.1:8989/callback";
const scope = "profile email";

type OAuthSession = {
  authorizeUrl: string;
  codePromise: Promise<string>;
  verifier: string;
  state: string;
};

export async function createOAuthSession(
  config: CliOAuthConfig,
): Promise<OAuthSession> {
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const state = oauth.generateRandomState();
  const codePromise = waitForOAuthCode(config, state);
  const authorizeUrl = buildAuthorizeUrl(config, { challenge, state });

  return { authorizeUrl, codePromise, verifier, state };
}

export async function exchangeOAuthCode(
  config: CliOAuthConfig,
  params: { code: string; verifier: string; state: string },
): Promise<string> {
  const authorizationServer: oauth.AuthorizationServer = {
    issuer: new URL(config.authorizeUrl).origin,
    authorization_endpoint: config.authorizeUrl,
    token_endpoint: config.tokenUrl,
  };
  const client: oauth.Client = { client_id: config.clientId };
  const callbackParameters = oauth.validateAuthResponse(
    authorizationServer,
    client,
    callbackUrl(params.code, params.state),
    params.state,
  );
  const options = config.tokenUrl.startsWith("http://")
    ? { [oauth.allowInsecureRequests]: true }
    : undefined;
  const response = await oauth.authorizationCodeGrantRequest(
    authorizationServer,
    client,
    oauth.None(),
    callbackParameters,
    redirectUri,
    params.verifier,
    options,
  );
  const token = await oauth.processAuthorizationCodeResponse(
    authorizationServer,
    client,
    response,
  );

  return token.access_token;
}

export function openBrowser(url: string): void {
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

function buildAuthorizeUrl(
  config: CliOAuthConfig,
  params: { challenge: string; state: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function callbackUrl(code: string, state: string): URL {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url;
}

async function waitForOAuthCode(
  config: CliOAuthConfig,
  state: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: new URL(redirectUri).port,
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== new URL(redirectUri).pathname) {
          return new Response("Not found", { status: 404 });
        }

        try {
          const params = oauth.validateAuthResponse(
            {
              issuer: new URL(config.authorizeUrl).origin,
              authorization_endpoint: config.authorizeUrl,
              token_endpoint: config.tokenUrl,
            },
            { client_id: config.clientId },
            url,
            state,
          );
          const code = params.get("code");
          if (!code) throw new Error("OAuth callback did not include a code");

          resolve(code);
          setTimeout(() => server.stop(true), 0);
          return new Response(
            "Mainroom login complete. You can close this tab.",
          );
        } catch (error) {
          reject(error);
          setTimeout(() => server.stop(true), 0);
          return new Response(
            "Mainroom login failed. You can close this tab.",
            { status: 400 },
          );
        }
      },
    });
  });
}
