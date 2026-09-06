import { expect, test } from "bun:test";
import { hasCompletedResponse } from "./inference";

test("requires a completed inference, not just HTTP 200 or a model list", async () => {
  for (const body of [
    'data: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    'data: {"type":"response.created"}\n\ndata: [DONE]\n\n',
    '{"data":[{"id":"model"}]}',
  ])
    expect(await hasCompletedResponse(new Response(body))).toBe(false);
  expect(
    await hasCompletedResponse(
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
      ),
    ),
  ).toBe(true);
});
