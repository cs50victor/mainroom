import { S3Client } from "bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";

import { apiKeySubject, type AppConfig } from "../helpers";
import { errorSchema } from "../schemas/api-keys";
import {
  isJsonUploadName,
  jsonUploadBucket,
  jsonUploadContentType,
  jsonUploadKey,
  jsonUploadMaxBytes,
  jsonUploadMultipartOverheadBytes,
  jsonUploadNameError,
} from "./json-uploads";

const sha256Schema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, "previousSha256 must be a SHA-256 hex digest")
  .transform((value) => value.toLowerCase());

const authJsonRefreshRequestSchema = z.object({
  accountId: z.string().trim().min(1).max(160).optional(),
  machineId: z.string().trim().min(1).max(220).optional(),
  uploadName: z.string().trim().refine(isJsonUploadName, {
    message: jsonUploadNameError,
  }),
  previousSha256: sha256Schema,
  authJson: z.record(z.string(), z.json()),
});

const authJsonRefreshResponseSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  size: z.number().int().min(0),
  previousSha256: z.string(),
  sha256: z.string(),
});

const authJsonRefreshConflictSchema = errorSchema.extend({
  currentSha256: z.string().optional(),
});

export function createTokenproxyRoute(config: AppConfig): Hono {
  const tokenproxy = new Hono();

  tokenproxy.post(
    "/auth-json/refresh",
    bodyLimit({
      maxSize: jsonUploadMaxBytes + jsonUploadMultipartOverheadBytes,
      onError: (c) => c.json({ error: "File must be 1 MiB or smaller" }, 413),
    }),
    openApi({
      tags: ["Tokenproxy"],
      summary: "Persist refreshed tokenproxy auth JSON",
      security: [{ clerkApiKey: [] }],
      request: {
        json: authJsonRefreshRequestSchema,
      },
      responses: {
        200: authJsonRefreshResponseSchema,
        400: errorSchema,
        401: errorSchema,
        409: authJsonRefreshConflictSchema,
        413: errorSchema,
        502: errorSchema,
      },
    }),
    async (c) => {
      const userId = await apiKeySubject(config, c.req.raw);
      if (!userId) return c.var.res(401, { error: "Unauthorized" });

      const body = c.req.valid("json");
      const bucket = jsonUploadBucket();
      if (!bucket) {
        return c.var.res(502, { error: "S3 bucket is not configured" });
      }

      const key = jsonUploadKey(userId, body.uploadName);
      const client = new S3Client();
      let currentText: string;

      try {
        if (!(await client.exists(key))) {
          return c.var.res(409, { error: "S3 auth JSON is missing" });
        }

        currentText = await client.file(key).text();
      } catch {
        return c.var.res(502, { error: "S3 auth JSON read failed" });
      }

      const currentSha256 = Bun.CryptoHasher.hash("sha256", currentText, "hex");
      if (currentSha256 !== body.previousSha256) {
        return c.var.res(409, {
          error: "S3 auth JSON changed since tokenproxy loaded it",
          currentSha256,
        });
      }

      const nextText = JSON.stringify(body.authJson);
      const size = new Blob([nextText]).size;
      if (size > jsonUploadMaxBytes) {
        return c.var.res(413, { error: "File must be 1 MiB or smaller" });
      }

      const sha256 = Bun.CryptoHasher.hash("sha256", nextText, "hex");

      try {
        await client.write(key, nextText, { type: jsonUploadContentType });
      } catch {
        return c.var.res(502, { error: "S3 upload failed" });
      }

      return c.var.res(200, {
        bucket,
        key,
        size,
        previousSha256: body.previousSha256,
        sha256,
      });
    },
  );

  return tokenproxy;
}
