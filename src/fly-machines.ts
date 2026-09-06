export type FlyMachine = {
  id?: unknown;
  instance_id?: unknown;
  state?: unknown;
  config?: Record<string, unknown> & { init?: { exec?: string[] } };
};

export type FlyMachineConfig = {
  apiToken: string;
  appHostname: string;
  appName: string;
  cpus: number;
  image: string;
  memoryMb: number;
  region?: string;
};

export type FlyMachineEnv = {
  FLY_API_TOKEN?: string;
  FLY_APP_HOSTNAME?: string;
  FLY_APP_NAME?: string;
  FLY_MACHINE_CPUS?: string;
  FLY_MACHINE_MEMORY_MB?: string;
  FLY_MACHINE_REGION?: string;
  FLY_TOKENPROXY_IMAGE?: string;
};

export type FlyMachineRecord = {
  flyMachineId?: string;
};

export function tokenproxyStartup(configUrl: string): string[] {
  return [
    "/bin/bash",
    "-ec",
    `umask 077
config_file=$(mktemp "\${TMPDIR:-/tmp}/tokenproxy.XXXXXX")
trap 'rm -f "$config_file"' EXIT
curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \\
  --header "Authorization: Bearer $TOKENPROXY_CLIENT_KEY" "$1" --output "$config_file"
exec tokenproxy --config "$config_file" -c "server.bind='0.0.0.0:8787'" -c server.allow_non_loopback=true`,
    "tokenproxy-startup",
    configUrl,
  ];
}

export async function startFlyMachine(
  fly: FlyMachineConfig,
  machineId: string,
  exec: string[],
): Promise<FlyMachine> {
  const path = `/machines/${encodeURIComponent(machineId)}`;
  let machine = await flyMachineApi<FlyMachine>(fly, path);
  if (!machine.config) throw new Error("Fly machine configuration is missing");

  if (JSON.stringify(machine.config.init?.exec) !== JSON.stringify(exec)) {
    await flyMachineApi<FlyMachine>(fly, path, {
      method: "POST",
      body: JSON.stringify({
        config: {
          ...machine.config,
          init: { ...machine.config.init, exec },
        },
      }),
    });
    await flyMachineApi(fly, `${path}/wait?state=started&timeout=30`);
    return flyMachineApi<FlyMachine>(fly, path);
  }

  if (machine.state !== "started" && machine.state !== "starting") {
    await flyMachineApi(fly, `${path}/start`, { method: "POST" });
    machine = await flyMachineApi<FlyMachine>(fly, path);
  }
  return machine;
}

export async function stopFlyMachine(
  fly: FlyMachineConfig,
  machineId: string,
): Promise<void> {
  const path = `/machines/${encodeURIComponent(machineId)}`;
  const machine = await flyMachineApi<FlyMachine>(fly, path);
  if (machine.state === "stopped") return;
  if (typeof machine.instance_id !== "string")
    throw new Error("Fly machine instance ID is missing");
  // Stopping suspended machines also discards their stale in-memory config.
  if (machine.state !== "stopping") {
    await flyMachineApi(fly, `${path}/stop`, {
      method: "POST",
      body: JSON.stringify({ signal: "SIGTERM", timeout: "10s" }),
    });
  }
  await flyMachineApi(
    fly,
    `${path}/wait?state=stopped&instance_id=${encodeURIComponent(machine.instance_id)}&timeout=30`,
  );
}

export function flyMachineName(
  subject: string,
  runtimeVersion: string,
): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `user-${slug || "subject"}-${runtimeVersion.replace(/[^a-z0-9]+/g, "-")}`;
}

export function flyMachineConfig(
  env: FlyMachineEnv,
): FlyMachineConfig | undefined {
  if (!env.FLY_API_TOKEN || !env.FLY_APP_NAME || !env.FLY_TOKENPROXY_IMAGE) {
    return undefined;
  }

  return {
    apiToken: env.FLY_API_TOKEN,
    appHostname: env.FLY_APP_HOSTNAME ?? `${env.FLY_APP_NAME}.fly.dev`,
    appName: env.FLY_APP_NAME,
    cpus: positiveIntegerEnv(env.FLY_MACHINE_CPUS, 1),
    image: env.FLY_TOKENPROXY_IMAGE,
    memoryMb: positiveIntegerEnv(env.FLY_MACHINE_MEMORY_MB, 256),
    region: env.FLY_MACHINE_REGION,
  };
}

export function positiveIntegerEnv(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function flyMachineApi<T = unknown>(
  fly: FlyMachineConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${fly.apiToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(
    `https://api.machines.dev/v1/apps/${encodeURIComponent(fly.appName)}${path}`,
    { ...init, headers },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Fly Machines API ${init.method ?? "GET"} ${path} failed with ${response.status}${body ? `: ${body}` : ""}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function flyMachineFetch(
  fly: FlyMachineConfig,
  record: FlyMachineRecord,
  request: Request,
): Promise<Response> {
  if (!record.flyMachineId) {
    return Promise.resolve(
      Response.json({ error: "Fly machine is not ready" }, { status: 503 }),
    );
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(request.url);
  targetUrl.protocol = "https:";
  targetUrl.hostname = fly.appHostname;
  targetUrl.port = "";
  const headers = new Headers(request.headers);

  /*
   * Fly Proxy owns per-Machine routing. The public docs describe
   * fly-force-instance-id, and the 2026-06-23 smoke test created two Machines
   * in one Fly app and verified 3/3 HTTP requests pinned to each target
   * Machine by ID while unpinned requests load balanced between them.
   */
  headers.set("fly-force-instance-id", record.flyMachineId);
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-mainroom-host", sourceUrl.hostname);

  return fetch(
    new Request(targetUrl, {
      body: request.body,
      headers,
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    }),
  );
}
