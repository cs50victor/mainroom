import overview from "../content/overview.md" with { type: "text" };
import gettingStarted from "../content/getting-started.md" with { type: "text" };
import authentication from "../content/authentication.md" with { type: "text" };
import inference from "../content/inference.md" with { type: "text" };
import api from "../content/api.md" with { type: "text" };
import skill from "../content/SKILL.md" with { type: "text" };

export const origin = "https://mainroom.sh";
export const prompt = `Set up Mainroom for me: ${origin}/SKILL.md`;
export const description =
  "Bring your subscriptions together with friends. Share the cost, and access your own accounts and theirs through one endpoint.";
export const pages = [
  { path: "/guides", title: "Mainroom guides", content: overview },
  {
    path: "/guides/getting-started",
    title: "Getting started",
    content: gettingStarted,
  },
  {
    path: "/guides/authentication",
    title: "Authentication",
    content: authentication,
  },
  { path: "/guides/inference", title: "Inference", content: inference },
  { path: "/guides/api", title: "API and sharing", content: api },
];

export { overview, skill };
export type Guide = (typeof pages)[number];
