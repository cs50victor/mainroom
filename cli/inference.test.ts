import { expect, test } from "bun:test";
import { hasCompletedResponse, verifyInference } from "./inference";

test("recovery sends message-list input accepted by Codex", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    const body = JSON.parse(String(init?.body));
    return Array.isArray(body.input) && body.input[0]?.role === "user"
      ? Response.json({ status: "completed" })
      : Response.json({ detail: "Input must be a list" }, { status: 400 });
  }) as typeof fetch;
  try {
    await expect(
      verifyInference("https://mainroom.test", "synthetic-key", "alice", [
        "test-model",
      ]),
    ).resolves.toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires a completed inference, not just HTTP 200 or a model list", async () => {
  for (const body of [
    'data: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    'data: {"type":"response.created"}\n\ndata: [DONE]\n\n',
    '{"data":[{"id":"model"}]}',
    'data: {"type":"response.completed","response":{}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"failed"}}\n\n',
  ])
    expect(await hasCompletedResponse(new Response(body))).toBe(false);
  expect(
    await hasCompletedResponse(
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
      ),
    ),
  ).toBe(true);
  expect(
    await hasCompletedResponse(
      new Response(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
      ),
    ),
  ).toBe(true);
});

test("parses multiline SSE with LF, CRLF, and CR framing", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const body = [
      ": keepalive",
      "event: response.completed",
      'data: {"type":"response.completed",',
      'data: "response":{"status":"completed"}}',
      "",
      "",
    ].join(newline);
    expect(await hasCompletedResponse(new Response(body))).toBe(true);
  }
});

test("decodes split UTF-8 chunks and cancels an open stream on completion", async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.completed","response":{"status":"completed","output":"café"}}\n\n',
  );
  let offset = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length)
          controller.enqueue(bytes.slice(offset, ++offset));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  expect(await hasCompletedResponse(response)).toBe(true);
  await Bun.sleep(0);
  expect(cancelled).toBe(true);
});

test("requires a complete SSE event and bounds unterminated event buffering", async () => {
  expect(
    await hasCompletedResponse(
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}',
      ),
    ),
  ).toBe(false);
  await expect(
    hasCompletedResponse(new Response(`data: ${"x".repeat(1024 * 1024 + 1)}`)),
  ).rejects.toThrow();
});

test("supports JSON inference responses and rejects failed or malformed payloads", async () => {
  expect(
    await hasCompletedResponse(Response.json({ status: "completed" })),
  ).toBe(true);
  for (const value of [
    null,
    [],
    { status: "failed" },
    { status: "incomplete" },
  ]) {
    expect(await hasCompletedResponse(Response.json(value))).toBe(false);
  }
});
