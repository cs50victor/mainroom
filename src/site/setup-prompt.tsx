import { prompt } from "./content";

function Arrow() {
  return (
    <span class="arrow" aria-hidden="true">
      ↗
    </span>
  );
}

export function SetupPrompt() {
  return (
    <div class="setup" id="get-started">
      <div class="setup-card" data-state="idle">
        <div class="setup-prompt-row">
          <code id="setup-prompt">
            Set up Mainroom for me: <a href="/SKILL.md">mainroom.sh/SKILL.md</a>
          </code>
          <button
            id="copy-prompt"
            type="button"
            class="copy-button"
            data-prompt={prompt}
            aria-label="Copy prompt"
            title="Copy prompt"
            hidden
          >
            <span class="copy-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="setup-caption">
        <p id="copy-status" role="status">
          Paste into your coding agent.
        </p>
        <a href="/guides/getting-started">
          Set up manually <Arrow />
        </a>
      </div>
    </div>
  );
}
