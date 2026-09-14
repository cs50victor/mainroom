import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const built = await build({
  stdin: {
    contents: `
      import { checkCodexAccount } from "./src/codex-accounts";
      export default { async fetch(request) {
        return Response.json(await checkCodexAccount("saved.json", await request.text()));
      }};
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
let providerStatus = 200;
const calls = [];
const runtime = new Miniflare({
  modules: true,
  script: built.outputFiles[0].text,
  compatibilityDate: "2026-06-16",
  cf: false,
  log: new Log(LogLevel.ERROR),
  outboundService(request) {
    calls.push(new URL(request.url).hostname);
    return new Response(JSON.stringify({ models: [{ slug: "test-model" }] }), {
      status: providerStatus,
      headers: {
        "content-type": "application/json",
        location: "https://redirect.example/models",
      },
    });
  },
});
try {
  const results = [];
  for (const status of [200, 401, 302]) {
    providerStatus = status;
    calls.length = 0;
    const response = await runtime.dispatchFetch("https://mainroom.test", {
      method: "POST",
      body: JSON.stringify({
        tokens: { account_id: "test-account", access_token: "test-token" },
      }),
    });
    results.push({ account: await response.json(), hosts: [...calls] });
  }
  console.log(JSON.stringify(results));
} finally {
  await runtime.dispose();
}
