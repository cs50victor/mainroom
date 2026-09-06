import { checkbox, confirm, number } from "@inquirer/prompts";
import { InvalidArgumentError } from "commander";
import { z } from "zod";
import {
  fetchCodexAccounts,
  fetchIncomingShares,
  fetchOutgoingShares,
  reloadTokenproxyConfig,
  updateShare,
} from "./api";
import { readCredentials } from "./credentials";
import { normalizeShareGrantInput, type ShareLimits } from "../src/shares";
import {
  shareUsageSchema,
  incomingSharesSchema,
  outgoingSharesSchema,
} from "../src/schemas/shares";

type InviteOptions = {
  models?: string[];
  requestsPerDay?: number;
  serviceTiers: string[];
  yes?: boolean;
};

export function positiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Enter a positive whole number.");
  }
  return parsed;
}

export async function inviteFriend(
  username: string,
  options: InviteOptions,
): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) throw new Error("Run `mainroom auth signup` first.");
  const interactive = Boolean(process.stdin.isTTY && !options.yes);
  let models = options.models;
  let requests = options.requestsPerDay;
  if ((!models || requests === undefined) && !interactive) {
    throw new Error(
      "Pass --models and --requests-per-day when running without prompts.",
    );
  }
  if (!models) {
    const accounts = await fetchCodexAccounts(
      credentials.apiUrl,
      credentials.token,
    );
    if (!accounts.ok) throw new Error(accounts.error);
    const available = [
      ...new Set(
        accounts.data.accounts
          .filter((account) => account.status === "ready")
          .flatMap((account) => account.models ?? []),
      ),
    ];
    if (!available.length)
      throw new Error(
        "No ready Codex models found. Run `mainroom codex status`, or pass --models for another provider.",
      );
    models = await checkbox({
      message: `Models to share with ${username}`,
      choices: available.map((value) => ({ value })),
      required: true,
    });
  }
  if (requests === undefined) {
    requests = await number({
      message: "Maximum requests per UTC day",
      min: 1,
      required: true,
      validate: (value) =>
        Number.isSafeInteger(value) || "Enter a whole number.",
    });
  }
  const body = {
    models,
    routes: ["responses"],
    service_tiers: options.serviceTiers,
    limits: { requests_per_day: requests },
  };
  const input = normalizeShareGrantInput(body);
  if ("error" in input) throw new Error(input.error);
  console.log(
    `Share with ${username}: ${input.models.join(", ")} | Responses | tiers ${input.serviceTiers.join(", ")} | ${requests} requests/day (UTC).`,
  );
  console.log(
    "Access starts immediately and replaces any existing share for this friend.",
  );
  if (!(await approved(options.yes))) return 0;
  const result = await updateShare(
    credentials.apiUrl,
    credentials.token,
    username,
    "PUT",
    body,
  );
  if (!result.ok) throw new Error(result.error);
  console.log(
    `Access granted to ${result.data.grant.consumerUsername}. They can run \`mainroom share list\` and \`mainroom share connect\`.`,
  );
  return reportReconcile(result.data.reconcile);
}

export async function listShares(options: { json?: boolean }): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) throw new Error("Run `mainroom auth signup` first.");
  const [outgoing, incoming] = await Promise.all([
    fetchOutgoingShares(credentials.apiUrl, credentials.token),
    fetchIncomingShares(credentials.apiUrl, credentials.token),
  ]);
  if (!outgoing.ok) throw new Error(outgoing.error);
  if (!incoming.ok) throw new Error(incoming.error);
  if (options.json) {
    console.log(
      JSON.stringify(
        { outgoing: outgoing.data.grants, incoming: incoming.data.shares },
        null,
        2,
      ),
    );
    return 0;
  }
  const friends = new Map<
    string,
    {
      incoming?: z.infer<typeof incomingSharesSchema>["shares"][number];
      outgoing?: z.infer<typeof outgoingSharesSchema>["grants"][number];
    }
  >();
  for (const share of incoming.data.shares)
    friends.set(share.provider, { incoming: share });
  for (const grant of outgoing.data.grants) {
    friends.set(grant.consumerUsername, {
      ...friends.get(grant.consumerUsername),
      outgoing: grant,
    });
  }
  if (!friends.size)
    console.log("No friends yet. Run `mainroom friends invite <username>`.");
  for (const [username, friend] of [...friends].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(username);
    const from = friend.incoming;
    const to = friend.outgoing;
    console.log(`  Sharing with you: ${from?.status ?? "none"}`);
    if (from) {
      console.log(
        `    ${from.models.join(", ")} (${from.routes.join(", ")}; tiers ${from.service_tiers.join(", ")})`,
      );
      printUsage(from.limits, from.usage);
    }
    console.log(`  You share: ${to?.status ?? "none"}`);
    if (to) {
      console.log(
        `    ${to.models.join(", ")} (${to.routes.join(", ")}; tiers ${to.serviceTiers.join(", ")})`,
      );
      printUsage(to.limits, to.usage);
    }
  }
  console.log(
    "Reserved output counts requested maxima, not actual tokens consumed or a friend's subscription balance.",
  );
  return 0;
}

export async function changeShare(
  username: string,
  action: "enable" | "disable" | "revoke",
  options: { yes?: boolean },
): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) throw new Error("Run `mainroom auth signup` first.");
  console.log(
    `${action} sharing with ${username}; updating their node may interrupt active requests.`,
  );
  if (!(await approved(options.yes))) return 0;
  const result = await updateShare(
    credentials.apiUrl,
    credentials.token,
    username,
    action === "revoke" ? "DELETE" : "PATCH",
    action === "revoke"
      ? undefined
      : { status: action === "enable" ? "active" : "disabled" },
  );
  if (!result.ok) throw new Error(result.error);
  console.log(`Sharing with ${username}: ${result.data.grant.status}.`);
  return reportReconcile(result.data.reconcile);
}

export async function connectShares(): Promise<number> {
  const credentials = await readCredentials();
  if (!credentials) throw new Error("Run `mainroom auth signup` first.");
  const incoming = await fetchIncomingShares(
    credentials.apiUrl,
    credentials.token,
  );
  if (!incoming.ok) throw new Error(incoming.error);
  if (!incoming.data.shares.length)
    throw new Error(
      "No shares from friends. Ask a friend to run `mainroom friends invite <your-username>`.",
    );
  const result = await reloadTokenproxyConfig(
    credentials.apiUrl,
    credentials.token,
  );
  if (!result.ok) throw new Error(result.error);
  console.log(
    "Your endpoint configuration now includes active shares from friends.",
  );
  return 0;
}

async function approved(yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw new Error("Pass --yes to confirm without an interactive terminal.");
  return confirm({ message: "Apply this change?", default: false });
}

function reportReconcile(result: { error?: string } | undefined): number {
  if (!result?.error) return 0;
  console.error(
    `${result.error}. Ask them to run \`mainroom share connect\` to refresh their endpoint.`,
  );
  return 1;
}

function printUsage(
  limits: ShareLimits,
  usage: z.infer<typeof shareUsageSchema>,
): void {
  const inFlight = limits.maxConcurrentRequests
    ? `${usage.inFlight}/${limits.maxConcurrentRequests}`
    : "not tracked";
  console.log(
    `    ${usage.day} UTC: ${usage.requests}/${limits.requestsPerDay ?? "unlimited"} requests; ${usage.reservedOutputTokens}/${limits.tokensPerDay ?? "unlimited"} reserved output tokens; in flight: ${inFlight}`,
  );
}
