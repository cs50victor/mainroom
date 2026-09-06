import { Scalar } from "@scalar/hono-api-reference";
import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";
import { html, raw } from "hono/html";
import { marked } from "marked";

import overview from "./content/overview.md" with { type: "text" };
import gettingStarted from "./content/getting-started.md" with { type: "text" };
import authentication from "./content/authentication.md" with { type: "text" };
import inference from "./content/inference.md" with { type: "text" };
import api from "./content/api.md" with { type: "text" };
import skill from "./content/SKILL.md" with { type: "text" };
import styles from "./site.css" with { type: "text" };
import { mainroomVersion } from "./version";

const origin = "https://mainroom.sh";
const prompt = `Set up Mainroom for me: ${origin}/SKILL.md`;
const description =
  "Your accounts. One inference endpoint. Set up Mainroom with your coding agent.";
const pages = [
  { path: "/guides", title: "Mainroom guides", content: overview },
  {
    path: "/guides/getting-started",
    title: "Getting started",
    content: gettingStarted,
  },
  {
    path: "/guides/authentication",
    title: "Authentication",
    content: authentication,
  },
  { path: "/guides/inference", title: "Inference", content: inference },
  { path: "/guides/api", title: "API and sharing", content: api },
];

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

function layout(
  title: string,
  path: string,
  markdownPath: string,
  content: ReturnType<typeof html>,
  landing = false,
) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <meta name="description" content="${description}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="${origin}${path}" />
        <meta name="twitter:card" content="summary" />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2330332e'/%3E%3Ctext x='5' y='24' font-family='Georgia' font-size='28' font-weight='bold' fill='%23fafaf8'%3Em%3C/text%3E%3C/svg%3E"
        />
        <link rel="canonical" href="${origin}${path}" />
        <link
          rel="alternate"
          type="text/markdown"
          href="${origin}${markdownPath}"
        />
        <link
          rel="describedby"
          type="text/markdown"
          href="${origin}/llms.txt"
        />
        <link rel="api-catalog" href="${origin}/.well-known/api-catalog" />
        <link rel="stylesheet" href="/site.css" />
        <script type="application/ld+json">
          ${raw(
            JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Mainroom",
              url: origin,
              description,
              inLanguage: "en",
            }),
          )}
        </script>
        ${landing ? html`<script src="/site.js" defer></script>` : ""}
      </head>
      <body class="${landing ? "landing" : "documentation"}">
        <a class="skip-link" href="#main">Skip to content</a>
        <header class="site-header">
          <a class="brand" href="/" aria-label="Mainroom home"
            ><span class="brand-mark" aria-hidden="true">m</span>mainroom</a
          >
          <nav aria-label="Main navigation">
            <a href="/guides">Guides</a>
            <a href="/docs">API docs</a>
            <a href="https://github.com/cs50victor/mainroom"
              >GitHub <span aria-hidden="true">↗</span></a
            >
          </nav>
        </header>
        ${content}
        <footer class="site-footer">
          <span>mainroom <span class="version">v${mainroomVersion}</span></span>
          <a href="/SKILL.md"
            >Read the setup skill <span aria-hidden="true">↗</span></a
          >
        </footer>
      </body>
    </html>`;
}

const homepage = layout(
  "Mainroom | Your accounts. One endpoint.",
  "/",
  "/index.md",
  html`<main id="main" class="hero">
    <div class="hero-inner">
      <p class="eyebrow">PERSONAL INFERENCE</p>
      <h1>Your accounts.<br />One endpoint.</h1>
      <p class="intro">Bring your accounts. Let your agent handle the setup.</p>
      <div class="prompt-group">
        <div class="prompt-tab">
          <span class="agent-mark" aria-hidden="true">&gt;_</span> Build with
          your agent
        </div>
        <div class="prompt-card">
          <span class="prompt-chevron" aria-hidden="true">›</span>
          <code id="setup-prompt"
            >Set up Mainroom for me:
            <a href="/SKILL.md">mainroom.sh/SKILL.md</a></code
          >
          <button
            id="copy-prompt"
            type="button"
            aria-label="Copy setup prompt"
            data-prompt="${prompt}"
          >
            <svg
              aria-hidden="true"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
            >
              <rect x="8" y="8" width="12" height="13" rx="2" />
              <path
                d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"
              />
            </svg>
          </button>
        </div>
        <p
          id="copy-status"
          class="prompt-hint"
          role="status"
          aria-live="polite"
        >
          Copy the prompt into your coding agent to get started.
        </p>
      </div>
      <a class="manual-link" href="/guides/getting-started"
        >Or set up manually <span aria-hidden="true">↗</span></a
      >
    </div>
  </main>`,
  true,
);

const copyScript = `const button = document.getElementById("copy-prompt");
button.addEventListener("click", async () => {
  const status = document.getElementById("copy-status");
  try {
    await navigator.clipboard.writeText(button.dataset.prompt);
    status.textContent = "Copied. Paste it into your coding agent.";
    button.setAttribute("aria-label", "Copy setup prompt again");
  } catch {
    status.textContent = "Select the prompt text and copy it into your coding agent.";
  }
});`;

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
    // Only repository-owned Markdown is rendered; request data never enters marked.
    const rendered = marked.parse(page.content, { async: false });
    const pageHtml = layout(
      `${page.title} | Mainroom`,
      page.path,
      `${page.path}.md`,
      html`<main id="main" class="guide-layout">
        <nav class="guide-nav" aria-label="Guides">
          ${pages.map(
            (entry) =>
              html`<a
                href="${entry.path}"
                aria-current="${entry.path === page.path ? "page" : "false"}"
                >${entry.title}</a
              >`,
          )}
        </nav>
        <article class="prose">
          <a class="markdown-link" href="${page.path}.md">Read as Markdown</a
          >${raw(rendered)}
        </article>
      </main>`,
    );
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

  const index = `# Mainroom\n\n> Personal inference endpoints backed by connected accounts.\n\nPublic API origin: ${origin}. Inference base URL: https://<username>.mainroom.sh/v1.\n\n## Setup\n\n- [Mainroom setup skill](${origin}/SKILL.md): Install, sign in, sync accounts, and verify inference.\n\n## Guides\n\n${pages.map((page) => `- [${page.title}](${origin}${page.path}.md)`).join("\n")}\n\n## API\n\n- [OpenAPI](${origin}/openapi.json): Generated container API schema; additional Worker routes are covered in the API and sharing guide.\n- [API catalog](${origin}/.well-known/api-catalog): API discovery.\n\n## Optional\n\n- [Complete documentation](${origin}/llms-full.txt): All guides and the setup skill in one file.\n- [Source](https://github.com/cs50victor/mainroom)\n`;
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
