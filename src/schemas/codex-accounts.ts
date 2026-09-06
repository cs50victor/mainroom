import { z } from "zod";

export const codexAccountSchema = z.object({
  uploadName: z.string(),
  accountId: z.string().optional(),
  email: z.string().optional(),
  expiresAt: z.string().optional(),
  models: z.array(z.string()).optional(),
  status: z.enum([
    "ready",
    "reauth_required",
    "disabled",
    "invalid",
    "unavailable",
  ]),
  detail: z.string().optional(),
});

export type CodexAccountStatus = z.infer<typeof codexAccountSchema>;

export const codexAccountsSchema = z.object({
  username: z.string().optional(),
  accounts: z.array(codexAccountSchema),
});

export const codexAccountParamSchema = z.object({
  uploadName: z.string().regex(/^[A-Za-z0-9._@+-]{1,160}\.json$/),
});

export const codexAccountUpdateSchema = z.object({ enabled: z.boolean() });
export const codexAccountUpdatedSchema = codexAccountParamSchema.extend(
  codexAccountUpdateSchema.shape,
);
