export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
