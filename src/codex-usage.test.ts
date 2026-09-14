import { expect, test } from "bun:test";
import { parseCodexUsage } from "./codex-usage";

const observed = "2026-09-14T09:00:00.000Z";
const window = {
  used_percent: 27,
  limit_window_seconds: 18000,
  reset_at: 1800000000,
};
const rate = {
  allowed: true,
  limit_reached: false,
  primary_window: window,
  secondary_window: null,
};

test("normalizes account usage, additional model quotas and provider credit balances", () => {
  const result = parseCodexUsage(
    {
      plan_type: "pro",
      rate_limit: {
        ...rate,
        secondary_window: {
          ...window,
          used_percent: 100,
          limit_window_seconds: 604800,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "Codex Spark",
          metered_feature: "spark",
          rate_limit: rate,
        },
      ],
      credits: { has_credits: true, unlimited: false, balance: "42.50" },
      account_id: "private-account",
      user_id: "private-user",
      other: "private",
    },
    observed,
  );
  expect(
    result.usage.map((row) => [row.window, row.remaining_percent]),
  ).toEqual([
    ["Codex · 5 hours", 73],
    ["Codex · 7 days", 0],
    ["Codex Spark · 5 hours", 73],
  ]);
  expect(result.usage[0]?.reset_at).toBe(new Date(1800000000000).toISOString());
  expect(result.credits).toEqual({
    has_credits: true,
    unlimited: false,
    balance: "42.50",
  });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("unknown credits and missing quota windows are not reported as zero", () => {
  expect(
    parseCodexUsage(
      { plan_type: "pro", rate_limit: null, credits: null },
      observed,
    ),
  ).toEqual({ plan_type: "pro", usage: [] });
  expect(
    parseCodexUsage(
      { plan_type: "pro", credits: { has_credits: true, unlimited: true } },
      observed,
    ).credits,
  ).toEqual({ has_credits: true, unlimited: true });
});

test("clamps percentages and rejects malformed provider snapshots", () => {
  for (const [used, remaining] of [
    [-2, 100],
    [110, 0],
  ]) {
    const parsed = parseCodexUsage(
      {
        plan_type: "pro",
        rate_limit: {
          ...rate,
          primary_window: { ...window, used_percent: used },
        },
      },
      observed,
    );
    expect(parsed.usage[0]?.remaining_percent).toBe(remaining);
  }
  for (const value of [
    null,
    {},
    {
      plan_type: "pro",
      rate_limit: {
        ...rate,
        primary_window: { ...window, reset_at: Infinity },
      },
    },
  ])
    expect(() => parseCodexUsage(value, observed)).toThrow();
});
