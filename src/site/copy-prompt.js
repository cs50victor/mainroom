const button = document.getElementById("copy-prompt");
const status = document.getElementById("copy-status");
const card = document.querySelector(".setup-card");
const icon = button?.querySelector(".copy-icon");

if (button && status && card && icon) {
  button.addEventListener("click", async () => {
    if (card.dataset.state === "copying") return;
    card.dataset.state = "copying";
    button.setAttribute("aria-disabled", "true");
    status.textContent = "Copying your setup prompt…";
    try {
      await navigator.clipboard.writeText(button.dataset.prompt);
      card.dataset.state = "copied";
      icon.classList.add("copied");
      status.textContent = "Copied. Paste it into your coding agent.";
      button.setAttribute("aria-label", "Copied. Copy prompt again");
      button.title = "Copied";
    } catch {
      card.dataset.state = "failed";
      icon.classList.remove("copied");
      status.textContent = "Select the prompt above and copy it manually.";
      button.setAttribute("aria-label", "Copy prompt");
      button.title = "Copy prompt";
    } finally {
      button.setAttribute("aria-disabled", "false");
    }
  });
  button.hidden = false;
}

const demo = document.querySelector(".sharing-demo");
const controls = demo?.querySelector(".demo-bottom");
const indicator = demo?.querySelector(".mode-indicator");
const announcement = demo?.querySelector('[role="status"]');
const modes = demo?.querySelectorAll("[data-sharing-mode]");

if (demo && controls && indicator && announcement && modes?.length === 2) {
  for (const mode of modes) {
    mode.addEventListener("click", () => {
      const shared = mode.dataset.sharingMode === "shared";
      demo.dataset.shared = String(shared);
      indicator.dataset.shared = String(shared);
      for (const option of modes) {
        option.setAttribute("aria-pressed", String(option === mode));
      }
      announcement.textContent = shared
        ? "Your accounts + the nodes your friends share with you."
        : "Your accounts, through your personal endpoint.";
    });
  }
  controls.hidden = false;
}
