import { Layout } from "./layout";
import { SetupPrompt } from "./setup-prompt";

function Sharing() {
  return (
    <aside
      class="sharing-demo"
      data-shared="true"
      aria-label="Interactive sharing example"
    >
      <div class="routing-example" aria-hidden="true">
        <div class="orbit orbit-one" />
        <div class="orbit orbit-two" />
        <div class="member-card member-alex">
          <div class="card-top">
            <span>mainroom</span>
          </div>
          <div class="card-pattern pattern-alex">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div class="card-bottom">
            <strong>Alex</strong>
          </div>
        </div>
        <div class="member-card member-sam">
          <div class="card-top">
            <span>mainroom</span>
          </div>
          <div class="card-pattern pattern-sam">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div class="card-bottom">
            <strong>Sam</strong>
          </div>
        </div>
        <div class="member-card member-you">
          <div class="card-top">
            <span>mainroom</span>
          </div>
          <div class="room-glyph">
            <i />
            <i />
            <i />
          </div>
          <div class="card-bottom">
            <strong>You.</strong>
            <span>Your accounts</span>
          </div>
        </div>
        <div class="endpoint">
          <span class="endpoint-dot" />
          <code>you.mainroom.sh/v1</code>
          <span>↗</span>
        </div>
      </div>
      <div class="demo-bottom" hidden>
        <div
          class="mode-switch"
          role="group"
          aria-label="Compare account access"
        >
          <span class="mode-indicator" data-shared="true" />
          <button type="button" aria-pressed="false" data-sharing-mode="solo">
            Just you
          </button>
          <button type="button" aria-pressed="true" data-sharing-mode="shared">
            With friends
          </button>
        </div>
      </div>
      <p class="visually-hidden" role="status">
        Your accounts + the nodes your friends share with you.
      </p>
    </aside>
  );
}

export function HomePage() {
  return (
    <Layout
      title="Mainroom | Your AI. Our space."
      path="/"
      markdownPath="/index.md"
      landing
    >
      <main id="main">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-copy">
            <h1 id="hero-title">
              Your AI.
              <br />
              <span>Our space.</span>
            </h1>
            <p class="hero-description">
              Bring your AI subscriptions together with friends. One personal
              endpoint for all of them.
            </p>
            <SetupPrompt />
          </div>
          <Sharing />
        </section>
        <section class="principles" aria-label="How Mainroom works">
          <div class="details-grid">
            <article>
              <h3>Bring what you have.</h3>
              <p>Connect the subscriptions you already pay for.</p>
            </article>
            <article>
              <h3>Make it your circle.</h3>
              <p>Choose who gets access, which models, and how much.</p>
            </article>
            <article>
              <h3>Keep it simple.</h3>
              <p>Use one endpoint with the tools you already use.</p>
            </article>
          </div>
        </section>
      </main>
    </Layout>
  );
}
