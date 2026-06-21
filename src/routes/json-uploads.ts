export const jsonUploadMaxBytes = 1024 * 1024;
export const jsonUploadMultipartOverheadBytes = 16 * 1024;
export const jsonUploadNameHeader = "x-mainroom-upload-name";
export const jsonUploadContentType = "application/json; charset=utf-8";
export const jsonUploadNameError =
  "X-Mainroom-Upload-Name must be a JSON filename without path separators";

export function jsonUploadBucket(): string | undefined {
  return Bun.env.S3_BUCKET ?? Bun.env.AWS_BUCKET;
}

export function jsonUploadKey(userId: string, uploadName: string): string {
  return `uploads/json/${encodeURIComponent(userId)}/${uploadName}`;
}

export function isJsonUploadName(value: string): boolean {
  return /^[A-Za-z0-9._@+-]{1,160}\.json$/.test(value);
}
