import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { mainroomVersion } from "../version";
import { description, origin } from "./content";

type LayoutProps = {
  title: string;
  path: string;
  markdownPath: string;
  children: Child;
  landing?: boolean;
};

function Brand() {
  return (
    <>
      <span class="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      mainroom
    </>
  );
}

function Header({ landing }: { landing: boolean }) {
  if (landing)
    return (
      <header class="site-header flex items-center justify-between">
        <a class="wordmark" href="/" aria-label="Mainroom home">
          <Brand />
        </a>
        <nav aria-label="Main navigation">
          <a href="/guides">Guides</a>
          <a href="/docs">API docs</a>
          <a href="https://github.com/cs50victor/mainroom">
            GitHub{" "}
            <span class="arrow" aria-hidden="true">
              ↗
            </span>
          </a>
        </nav>
      </header>
    );
  return (
    <header class="flex items-center justify-between gap-6 px-5 py-[22px] sm:px-11 sm:py-7">
      <a
        class="inline-flex items-center gap-2.5 text-[17px] font-[650] tracking-[-0.7px] no-underline sm:text-xl"
        href="/"
        aria-label="Mainroom home"
      >
        <span
          class="grid size-[23px] place-items-center rounded-[7px] bg-[#30332e] pb-1 font-[Georgia,serif] text-[22px] leading-none font-bold text-canvas sm:size-[27px]"
          aria-hidden="true"
        >
          m
        </span>
        mainroom
      </a>
      <nav
        class="flex gap-4 text-xs text-[#64675f] sm:gap-7 sm:text-[13px] [&_a:hover]:text-[#171a14] [&_a:hover]:underline"
        aria-label="Main navigation"
      >
        <a href="/guides">Guides</a>
        <a href="/docs">API docs</a>
        <a href="https://github.com/cs50victor/mainroom">
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}

function Footer({ landing }: { landing: boolean }) {
  if (landing)
    return (
      <footer class="site-footer">
        <a class="wordmark" href="/" aria-label="Mainroom home">
          <Brand />
        </a>
        <a class="footer-link" href="/SKILL.md">
          Read the setup skill{" "}
          <span class="arrow" aria-hidden="true">
            ↗
          </span>
        </a>
      </footer>
    );
  return (
    <footer class="flex items-center justify-between gap-6 px-5 py-[22px] text-[11px] text-[#808675] sm:px-11 sm:py-6 sm:text-xs [&_a:hover]:text-[#171a14] [&_a:hover]:underline">
      <span>
        mainroom{" "}
        <span class="ml-2 font-mono text-[11px] text-[#969c8c]">
          v{mainroomVersion}
        </span>
      </span>
      <a href="/SKILL.md">
        Read the setup skill <span aria-hidden="true">↗</span>
      </a>
    </footer>
  );
}

export function Layout({
  title,
  path,
  markdownPath,
  children,
  landing = false,
}: LayoutProps) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Mainroom",
    url: origin,
    description,
    inLanguage: "en",
  };

  return (
    <>
      {raw("<!doctype html>")}
      <html
        lang="en"
        class={
          landing
            ? "landing scheme-light"
            : "scheme-light bg-canvas font-sans text-ink antialiased [font-synthesis:none]"
        }
      >
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <meta property="og:title" content={title} />
          <meta property="og:description" content={description} />
          <meta property="og:type" content="website" />
          <meta property="og:url" content={`${origin}${path}`} />
          <meta name="twitter:card" content="summary" />
          <link
            rel="icon"
            href={
              landing
                ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath fill='%23242421' d='M3 9l7-3v23l-7 3zm10-6l7-3v28l-7 3zm10 3l7-3v23l-7 3z'/%3E%3C/svg%3E"
                : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2330332e'/%3E%3Ctext x='5' y='24' font-family='Georgia' font-size='28' font-weight='bold' fill='%23fafaf8'%3Em%3C/text%3E%3C/svg%3E"
            }
          />
          <link rel="canonical" href={`${origin}${path}`} />
          <link
            rel="alternate"
            type="text/markdown"
            href={`${origin}${markdownPath}`}
          />
          <link
            rel="describedby"
            type="text/markdown"
            href={`${origin}/llms.txt`}
          />
          <link rel="api-catalog" href={`${origin}/.well-known/api-catalog`} />
          <link rel="stylesheet" href="/site.css" />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
          />
          {landing && <script src="/site.js" defer />}
        </head>
        <body
          class={
            landing
              ? "site"
              : "flex min-h-svh flex-col leading-normal [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-[5px] [&_a:focus-visible]:outline-[#50594a] [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-[5px] [&_button:focus-visible]:outline-[#50594a]"
          }
        >
          <a
            class={
              landing
                ? "skip-link"
                : "absolute -top-[60px] left-6 z-10 bg-white p-3 focus:top-3"
            }
            href="#main"
          >
            Skip to content
          </a>
          <Header landing={landing} />
          {children}
          <Footer landing={landing} />
        </body>
      </html>
    </>
  );
}
