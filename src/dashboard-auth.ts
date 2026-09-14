import { createClerkClient } from "@clerk/backend";
import { bearerToken, ClerkApiError, type AppConfig } from "./helpers";
import { mainroomUserAgent } from "./version";

export async function dashboardSubject(
  config: AppConfig,
  request: Request,
): Promise<string> {
  const origin = "https://mainroom.sh";
  const requestOrigin = request.headers.get("origin");
  if (
    new URL(request.url).origin !== origin ||
    !bearerToken(request) ||
    (requestOrigin !== null && requestOrigin !== origin)
  ) {
    throw new ClerkApiError(401, "Sign in to Mainroom", undefined);
  }
  const client = createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
    apiUrl: config.clerkApiUrl,
    apiVersion: config.clerkApiVersion,
    userAgent: mainroomUserAgent,
    telemetry: { disabled: true },
  });
  const state = await client.authenticateRequest(request, {
    acceptsToken: "session_token",
    authorizedParties: [origin],
  });
  if (!state.isAuthenticated) {
    throw new ClerkApiError(401, "Sign in to Mainroom", undefined);
  }
  const auth = state.toAuth();
  if (
    !auth.isAuthenticated ||
    auth.tokenType !== "session_token" ||
    auth.sessionClaims.azp !== origin
  ) {
    throw new ClerkApiError(401, "Sign in to Mainroom", undefined);
  }
  return auth.userId;
}
