// Event shapes and gated delivery follow openai/codex's responses.rs and
// streaming_sse.rs helpers. Pinned sources and test boundaries: test/SHARING.md.
export function responseEvents(
  id: string,
  text: string,
  terminal = "completed",
) {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.added",
      item: {
        id: `${id}_msg`,
        type: "message",
        role: "assistant",
        content: [],
      },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: `${id}_msg`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: `response.${terminal}`,
      response: {
        id,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        ...(terminal === "failed"
          ? {
              error: {
                code: "server_error",
                message: "Synthetic upstream failure",
              },
            }
          : {}),
      },
    },
  ];
}

export function sse(events: ReturnType<typeof responseEvents>, newline = "\n") {
  return events
    .map(
      (event) =>
        `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`,
    )
    .join("");
}

export function responseStream(
  text: string,
  chunkSize: number,
  holdOpen = false,
) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const delivered = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull(value) {
      if (offset < bytes.length) {
        value.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
        if (offset >= bytes.length) delivered.resolve();
      } else if (!holdOpen) value.close();
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "synthetic",
      },
    }),
    delivered: delivered.promise,
    close: () => controller.close(),
    fail: () => controller.error(new Error("Synthetic stream reset")),
    get canceled() {
      return canceled;
    },
  };
}
