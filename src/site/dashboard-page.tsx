import { Layout } from "./layout";

export function DashboardPage() {
  return (
    <Layout title="Your dashboard | Mainroom" path="/dashboard" dashboard>
      <main id="main" class="dashboard">
        <div class="dashboard-heading">
          <div>
            <p class="dashboard-eyebrow">YOUR MAINROOM</p>
            <h1>A little room to share.</h1>
            <p class="dashboard-intro">
              Your accounts, your friends, and the capacity you share.
            </p>
          </div>
          <div id="dashboard-user" aria-label="Your account" />
        </div>
        <div
          id="dashboard-notice"
          class="dashboard-notice"
          role="status"
          hidden
        />
        <section
          id="dashboard-auth"
          class="dashboard-panel dashboard-auth"
          aria-label="Sign in"
        >
          <h2>Welcome back.</h2>
          <p>Sign in to check your accounts and share with a friend.</p>
          <p id="auth-loading" role="status">
            Loading secure sign-in…
          </p>
          <div id="dashboard-sign-in" />
          <noscript>
            Enable JavaScript to sign in and manage your Mainroom.
          </noscript>
        </section>
        <div id="dashboard-content" hidden>
          <div class="dashboard-toolbar">
            <p id="dashboard-identity" />
            <button
              id="dashboard-refresh"
              type="button"
              class="dashboard-button secondary"
            >
              Refresh status
            </button>
          </div>
          <section
            class="dashboard-panel endpoint-panel"
            aria-label="Your inference endpoint"
          >
            <div>
              <p class="dashboard-eyebrow">YOUR ENDPOINT</p>
              <code id="dashboard-endpoint">Loading…</code>
            </div>
            <button
              id="dashboard-copy"
              type="button"
              class="dashboard-button secondary"
              disabled
            >
              Copy endpoint
            </button>
          </section>
          <section class="dashboard-section" aria-labelledby="accounts-heading">
            <div class="dashboard-section-heading">
              <h2 id="accounts-heading">Connected accounts</h2>
              <a href="/guides/getting-started#contribute-your-codex-account">
                Connect an account ↗
              </a>
            </div>
            <p class="dashboard-caption">
              Live connection status for the accounts backing your endpoint.
            </p>
            <div
              id="dashboard-accounts"
              class="dashboard-card-grid"
              aria-live="polite"
            />
          </section>
          <section class="dashboard-section" aria-labelledby="quota-heading">
            <div class="dashboard-section-heading">
              <h2 id="quota-heading">Provider usage left</h2>
              <span id="quota-observed" class="dashboard-help" />
            </div>
            <p class="dashboard-caption">
              Latest limits reported by your providers. Missing limits are
              unavailable, not unlimited.
            </p>
            <div
              id="dashboard-quota"
              class="dashboard-card-grid"
              aria-live="polite"
            />
          </section>
          <div class="dashboard-columns">
            <section
              class="dashboard-panel share-editor"
              aria-labelledby="share-heading"
            >
              <p class="dashboard-eyebrow">MAKE ROOM FOR A FRIEND</p>
              <h2 id="share-heading">Share your capacity</h2>
              <p class="dashboard-caption">
                Choose what they can use. You can change or revoke access
                anytime.
              </p>
              <form id="dashboard-share-form">
                <label for="share-username">Friend's username</label>
                <input
                  id="share-username"
                  name="username"
                  placeholder="e.g. beehuman"
                  required
                  maxLength={64}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellcheck={false}
                />
                <label for="share-model-mode">Model access</label>
                <select id="share-model-mode">
                  <option value="all">All available models</option>
                  <option value="selected">Choose models</option>
                </select>
                <p class="dashboard-help">
                  Includes models available now. Edit access later to add newly
                  available models.
                </p>
                <fieldset id="share-model-fieldset" hidden>
                  <legend>Models to share</legend>
                  <div id="share-models" class="dashboard-model-options" />
                </fieldset>
                <label for="share-limit-mode">Sharing allowance</label>
                <select id="share-limit-mode">
                  <option value="unlimited">Unlimited</option>
                  <option value="custom">Set limits</option>
                </select>
                <p class="dashboard-help">
                  Unlimited sharing has no Mainroom cap. Your provider's
                  subscription limits still apply.
                </p>
                <div id="share-custom-limits" hidden>
                  <label for="share-limit">Requests per day</label>
                  <input
                    id="share-limit"
                    name="limit"
                    type="number"
                    min="1"
                    max="9007199254740991"
                    step="1"
                    placeholder="No limit"
                  />
                  <label for="share-tokens">
                    Reserved output tokens per day
                  </label>
                  <input
                    id="share-tokens"
                    type="number"
                    min="1"
                    max="9007199254740991"
                    step="1"
                    placeholder="No limit"
                  />
                  <p class="dashboard-help">
                    Counts requested output reservations, not actual tokens
                    consumed. Daily limits reset at 00:00 UTC.
                  </p>
                  <label for="share-concurrent">Concurrent requests</label>
                  <input
                    id="share-concurrent"
                    type="number"
                    min="1"
                    max="9007199254740991"
                    step="1"
                    placeholder="No limit"
                  />
                </div>
                <details class="dashboard-advanced">
                  <summary>Advanced access</summary>
                  <fieldset>
                    <legend>Endpoints</legend>
                    <label class="dashboard-check">
                      <input
                        type="checkbox"
                        name="route"
                        value="responses"
                        checked
                      />
                      Responses
                    </label>
                    <label class="dashboard-check">
                      <input
                        type="checkbox"
                        name="route"
                        value="chat_completions"
                        checked
                      />
                      Chat completions
                    </label>
                    <label class="dashboard-check">
                      <input
                        type="checkbox"
                        name="route"
                        value="messages"
                        checked
                      />
                      Messages
                    </label>
                  </fieldset>
                  <label class="dashboard-check">
                    <input id="share-websocket" type="checkbox" checked />
                    Responses WebSocket
                  </label>
                  <label class="dashboard-check">
                    <input id="share-compact" type="checkbox" checked />
                    Compact requests
                  </label>
                  <label for="share-tier-mode">Service tiers</label>
                  <select id="share-tier-mode">
                    <option value="all">All supported tiers</option>
                    <option value="selected">Choose tiers</option>
                  </select>
                  <fieldset id="share-tiers" hidden>
                    <legend>Allowed service tiers</legend>
                    {["auto", "default", "flex", "priority", "fast"].map(
                      (tier) => (
                        <label class="dashboard-check">
                          <input
                            type="checkbox"
                            name="tier"
                            value={tier}
                            checked
                          />
                          {tier}
                        </label>
                      ),
                    )}
                  </fieldset>
                  <label for="share-extra-tiers">
                    Additional tiers (comma separated)
                  </label>
                  <input
                    id="share-extra-tiers"
                    placeholder="Optional provider tiers"
                  />
                  <p class="dashboard-help">
                    Access applies only to capabilities your connected providers
                    support.
                  </p>
                </details>
                <p id="share-edit-note" class="dashboard-help" hidden />
                <div class="dashboard-actions">
                  <button
                    id="share-submit"
                    type="submit"
                    class="dashboard-button"
                  >
                    Share capacity
                  </button>
                  <button
                    id="share-cancel"
                    type="button"
                    class="dashboard-button secondary"
                    hidden
                  >
                    Cancel edit
                  </button>
                </div>
              </form>
            </section>
            <div class="dashboard-sharing">
              <section
                class="dashboard-section"
                aria-labelledby="outgoing-heading"
              >
                <div class="dashboard-section-heading">
                  <h2 id="outgoing-heading">Shared with friends</h2>
                  <span id="outgoing-count" class="dashboard-count" />
                </div>
                <p class="dashboard-caption">
                  Usage against each friend's daily sharing allowance.
                </p>
                <div
                  id="dashboard-outgoing"
                  class="dashboard-stack"
                  aria-live="polite"
                />
              </section>
              <section
                class="dashboard-section"
                aria-labelledby="incoming-heading"
              >
                <div class="dashboard-section-heading">
                  <h2 id="incoming-heading">Shared with you</h2>
                  <span id="incoming-count" class="dashboard-count" />
                </div>
                <div
                  id="dashboard-incoming"
                  class="dashboard-stack"
                  aria-live="polite"
                />
              </section>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
