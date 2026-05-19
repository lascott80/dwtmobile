const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function getClientKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "local";
}

export function isOverLimit(key: string, limit: number) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

export function isBodyTooLarge(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > maxBytes;
}

export function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
