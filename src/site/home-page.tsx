import { Layout } from "./layout";
import { SetupPrompt } from "./setup-prompt";

export function HomePage() {
  return (
    <Layout
      title="Mainroom | Your AI subscriptions. Better together."
      path="/"
      markdownPath="/index.md"
      landing
    >
      <main
        id="main"
        class="grid flex-1 place-items-center bg-[radial-gradient(#daddd4_0.65px,transparent_0.65px)] bg-size-[24px_24px] px-5 pt-[55px] pb-[65px] sm:px-6 sm:pt-16 sm:pb-[100px]"
      >
        <div class="w-full max-w-[860px] text-center">
          <p class="mb-[22px] font-mono text-[11px] tracking-[2.5px] text-[#757a6d]">
            AI WITH FRIENDS
          </p>
          <h1 class="text-[clamp(40px,5.5vw,68px)] leading-[1.08] font-medium tracking-[-1.8px] sm:tracking-[-3px]">
            Your AI subscriptions.
            <br />
            Better together.
          </h1>
          <p class="mx-auto mt-[22px] mb-[42px] max-w-[260px] text-sm leading-[1.6] text-muted sm:mt-6 sm:mb-[54px] sm:max-w-none sm:text-base">
            Bring your subscriptions together with friends.
            <br />
            Share the cost, and access your own accounts and theirs through one
            endpoint.
          </p>
          <SetupPrompt />
          <a
            class="mt-[34px] inline-block text-[13px] text-accent hover:underline"
            href="/guides/getting-started"
          >
            Or set up manually <span aria-hidden="true">↗</span>
          </a>
        </div>
      </main>
    </Layout>
  );
}
