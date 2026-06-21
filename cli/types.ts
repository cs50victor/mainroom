export const defaultApiUrl = "https://mainroom.sh";

export type AuthCommandOptions = {
  apiUrl: string;
  withToken?: boolean;
};

export type CodexSyncOptions = {
  yes?: boolean;
};

export type AuthMode = "login" | "signup";

export type Credentials = {
  apiUrl: string;
  keyId?: string;
  token: string;
  updatedAt: string;
};

export type CliOAuthConfig = {
  authorizeUrl: string;
  clientId: string;
  tokenUrl: string;
};
