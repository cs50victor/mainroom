(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("dashboard-share-form");
  const state = {
    accounts: [],
    grants: [],
    models: [],
    editing: null,
    busy: false,
    session: null,
    version: 0,
    loaded: false,
  };
  const labels = {
    ready: "Ready",
    active: "Active",
    disabled: "Disabled",
    revoked: "Revoked",
    reauth_required: "Sign in again",
    invalid: "Invalid credential",
    unavailable: "Unavailable",
  };
  const number = (value) => Number(value || 0).toLocaleString();
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const detail = (text) => node("p", "dashboard-detail", text);
  const empty = (id, text) =>
    byId(id).replaceChildren(node("p", "dashboard-empty", text));
  const notice = (message = "", error = false) => {
    const element = byId("dashboard-notice");
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle("error", error);
    element.setAttribute("role", error ? "alert" : "status");
  };
  const badge = (status) =>
    node(
      "span",
      `dashboard-badge ${Object.hasOwn(labels, status) ? status : ""}`,
      labels[status] || status,
    );
  const checked = (name) =>
    [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(
      (input) => input.value,
    );
  const setChecks = (name, values) =>
    form.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      input.checked = values.includes(input.value);
    });
  const chips = (values) => {
    const container = node("div", "dashboard-chips");
    for (const value of values)
      container.append(node("span", "dashboard-chip", value));
    return container;
  };
  const button = (label, action, danger = false) => {
    const element = node(
      "button",
      `dashboard-button ${danger ? "danger" : "secondary"}`,
      label,
    );
    element.type = "button";
    element.disabled = state.busy;
    element.addEventListener("click", action);
    return element;
  };
  const setBusy = (busy) => {
    state.busy = busy;
    byId("dashboard-content").setAttribute("aria-busy", String(busy));
    byId("dashboard-content")
      .querySelectorAll("button, input, select, fieldset")
      .forEach((element) => {
        element.disabled = busy;
      });
    byId("share-username").readOnly = Boolean(state.editing);
    byId("share-submit").disabled =
      busy ||
      !state.loaded ||
      !(state.models.length || state.editing?.models.length);
    byId("dashboard-copy").disabled =
      busy || !byId("dashboard-endpoint").dataset.endpoint;
  };
  async function api(path, method = "GET", body) {
    const session = window.Clerk?.session;
    if (!session || session.id !== state.session)
      throw new Error("Your session changed. Sign in again to continue.");
    const token = await session.getToken();
    if (!token)
      throw new Error("Your session expired. Sign in again to continue.");
    if (session.id !== state.session)
      throw new Error("Your session changed. Please retry.");
    const response = await fetch(`/v0/dashboard/${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        result.error || `Request failed (HTTP ${response.status}).`,
      );
    return result;
  }
  function renderModels() {
    const selected = state.editing?.models || [];
    const values = [...new Set([...state.models, ...selected])].sort();
    const container = byId("share-models");
    container.replaceChildren();
    for (const model of values) {
      const label = node("label", "dashboard-check");
      const input = node("input");
      input.type = "checkbox";
      input.name = "model";
      input.value = model;
      input.checked = selected.includes(model);
      label.append(
        input,
        document.createTextNode(
          model +
            (state.models.includes(model) ? "" : " (currently unavailable)"),
        ),
      );
      container.append(label);
    }
    if (!values.length)
      container.append(
        detail("No models are available. Connect or refresh an account first."),
      );
  }
  function renderAccounts() {
    const container = byId("dashboard-accounts");
    container.replaceChildren();
    if (!state.accounts.length)
      return empty(
        "dashboard-accounts",
        "No connected accounts yet. Follow the account guide to connect your first one.",
      );
    for (const account of state.accounts) {
      const card = node("article", "dashboard-card");
      const heading = node("div", "dashboard-card-heading");
      heading.append(
        node("h3", "", account.email || account.uploadName),
        badge(account.status),
      );
      card.append(heading);
      if (account.detail) card.append(detail(account.detail));
      if (account.email) card.append(detail(account.uploadName));
      if (account.models?.length) card.append(chips(account.models));
      if (
        account.status === "reauth_required" ||
        account.status === "invalid"
      ) {
        const help = node(
          "a",
          "dashboard-detail",
          "Reconnect this account using the account guide ↗",
        );
        help.href = "/guides/getting-started#contribute-your-codex-account";
        card.append(help);
      }
      const actions = node("div", "dashboard-actions");
      actions.append(
        button(
          account.status === "disabled" ? "Enable account" : "Disable account",
          () =>
            mutate(
              `accounts/${encodeURIComponent(account.uploadName)}`,
              "PATCH",
              { enabled: account.status === "disabled" },
              "Account updated.",
            ),
        ),
      );
      card.append(actions);
      container.append(card);
    }
  }
  function renderUsage(card, share) {
    const usage = share.usage || {};
    const limits = share.limits || {};
    const line = node("div", "dashboard-usage");
    const remaining = limits.requestsPerDay
      ? Math.max(0, limits.requestsPerDay - (usage.requests || 0))
      : null;
    line.append(
      node("strong", "", remaining === null ? "Unlimited" : number(remaining)),
      node(
        "span",
        "",
        remaining === null
          ? "Mainroom request allowance"
          : "requests left today",
      ),
    );
    card.append(line);
    if (limits.requestsPerDay) {
      const meter = node("progress", "dashboard-meter");
      meter.max = limits.requestsPerDay;
      meter.value = remaining;
      meter.setAttribute("aria-label", "Daily requests remaining");
      card.append(meter);
    }
    card.append(
      detail(
        `${number(usage.requests)} used${limits.requestsPerDay ? ` of ${number(limits.requestsPerDay)}` : ""} · Resets 00:00 UTC${usage.day ? ` · ${usage.day}` : ""}`,
      ),
    );
    if (limits.tokensPerDay || usage.reservedOutputTokens)
      card.append(
        detail(
          `${number(usage.reservedOutputTokens)} output tokens reserved${limits.tokensPerDay ? ` of ${number(limits.tokensPerDay)} per day; ${number(Math.max(0, limits.tokensPerDay - (usage.reservedOutputTokens || 0)))} left` : ""}. Reservations, not actual token consumption.`,
        ),
      );
    if (limits.maxConcurrentRequests || usage.inFlight)
      card.append(
        detail(
          `${number(usage.inFlight)} in flight${limits.maxConcurrentRequests ? ` · ${number(limits.maxConcurrentRequests)} concurrent maximum` : ""}`,
        ),
      );
    if (share.status !== "active")
      card.append(
        detail("Access is inactive. Remaining allowance cannot be used."),
      );
  }
  function renderShares(id, shares, incoming) {
    byId(incoming ? "incoming-count" : "outgoing-count").textContent = String(
      shares.filter((share) => share.status === "active").length,
    );
    const container = byId(id);
    container.replaceChildren();
    if (!shares.length)
      return empty(
        id,
        incoming
          ? "No incoming shares yet. A friend can grant access to your Mainroom username."
          : "Your room has space. Share with a friend to get started.",
      );
    for (const share of shares) {
      const card = node("article", "dashboard-card");
      const heading = node("div", "dashboard-card-heading");
      heading.append(
        node(
          "h3",
          "",
          `@${incoming ? share.provider : share.consumerUsername}`,
        ),
        badge(share.status),
      );
      card.append(heading, chips(share.models || []));
      renderUsage(card, share);
      if (incoming) {
        card.append(detail(share.base_url));
      } else {
        const actions = node("div", "dashboard-actions");
        actions.append(
          button(
            share.status === "revoked" ? "Share again" : "Edit access",
            () => edit(share),
          ),
        );
        if (share.status !== "revoked") {
          actions.append(
            button(share.status === "active" ? "Disable" : "Enable", () =>
              mutate(
                `shares/providers/${encodeURIComponent(share.consumerUsername)}`,
                "PATCH",
                { status: share.status === "active" ? "disabled" : "active" },
                "Sharing updated.",
              ),
            ),
          );
          actions.append(
            button(
              "Revoke",
              () =>
                mutate(
                  `shares/providers/${encodeURIComponent(share.consumerUsername)}`,
                  "DELETE",
                  undefined,
                  `Access revoked for @${share.consumerUsername}.`,
                ),
              true,
            ),
          );
        }
        card.append(actions);
      }
      container.append(card);
    }
  }
  function renderQuota(data) {
    const container = byId("dashboard-quota");
    container.replaceChildren();
    byId("quota-observed").textContent = data.observed_at
      ? `Observed ${new Date(data.observed_at).toLocaleString()}`
      : "";
    if (!data.accounts?.length)
      return empty(
        "dashboard-quota",
        "The current provider usage check is unavailable. Connect an account or refresh to retry.",
      );
    for (const account of data.accounts) {
      const card = node("article", "dashboard-card");
      card.append(node("h3", "", account.display_name || "Connected provider"));
      if (account.health)
        card.append(
          detail(typeof account.health === "string" ? account.health : ""),
        );
      if (account.detail) card.append(detail(account.detail));
      if (!account.usage?.length)
        card.append(detail("Remaining provider quota is unavailable."));
      const credits = account.credits;
      if (credits?.unlimited) {
        card.append(detail("Credits: unlimited"));
      } else if (
        typeof credits?.balance === "string" &&
        credits.balance.trim()
      ) {
        card.append(detail(`Credits: ${credits.balance}`));
      } else if (credits?.has_credits === false) {
        card.append(detail("No provider credits available."));
      } else {
        card.append(detail("Provider credit balance is unavailable."));
      }
      for (const window of account.usage || []) {
        const line = node("div", "dashboard-usage");
        const remaining = window.remaining_percent ?? window.remaining;
        line.append(
          node(
            "strong",
            "",
            remaining == null
              ? "Unavailable"
              : `${number(remaining)}${window.remaining_percent != null ? "%" : ""}`,
          ),
          node(
            "span",
            "",
            `${window.window || "Provider allowance"}${remaining == null ? "" : " left"}`,
          ),
        );
        card.append(line);
        if (window.limit != null && window.remaining != null)
          card.append(
            detail(
              `${number(window.remaining)} remaining of ${number(window.limit)}`,
            ),
          );
        if (window.limited) card.append(detail("Provider limit reached."));
        if (window.reset_at)
          card.append(
            detail(`Resets ${new Date(window.reset_at).toLocaleString()}`),
          );
        else if (window.reset_after != null)
          card.append(
            detail(`Reset after ${window.reset_after} at observation time`),
          );
        if (window.observed_at)
          card.append(
            detail(`Observed ${new Date(window.observed_at).toLocaleString()}`),
          );
      }
      if (account.cooldown_until)
        card.append(
          detail(
            `Cooldown until ${new Date(account.cooldown_until).toLocaleString()}`,
          ),
        );
      container.append(card);
    }
  }
  async function refresh(clearNotice = true) {
    if (!state.session) return;
    const version = ++state.version;
    setBusy(true);
    if (clearNotice) notice();
    const results = await Promise.allSettled([
      api("accounts"),
      api("shares/providers"),
      api("shares/consumers/me"),
      api("models"),
      api("usage"),
    ]);
    if (version !== state.version || !state.session) return;
    const errors = [];
    const [accounts, outgoing, incoming, models, quota] = results;
    state.loaded = outgoing.status === "fulfilled";
    state.accounts =
      accounts.status === "fulfilled" ? accounts.value.accounts : [];
    state.grants = outgoing.status === "fulfilled" ? outgoing.value.grants : [];
    state.models =
      models.status === "fulfilled"
        ? [...new Set((models.value.data || []).map((model) => model.id))]
        : [
            ...new Set(
              state.accounts
                .filter((account) => account.status === "ready")
                .flatMap((account) => account.models || []),
            ),
          ];
    renderModels();
    if (accounts.status === "fulfilled") {
      renderAccounts();
      const username = accounts.value.username;
      byId("dashboard-identity").textContent = username
        ? `Signed in as @${username}`
        : "Choose a Mainroom username in your account settings.";
      const endpoint = username ? `https://${username}.mainroom.sh/v1` : "";
      byId("dashboard-endpoint").textContent =
        endpoint || "Set a username to get your endpoint";
      byId("dashboard-endpoint").dataset.endpoint = endpoint;
    } else {
      empty(
        "dashboard-accounts",
        "Account status could not be loaded. Refresh to retry.",
      );
      byId("dashboard-endpoint").textContent = "Endpoint unavailable";
      delete byId("dashboard-endpoint").dataset.endpoint;
      errors.push(`Accounts: ${accounts.reason.message}`);
    }
    if (outgoing.status === "fulfilled")
      renderShares("dashboard-outgoing", state.grants, false);
    else {
      empty(
        "dashboard-outgoing",
        "Sharing could not be loaded. Refresh to retry.",
      );
      errors.push(`Outgoing shares: ${outgoing.reason.message}`);
    }
    if (incoming.status === "fulfilled")
      renderShares(
        "dashboard-incoming",
        incoming.value.shares || incoming.value.providers,
        true,
      );
    else {
      empty(
        "dashboard-incoming",
        "Incoming shares could not be loaded. Refresh to retry.",
      );
      errors.push(`Incoming shares: ${incoming.reason.message}`);
    }
    if (quota.status === "fulfilled") renderQuota(quota.value);
    else {
      empty(
        "dashboard-quota",
        "Provider quota is unavailable. Refresh to retry.",
      );
      errors.push(`Provider usage: ${quota.reason.message}`);
    }
    if (models.status === "rejected")
      errors.push(
        `Live model inventory: ${models.reason.message}${state.models.length ? " Showing models from ready accounts." : ""}`,
      );
    if (errors.length)
      notice(
        [byId("dashboard-notice").textContent, ...errors]
          .filter(Boolean)
          .join(" "),
        true,
      );
    setBusy(false);
  }
  async function mutate(path, method, body, success) {
    if (state.busy) return;
    const session = state.session;
    setBusy(true);
    notice();
    try {
      const result = await api(path, method, body);
      if (state.session !== session) return;
      notice(
        result.reconcile?.error
          ? `${success} Provider synchronization needs attention: ${result.reconcile.error}`
          : success,
        Boolean(result.reconcile?.error),
      );
      resetForm();
      await refresh(false);
    } catch (error) {
      if (state.session === session) {
        notice(error.message, true);
        setBusy(false);
      }
    }
  }
  function formModes() {
    byId("share-model-fieldset").hidden =
      byId("share-model-mode").value === "all";
    byId("share-custom-limits").hidden =
      byId("share-limit-mode").value === "unlimited";
    byId("share-tiers").hidden = byId("share-tier-mode").value === "all";
  }
  function resetForm() {
    state.editing = null;
    form.reset();
    byId("share-username").readOnly = false;
    byId("share-submit").textContent = "Share capacity";
    byId("share-cancel").hidden = true;
    byId("share-edit-note").hidden = true;
    renderModels();
    formModes();
  }
  function edit(share) {
    if (state.busy) return;
    state.editing = share;
    byId("share-username").value = share.consumerUsername;
    byId("share-username").readOnly = true;
    byId("share-model-mode").value = "selected";
    byId("share-limit-mode").value = Object.keys(share.limits).length
      ? "custom"
      : "unlimited";
    byId("share-limit").value = share.limits.requestsPerDay || "";
    byId("share-tokens").value = share.limits.tokensPerDay || "";
    byId("share-concurrent").value = share.limits.maxConcurrentRequests || "";
    setChecks("route", share.routes);
    byId("share-websocket").checked = share.supportsResponsesWs;
    byId("share-compact").checked = share.supportsCompact;
    byId("share-tier-mode").value = "selected";
    setChecks("tier", share.serviceTiers);
    byId("share-extra-tiers").value = share.serviceTiers
      .filter(
        (tier) =>
          !["auto", "default", "priority", "flex", "fast"].includes(tier),
      )
      .join(", ");
    byId("share-submit").textContent = "Save access";
    byId("share-cancel").hidden = false;
    byId("share-edit-note").hidden = false;
    byId("share-edit-note").textContent =
      "Saving activates this grant. Select All available models to include newly added models.";
    renderModels();
    formModes();
    setBusy(false);
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    byId("share-model-mode").focus({ preventScroll: true });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !state.loaded) return;
    const username = byId("share-username").value.trim().replace(/^@/, "");
    const existing = state.grants.find(
      (grant) => grant.consumerUsername === username,
    );
    if (!state.editing && existing) {
      edit(existing);
      notice(
        `Loaded existing access for @${username}. Review the settings and save your changes.`,
      );
      return;
    }
    const models =
      byId("share-model-mode").value === "all"
        ? state.models
        : checked("model");
    const routes = checked("route");
    const tiers =
      byId("share-tier-mode").value === "all"
        ? ["auto", "default", "priority", "flex", "fast"]
        : [
            ...new Set([
              ...checked("tier"),
              ...byId("share-extra-tiers")
                .value.split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            ]),
          ];
    if (!models.length || !routes.length || !tiers.length) {
      notice("Choose at least one model, endpoint, and service tier.", true);
      return;
    }
    const limits = {};
    if (byId("share-limit-mode").value === "custom") {
      for (const [id, key] of [
        ["share-limit", "requests_per_day"],
        ["share-tokens", "tokens_per_day"],
        ["share-concurrent", "max_concurrent_requests"],
      ]) {
        const value = byId(id).value;
        if (!value) continue;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          notice(
            "Limits must be positive whole numbers, or blank for no limit.",
            true,
          );
          return;
        }
        limits[key] = parsed;
      }
    }
    mutate(
      `shares/providers/${encodeURIComponent(username)}`,
      "PUT",
      {
        models,
        routes,
        service_tiers: tiers,
        supports_responses_ws: byId("share-websocket").checked,
        supports_compact: byId("share-compact").checked,
        limits,
      },
      `Access saved for @${username}.`,
    );
  });
  for (const id of ["share-model-mode", "share-limit-mode", "share-tier-mode"])
    byId(id).addEventListener("change", formModes);
  byId("share-cancel").addEventListener("click", resetForm);
  byId("dashboard-refresh").addEventListener("click", () => {
    if (!state.busy) refresh();
  });
  byId("dashboard-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        byId("dashboard-endpoint").dataset.endpoint,
      );
      notice("Endpoint copied.");
    } catch {
      notice("Copy failed. Select and copy the endpoint above.", true);
    }
  });
  function authChanged({ session }) {
    const next = session?.id || null;
    if (next === state.session && byId("auth-loading").hidden) return;
    state.session = next;
    state.version++;
    state.loaded = false;
    state.accounts = [];
    state.grants = [];
    state.models = [];
    resetForm();
    byId("dashboard-identity").textContent = "";
    byId("quota-observed").textContent = "";
    byId("outgoing-count").textContent = "";
    byId("incoming-count").textContent = "";
    byId("dashboard-endpoint").textContent = "Loading…";
    delete byId("dashboard-endpoint").dataset.endpoint;
    byId("auth-loading").hidden = true;
    byId("dashboard-auth").hidden = Boolean(next);
    byId("dashboard-content").hidden = !next;
    notice();
    if (next) {
      window.Clerk.unmountSignIn(byId("dashboard-sign-in"));
      window.Clerk.mountUserButton(byId("dashboard-user"));
      for (const id of [
        "dashboard-accounts",
        "dashboard-outgoing",
        "dashboard-incoming",
        "dashboard-quota",
      ])
        empty(id, "Loading…");
      refresh();
    } else {
      window.Clerk.unmountUserButton(byId("dashboard-user"));
      for (const id of [
        "dashboard-accounts",
        "dashboard-outgoing",
        "dashboard-incoming",
        "dashboard-quota",
      ])
        byId(id).replaceChildren();
      byId("dashboard-endpoint").textContent = "Loading…";
      delete byId("dashboard-endpoint").dataset.endpoint;
      window.Clerk.mountSignIn(byId("dashboard-sign-in"), {
        routing: "hash",
        forceRedirectUrl: "/dashboard",
        signUpForceRedirectUrl: "/dashboard",
      });
    }
  }
  async function loadScript(src, key) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      if (key) script.dataset.clerkPublishableKey = key;
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Sign-in took too long to load. Refresh this page to retry.",
            ),
          ),
        20000,
      );
      script.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            "Secure sign-in could not load. Refresh this page to retry.",
          ),
        );
      };
      document.head.append(script);
    });
  }
  async function start() {
    try {
      const response = await fetch("/v0/auth/web/config", {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const config = await response.json();
      if (!response.ok)
        throw new Error(config.error || "Website sign-in is unavailable.");
      const key = config.publishableKey;
      if (typeof key !== "string" || !/^pk_(test|live)_/.test(key))
        throw new Error("Website sign-in is not configured.");
      const domain = atob(key.split("_")[2]).replace(/\$$/, "");
      if (!/^[a-zA-Z0-9.-]+$/.test(domain))
        throw new Error("Invalid sign-in configuration.");
      await Promise.all([
        loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`),
        loadScript(
          `https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
          key,
        ),
      ]);
      await window.Clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
      });
      window.Clerk.addListener(authChanged);
    } catch (error) {
      byId("auth-loading").hidden = true;
      notice(
        error.message || "Unable to load the dashboard. Refresh to retry.",
        true,
      );
    }
  }
  formModes();
  start();
})();
