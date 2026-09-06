import { describe, expect, test } from "bun:test";
import { createPublicSite } from "./public-site";

const site = createPublicSite();
const origin = "https://mainroom.sh";

describe("public website", () => {
  test("serves the setup prompt in HTML without a redirect or JavaScript rendering", async () => {
    const response = await site.request(origin);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.has("Location")).toBe(false);
    expect(body).toContain("Set up Mainroom for me:");
    expect(body).toContain('href="/SKILL.md"');
    expect(body).toContain('href="/docs"');
    expect(body).toContain(
      'data-prompt="Set up Mainroom for me: https://mainroom.sh/SKILL.md"',
    );
  });

  test("keeps the existing interactive API reference at /docs", async () => {
    const response = await site.request(`${origin}/docs`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/openapi.json");
    expect(response.headers.get("Link")).toContain(
      '/openapi.json>; rel="service-desc"',
    );
  });

  test("serves compiled styles and the external setup script", async () => {
    const css = await site.request(`${origin}/site.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toStartWith("text/css");
    const styles = await css.text();
    expect(styles).toContain("tailwindcss");
    expect(styles).not.toContain("@import");
    expect(styles).not.toContain("@source");

    const script = await site.request(`${origin}/site.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toStartWith("text/javascript");
    expect(await script.text()).toContain("navigator.clipboard.writeText");
  });

  test("renders a complete document with valid structured metadata", async () => {
    const body = await (await site.request(origin)).text();
    expect(body).toStartWith("<!doctype html>");
    const metadata = body.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    expect(metadata).not.toBeNull();
    expect(JSON.parse(metadata![1])).toMatchObject({
      "@type": "WebSite",
      name: "Mainroom",
      url: origin,
    });
  });

  test.each([
    ["text/markdown", "text/markdown"],
    ["text/html", "text/html"],
    ["*/*", "text/html"],
    ["text/markdown;q=0, text/html", "text/html"],
    ["text/markdown;q=0", "text/html"],
    ["text/markdown;q=0.5, text/html;q=0.9", "text/html"],
    ["text/html;q=0.5, text/markdown;q=0.9", "text/markdown"],
  ])("negotiates %s as %s", async (accept, expected) => {
    const response = await site.request(`${origin}/guides/inference`, {
      headers: { Accept: accept },
    });
    expect(response.headers.get("Content-Type")).toStartWith(expected);
    expect(response.headers.get("Vary")).toContain("Accept");
  });

  test("returns the same guide at its Markdown URL and through negotiation", async () => {
    const direct = await site.request(`${origin}/guides/inference.md`);
    const negotiated = await site.request(`${origin}/guides/inference`, {
      headers: { Accept: "text/markdown" },
    });
    expect(await direct.text()).toBe(await negotiated.text());
  });

  test("all indexed guides can be read and are included in the full export", async () => {
    const index = await (await site.request(`${origin}/llms.txt`)).text();
    const full = await (await site.request(`${origin}/llms-full.txt`)).text();
    const links = [
      ...index.matchAll(/\]\((https:\/\/mainroom\.sh\/[^)]+\.md)\)/g),
    ];
    expect(links.length).toBeGreaterThan(4);
    for (const [, url] of links) {
      const response = await site.request(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toStartWith("text/markdown");
      expect(full).toContain((await response.text()).trim());
    }
  });

  test("publishes a discoverable skill with installation and inference verification", async () => {
    const response = await site.request(`${origin}/SKILL.md`);
    const skill = await response.text();
    expect(skill).toStartWith("---\nname: mainroom\ndescription:");
    expect(skill).toContain("mainroom auth signup");
    expect(skill).toContain("mainroom codex sync");
    expect(skill).toContain("/v1/models");
    expect(response.headers.get("Link")).toContain(
      '/llms.txt>; rel="describedby"',
    );
  });

  test("uses canonical public URLs even when a guide is read on a user subdomain", async () => {
    const response = await site.request(
      "https://alice.mainroom.sh/guides/inference",
    );
    const body = await response.text();
    expect(body).toContain(
      'rel="canonical" href="https://mainroom.sh/guides/inference"',
    );
    expect(body).not.toContain("alice.mainroom.sh");
  });

  test("leaves user-subdomain roots and API requests to the existing handlers", async () => {
    for (const url of [
      "https://alice.mainroom.sh/",
      `${origin}/v0/tokenproxy/config/me`,
      `${origin}/v0/machines`,
      `${origin}/v1/models`,
      `${origin}/missing`,
    ]) {
      expect((await site.request(url)).status).toBe(404);
    }
    expect((await site.request(origin, { method: "POST" })).status).toBe(404);
  });

  test("allows public crawling and excludes operational API paths", async () => {
    const robots = await (await site.request(`${origin}/robots.txt`)).text();
    expect(robots).toContain("Allow: /\nDisallow: /v0/\nDisallow: /v1/");
    expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
    const privateRobots = await (
      await site.request("https://alice.mainroom.sh/robots.txt")
    ).text();
    expect(privateRobots).toBe("User-agent: *\nDisallow: /\n");
  });

  test("sitemap links resolve to HTML and contain no operational or private URLs", async () => {
    const response = await site.request(`${origin}/sitemap.xml`);
    const sitemap = await response.text();
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)];
    expect(urls.length).toBeGreaterThan(5);
    for (const [, url] of urls) {
      expect(url).toStartWith(origin);
      expect(url).not.toContain("/v0/");
      expect(url).not.toContain("/v1/");
      const page = await site.request(url);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Type")).toStartWith("text/html");
    }
  });

  test("catalog exposes the actual specification and separate Worker documentation", async () => {
    const response = await site.request(`${origin}/.well-known/api-catalog`);
    const catalog = await response.json();
    expect(response.headers.get("Content-Type")).toStartWith(
      "application/linkset+json",
    );
    expect(catalog.linkset[0]["service-desc"][0].href).toBe(
      `${origin}/openapi.json`,
    );
    expect(catalog.linkset[0]["service-doc"][0].href).toBe(
      `${origin}/guides/api`,
    );
  });

  test("HEAD returns metadata without a document body", async () => {
    const response = await site.request(`${origin}/SKILL.md`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("text/markdown");
    expect(await response.text()).toBe("");
  });
});
