import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { join } from "node:path";

// Keep Miniflare in its Node runtime and outside MSW's global HTTP interception.
const localFetch = globalThis.fetch;

export async function shareRuntime() {
  const child = Bun.spawn(
    ["node", join(import.meta.dir, "share-runtime.mjs")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const lines = createInterface({
    input: Readable.fromWeb(child.stdout as never),
  });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error(`Miniflare failed to start: ${await stderr}`);
  const origin = new URL(first.value);
  const output = (async () => {
    for await (const _line of iterator) {
      // Reading to EOF keeps the child from blocking on a full stdout pipe.
    }
  })();
  return {
    fetch(request: Request) {
      const url = new URL(request.url);
      url.host = origin.host;
      url.protocol = origin.protocol;
      return localFetch(new Request(url, request));
    },
    async close() {
      await child.stdin.end();
      const code = await child.exited;
      await output;
      const errors = await stderr;
      if (code !== 0) throw new Error(`Miniflare exited ${code}: ${errors}`);
    },
  };
}
