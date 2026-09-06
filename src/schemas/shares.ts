import { z } from "zod";
import {
  shareRoutes,
  type ShareGrantRecord,
  type ShareLimits,
} from "../shares";

export const shareLimitsSchema: z.ZodType<ShareLimits> = z.object({
  requestsPerDay: z.number().int().positive().optional(),
  tokensPerDay: z.number().int().positive().optional(),
  maxConcurrentRequests: z.number().int().positive().optional(),
});

export const shareGrantSchema = z.object({
  grantId: z.string(),
  providerSubject: z.string(),
  providerUsername: z.string(),
  consumerSubject: z.string(),
  consumerUsername: z.string(),
  status: z.enum(["active", "disabled", "revoked"]),
  models: z.array(z.string()),
  routes: z.array(z.enum(shareRoutes)),
  serviceTiers: z.array(z.string()),
  supportsResponsesWs: z.boolean(),
  supportsCompact: z.boolean(),
  limits: shareLimitsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  revokedAt: z.string().optional(),
}) satisfies z.ZodType<ShareGrantRecord>;

export const shareUsageSchema = z.object({
  day: z.string(),
  requests: z.number(),
  reservedOutputTokens: z.number(),
  inFlight: z.number(),
});

export const outgoingSharesSchema = z.object({
  grants: z.array(shareGrantSchema.extend({ usage: shareUsageSchema })),
});

const consumerShareSchema = z.object({
  provider: z.string(),
  status: shareGrantSchema.shape.status,
  base_url: z.string(),
  models: z.array(z.string()),
  routes: z.array(z.enum(shareRoutes)),
  service_tiers: z.array(z.string()),
  limits: shareLimitsSchema,
  usage: shareUsageSchema,
});

export const incomingSharesSchema = z.object({
  providers: z.array(consumerShareSchema),
  shares: z.array(consumerShareSchema),
});

export const shareUpdatedSchema = z.object({
  grant: shareGrantSchema,
  reconcile: z.object({ error: z.string().optional() }).optional(),
});
