import { Scalar } from "@scalar/hono-api-reference";
import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";

import { HomePage } from "./site/home-page";
import { GuidePage } from "./site/guide-page";
import { origin, overview, pages, skill } from "./site/content";
import styles from "./generated/site.css" with { type: "text" };
import copyScript from "./site/copy-prompt.js" with { type: "text" };

import fontRegular from "./site/fonts/dm-sans-400.woff2";
import fontMedium from "./site/fonts/dm-sans-500.woff2";
import fontBold from "./site/fonts/dm-sans-700.woff2";

function isPublicHost(hostname: string): boolean {
  return ["mainroom.sh", "localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function markdownPreferred(c: Context): boolean {
  return (
    accepts(c, {
      header: "Accept",
      supports: ["text/html", "text/markdown"],
      default: "text/html",
      match: (values, config) =>
        values
          .filter(
            (value) => value.q > 0 && config.supports.includes(value.type),
          )
          .sort((a, b) => b.q - a.q)[0]?.type ?? config.default,
    }) === "text/markdown"
  );
}

function discoveryHeaders(c: Context, path: string, markdownPath?: string) {
  const links = [
    `<${origin}${path}>; rel="canonical"`,
    `<${origin}/llms.txt>; rel="describedby"; type="text/markdown"`,
    `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  ];
  if (markdownPath) {
    links.push(
      `<${origin}${markdownPath}>; rel="alternate"; type="text/markdown"`,
    );
  }
  c.header("Link", links.join(", "));
  c.header("Cache-Control", "public, max-age=300");
  c.header("X-Content-Type-Options", "nosniff");
}

function markdownResponse(c: Context, content: string) {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(content);
}

const homepage = HomePage().toString();

export function createPublicSite(): Hono {
  const site = new Hono();

  site.get("/", (c, next) => {
    if (!isPublicHost(new URL(c.req.url).hostname)) return next();
    discoveryHeaders(c, "/", "/index.md");
    c.header("Vary", "Accept", { append: true });
    if (markdownPreferred(c)) return markdownResponse(c, overview);
    return c.html(homepage);
  });

  for (const page of pages) {
    const pageHtml = GuidePage({ page }).toString();
    site.get(page.path, (c) => {
      discoveryHeaders(c, page.path, `${page.path}.md`);
      c.header("Vary", "Accept", { append: true });
      if (markdownPreferred(c)) return markdownResponse(c, page.content);
      return c.html(pageHtml);
    });
    site.get(`${page.path}.md`, (c) => {
      discoveryHeaders(c, page.path);
      return markdownResponse(c, page.content);
    });
    site.get(`${page.path}/`, (c) => c.redirect(page.path, 308));
  }

  const index = `# Mainroom\n\n> Pool subscription inference capacity with friends or research groups. Each member uses one endpoint backed by their own accounts and shared peer nodes.\n\nPublic API origin: ${origin}. Inference base URL: https://<username>.mainroom.sh/v1.\n\n## Setup\n\n- [Mainroom setup skill](${origin}/SKILL.md): Install, contribute accounts, connect friends' nodes, and verify shared inference.\n\n## Guides\n\n${pages.map((page) => `- [${page.title}](${origin}${page.path}.md)`).join("\n")}\n\n## API\n\n- [OpenAPI](${origin}/openapi.json): Generated container API schema; additional Worker routes are covered in the API and sharing guide.\n- [API catalog](${origin}/.well-known/api-catalog): API discovery.\n\n## Optional\n\n- [Complete documentation](${origin}/llms-full.txt): All guides and the setup skill in one file.\n- [Source](https://github.com/cs50victor/mainroom)\n`;
  const full = `${pages.map((page) => `Source: ${origin}${page.path}\n\n${page.content.trim()}`).join("\n\n---\n\n")}\n\n---\n\nSource: ${origin}/SKILL.md\n\n${skill}`;

  for (const [path, content] of [
    ["/index.md", overview],
    ["/SKILL.md", skill],
    ["/llms.txt", index],
    ["/llms-full.txt", full],
  ]) {
    site.get(path, (c) => {
      discoveryHeaders(c, path === "/index.md" ? "/" : path);
      return markdownResponse(c, content);
    });
  }

  site.get(
    "/docs",
    (c, next) => {
      discoveryHeaders(c, "/docs");
      c.header(
        "Link",
        `<${origin}/openapi.json>; rel="service-desc"; type="application/json"`,
        { append: true },
      );
      return next();
    },
    Scalar({ url: "/openapi.json" }),
  );
  site.get("/docs/", (c) => c.redirect("/docs", 308));

  site.get("/robots.txt", (c) => {
    c.header("Content-Type", "text/plain; charset=utf-8");
    if (!isPublicHost(new URL(c.req.url).hostname)) {
      return c.body("User-agent: *\nDisallow: /\n");
    }
    return c.body(
      `User-agent: *\nAllow: /\nDisallow: /v0/\nDisallow: /v1/\n\nSitemap: ${origin}/sitemap.xml\n`,
    );
  });
  site.get("/sitemap.xml", (c) => {
    discoveryHeaders(c, "/sitemap.xml");
    c.header("Content-Type", "application/xml; charset=utf-8");
    const paths = ["/", ...pages.map((page) => page.path), "/docs"];
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n")}\n</urlset>\n`,
    );
  });
  site.get("/.well-known/api-catalog", (c) => {
    discoveryHeaders(c, "/.well-known/api-catalog");
    c.header(
      "Content-Type",
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    );
    return c.body(
      JSON.stringify({
        linkset: [
          {
            anchor: `${origin}/v0`,
            "service-desc": [
              { href: `${origin}/openapi.json`, type: "application/json" },
            ],
            "service-doc": [
              { href: `${origin}/guides/api`, type: "text/html" },
            ],
            status: [{ href: `${origin}/health`, type: "application/json" }],
          },
        ],
      }),
    );
  });
  const fonts = [
    ["/fonts/dm-sans-400.woff2", fontRegular],
    ["/fonts/dm-sans-500.woff2", fontMedium],
    ["/fonts/dm-sans-700.woff2", fontBold],
  ] as const;
  for (const [path, font] of fonts) {
    site.get(path, async (c) => {
      // Bun imports asset paths; Workers Data modules supply the bytes.
      const bytes =
        typeof font === "string"
          ? await (await fetch(new URL(font, "file:///"))).arrayBuffer()
          : font;
      c.header("Content-Type", "font/woff2");
      c.header("Cache-Control", "public, max-age=86400");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(bytes);
    });
  }
  site.get("/site.css", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(styles);
  });
  site.get("/site.js", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(copyScript);
  });

  return site;
}
