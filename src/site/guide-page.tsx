import { marked } from "marked";
import { pages, type Guide } from "./content";
import { Layout } from "./layout";

export function GuidePage({ page }: { page: Guide }) {
  // Markdown comes only from repository-owned guides, never request data.
  const rendered = marked.parse(page.content, { async: false });

  return (
    <Layout
      title={`${page.title} | Mainroom`}
      path={page.path}
      markdownPath={`${page.path}.md`}
    >
      <main
        id="main"
        class="mx-auto mt-5 mb-[100px] w-full max-w-[1120px] flex-1 px-5 sm:mt-12 sm:grid sm:grid-cols-[185px_minmax(0,1fr)] sm:gap-14 sm:px-8"
      >
        <nav
          class="mb-10 flex flex-wrap gap-x-5 gap-y-3 pt-2.5 text-sm sm:mb-0 sm:flex-col sm:flex-nowrap sm:gap-4"
          aria-label="Guides"
        >
          {pages.map((entry) => (
            <a
              key={entry.path}
              href={entry.path}
              aria-current={entry.path === page.path ? "page" : undefined}
              class="text-[#707565] aria-[current=page]:font-[650] aria-[current=page]:text-[#262d1d] hover:underline"
            >
              {entry.title}
            </a>
          ))}
        </nav>
        <article class="min-w-0 max-w-[790px]">
          <a
            class="font-mono text-xs text-[#717964] underline"
            href={`${page.path}.md`}
          >
            Read as Markdown
          </a>
          <div
            class="prose max-w-none wrap-anywhere prose-headings:font-medium prose-headings:text-ink prose-h1:text-[33px] prose-h1:tracking-[-1.5px] prose-h2:text-[23px] prose-p:text-[#515747] prose-a:text-accent prose-code:font-mono prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-[10px] prose-pre:border prose-pre:border-[#e0e4d8] prose-pre:bg-surface prose-pre:p-5 prose-pre:text-ink prose-table:block prose-table:overflow-x-auto prose-table:text-[13px] prose-td:p-3 prose-th:p-3 sm:prose-h1:text-[40px]"
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        </article>
      </main>
    </Layout>
  );
}
