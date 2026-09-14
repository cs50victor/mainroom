import { z } from "zod";

const windowSchema = z.object({
  used_percent: z.number().finite(),
  limit_window_seconds: z.number().int().positive(),
  reset_at: z.number().int().nonnegative().max(8640000000000),
});
const limitSchema = z.object({
  allowed: z.boolean(),
  limit_reached: z.boolean(),
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish(),
});
const usageSchema = z.object({
  plan_type: z.string(),
  rate_limit: limitSchema.nullish(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullish(),
    })
    .nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string(),
        rate_limit: limitSchema,
      }),
    )
    .nullish(),
});

function duration(seconds: number): string {
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

export function parseCodexUsage(value: unknown, observedAt: string) {
  const data = usageSchema.parse(value);
  const limits = [
    { limit_name: "Codex", rate_limit: data.rate_limit },
    ...(data.additional_rate_limits ?? []),
  ];
  const usage = limits.flatMap(({ limit_name, rate_limit }) => {
    if (!rate_limit) return [];
    return [rate_limit.primary_window, rate_limit.secondary_window].flatMap(
      (window) => {
        if (!window) return [];
        return [
          {
            window: `${limit_name} · ${duration(window.limit_window_seconds)}`,
            remaining_percent: Math.max(
              0,
              Math.min(100, 100 - window.used_percent),
            ),
            reset_at: new Date(window.reset_at * 1000).toISOString(),
            observed_at: observedAt,
            limited: rate_limit.limit_reached || !rate_limit.allowed,
          },
        ];
      },
    );
  });
  return {
    plan_type: data.plan_type,
    usage,
    ...(data.credits ? { credits: data.credits } : {}),
  };
}
