import { prompt } from "./content";

export function SetupPrompt() {
  return (
    <div class="text-left">
      <div class="ml-px inline-flex items-center gap-2.5 rounded-tl-2xl rounded-tr-[20px] border border-b-0 border-[#d9dcd3] bg-soft pt-3 pr-[22px] pb-[13px] pl-4 text-xs font-medium text-[#777c6e] sm:text-sm">
        <span
          class="grid size-[23px] place-items-center rounded-full bg-[#e0e5d8] font-mono text-xs text-[#626c55]"
          aria-hidden="true"
        >
          &gt;_
        </span>
        Set up with your agent
      </div>
      <div class="flex items-center gap-2.5 rounded-2xl rounded-tl-none border border-line bg-white px-3 py-4 shadow-[0_2px_3px_#242a1410,0_10px_24px_#242a1405] sm:gap-4 sm:px-[22px] sm:py-[23px]">
        <span class="text-3xl leading-none text-[#92998a]" aria-hidden="true">
          ›
        </span>
        <code
          id="setup-prompt"
          class="flex-1 font-mono text-[clamp(13px,1.8vw,20px)] leading-[1.6] wrap-anywhere"
        >
          Set up Mainroom for me:{" "}
          <a class="hover:underline" href="/SKILL.md">
            mainroom.sh/SKILL.md
          </a>
        </code>
        <button
          id="copy-prompt"
          type="button"
          aria-label="Copy setup prompt"
          data-prompt={prompt}
          class="grid min-h-11 basis-10 shrink-0 grow-0 cursor-pointer place-items-center rounded-lg p-2 text-[#7c8372] hover:bg-[#f2f4ed] hover:text-[#30372a]"
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
            <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
          </svg>
        </button>
      </div>
      <p
        id="copy-status"
        class="mt-4 min-h-5 text-center text-xs text-[#818776]"
        role="status"
        aria-live="polite"
      >
        Paste this into your coding agent to get started.
      </p>
    </div>
  );
}
