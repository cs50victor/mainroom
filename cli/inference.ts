export async function verifyInference(
  apiUrl: string,
  token: string,
  username: string,
  codexModels: string[],
): Promise<void> {
  const base = new URL(apiUrl);
  base.hostname = `${username}.${base.hostname}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const models = await fetch(new URL("/v1/models", base), {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!models.ok)
    throw new Error(`Model endpoint returned HTTP ${models.status}`);
  const data = (await models.json()) as { data?: { id?: unknown }[] };
  const model = data.data?.find(
    (item) => typeof item.id === "string" && codexModels.includes(item.id),
  )?.id;
  if (typeof model !== "string")
    throw new Error("The endpoint has no usable models");
  const response = await fetch(new URL("/v1/responses", base), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: "Reply with OK.",
      input: "Connection check",
      store: false,
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`Inference returned HTTP ${response.status}`);
  if (!(await hasCompletedResponse(response)))
    throw new Error("Inference did not complete successfully");
  console.log(`Inference verified at ${base.origin}/v1/responses`);
}

export async function hasCompletedResponse(
  response: Response,
): Promise<boolean> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      return JSON.parse(text).status === "completed";
    } catch {
      return false;
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (
        event.type === "response.completed" &&
        event.response?.status === "completed"
      )
        return true;
    } catch {
      /* Ignore SSE keepalives and the terminal marker. */
    }
  }
  return false;
}
