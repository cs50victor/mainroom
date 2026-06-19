import { S3Client } from "bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { HonoRequest } from "hono";

import { errorSchema } from "../schemas/api-keys";

const maxJsonFileBytes = 1024 * 1024;
const maxMultipartOverheadBytes = 16 * 1024;

const uploadSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  size: z.number().int().min(0),
});

export function createUploadsRoute(): Hono {
  const uploads = new Hono();

  uploads.post(
    "/json",
    bodyLimit({
      maxSize: maxJsonFileBytes + maxMultipartOverheadBytes,
      onError: (c) =>
        c.var.res(413, { error: "File must be 1 MiB or smaller" }),
    }),
    openApi({
      tags: ["Uploads"],
      summary: "Upload a JSON file",
      security: [{ clerkApiKey: [] }],
      responses: {
        200: uploadSchema,
        400: errorSchema,
        413: errorSchema,
        415: errorSchema,
        502: errorSchema,
      },
    }),
    async (c) => {
      const upload = await readJsonUpload(c.req);
      if ("error" in upload) {
        return c.var.res(upload.status, { error: upload.error });
      }

      const bucket = Bun.env.S3_BUCKET ?? Bun.env.AWS_BUCKET;
      if (!bucket) {
        return c.var.res(502, { error: "S3 bucket is not configured" });
      }

      const key = `uploads/json/${crypto.randomUUID()}.json`;

      try {
        await new S3Client().write(key, upload.text, {
          type: "application/json; charset=utf-8",
        });
      } catch {
        return c.var.res(502, { error: "S3 upload failed" });
      }

      return c.var.res(200, {
        bucket,
        key,
        size: upload.size,
      });
    },
  );

  return uploads;
}

async function readJsonUpload(
  request: HonoRequest,
): Promise<
  { size: number; text: string } | { error: string; status: 400 | 413 | 415 }
> {
  const contentType = request.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const body = await request.parseBody();
    const file = body.file;

    if (!isUploadedFile(file)) {
      return {
        error: "Multipart upload must include a file field",
        status: 400,
      };
    }

    if (file.size > maxJsonFileBytes) {
      return { error: "File must be 1 MiB or smaller", status: 413 };
    }

    return readJsonBytes(await file.arrayBuffer());
  }

  if (isJsonContentType(contentType)) {
    return readJsonBytes(await request.arrayBuffer());
  }

  return {
    error: "Content-Type must be application/json or multipart/form-data",
    status: 415,
  };
}

function readJsonBytes(
  bytes: ArrayBuffer,
): { size: number; text: string } | { error: string; status: 400 | 413 } {
  if (bytes.byteLength > maxJsonFileBytes) {
    return { error: "File must be 1 MiB or smaller", status: 413 };
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "File must be valid UTF-8 JSON", status: 400 };
  }

  try {
    JSON.parse(text);
  } catch {
    return { error: "File must contain valid JSON", status: 400 };
  }

  return { size: bytes.byteLength, text };
}

function isUploadedFile(value: unknown): value is File {
  const file = value as { arrayBuffer?: unknown; size?: unknown };

  return (
    typeof value === "object" &&
    value !== null &&
    typeof file.size === "number" &&
    typeof file.arrayBuffer === "function"
  );
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
}
