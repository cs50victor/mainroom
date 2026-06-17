import { z } from "zod";

const claimsSchema = z.record(z.string(), z.unknown());

export const errorSchema = z.object({
  error: z.string(),
});

export const apiKeySchema = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  claims: claimsSchema.nullable(),
  scopes: z.array(z.string()),
  secret: z.string().optional(),
  revoked: z.boolean(),
  revocationReason: z.string().nullable(),
  expired: z.boolean(),
  expiration: z.number().nullable(),
  createdBy: z.string().nullable(),
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const apiKeyListSchema = z.object({
  data: z.array(apiKeySchema),
  totalCount: z.number(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(3),
  description: z.string().max(255).nullable().optional(),
  subject: z.string().min(1),
  claims: claimsSchema.nullable().optional(),
  scopes: z.array(z.string()).optional(),
  createdBy: z.string().nullable().optional(),
  secondsUntilExpiration: z.number().positive().nullable().optional(),
});

export const updateApiKeySchema = z.object({
  claims: claimsSchema.nullable().optional(),
  scopes: z.array(z.string()).optional(),
  description: z.string().max(255).nullable().optional(),
  subject: z.string().min(1),
  secondsUntilExpiration: z.number().positive().nullable().optional(),
});

const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const listApiKeysQuerySchema = z.object({
  subject: z.string().min(1),
  includeInvalid: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const apiKeyIdParamSchema = z.object({
  id: z.string().min(1),
});

export const revokeApiKeySchema = z.object({
  revocationReason: z.string().nullable().optional(),
});

export const verifyApiKeySchema = z.object({
  secret: z.string().min(1),
});

export const apiKeySecretSchema = z.object({
  secret: z.string(),
});

export const deletedApiKeySchema = z.object({
  id: z.string(),
  object: z.string(),
  deleted: z.literal(true),
});

export type CreateApiKeyParams = z.infer<typeof createApiKeySchema>;
export type ListApiKeysParams = z.infer<typeof listApiKeysQuerySchema>;
export type UpdateApiKeyParams = z.infer<typeof updateApiKeySchema>;
export type RevokeApiKeyParams = z.infer<typeof revokeApiKeySchema>;
export type VerifyApiKeyParams = z.infer<typeof verifyApiKeySchema>;
