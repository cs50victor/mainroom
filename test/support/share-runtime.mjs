import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const built = await build({
  stdin: {
    contents: `
        import { ShareGrantStore as Store } from "./src/worker";
        export class ShareGrantStore extends Store {
          async fetch(request) {
            if (new URL(request.url).pathname === "/__seed") {
              await this.ctx.storage.put(await request.json());
              return new Response(null, {status: 204});
            }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env) {
          return env.SHARE_GRANT_STORE.get(env.SHARE_GRANT_STORE.idFromName("stress")).fetch(request);
        }};
      `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:*"],
  loader: { ".woff2": "binary" },
  plugins: [
    {
      name: "text-imports",
      setup(builder) {
        builder.onLoad({ filter: /.*/ }, async (args) =>
          args.with.type === "text"
            ? { contents: await readFile(args.path, "utf8"), loader: "text" }
            : undefined,
        );
      },
    },
  ],
});
const runtime = new Miniflare({
  modules: true,
  script: built.outputFiles[0].text,
  compatibilityDate: "2026-06-16",
  cf: false,
  durableObjects: {
    SHARE_GRANT_STORE: { className: "ShareGrantStore", useSQLite: true },
  },
  log: new Log(LogLevel.ERROR),
});
process.on("SIGTERM", async () => {
  await runtime.dispose();
  process.exit(0);
});
process.stdin.resume();
process.stdin.on("end", async () => {
  await runtime.dispose();
  process.exit(0);
});
console.log(String(await runtime.ready));
