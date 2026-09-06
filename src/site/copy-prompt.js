const button = document.getElementById("copy-prompt");
button.addEventListener("click", async () => {
  const status = document.getElementById("copy-status");
  try {
    await navigator.clipboard.writeText(button.dataset.prompt);
    status.textContent = "Copied. Paste it into your coding agent.";
    button.setAttribute("aria-label", "Copy setup prompt again");
  } catch {
    status.textContent =
      "Select the prompt text and copy it into your coding agent.";
  }
});
