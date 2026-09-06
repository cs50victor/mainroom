import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";

const completedResponseSchema = z.object({ status: z.literal("completed") });
const responseEventSchema = z.object({
  type: z.string(),
  response: z.object({ status: z.string() }).optional(),
});
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

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
  const data = modelsSchema.parse(await models.json());
  const model = data.data.find((item) => codexModels.includes(item.id))?.id;
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
  if (response.headers.get("content-type")?.includes("application/json")) {
    return completedResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    ).success;
  }
  if (!response.body) return false;
  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: 1024 * 1024 }));
  for await (const message of events) {
    if (message.data === "[DONE]") return false;
    let value: unknown;
    try {
      value = JSON.parse(message.data);
    } catch {
      return false;
    }
    const event = responseEventSchema.safeParse(value);
    if (!event.success) return false;
    if (event.data.type === "response.completed")
      return completedResponseSchema.safeParse(event.data.response).success;
    if (
      ["response.failed", "response.incomplete", "error"].includes(
        event.data.type,
      )
    )
      return false;
  }
  return false;
}
