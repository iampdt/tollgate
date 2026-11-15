import type { ApiError } from "../shared/api";

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Tollgate-Cache, X-Tollgate-Cache-Ttl, X-Tollgate-Similarity-Threshold",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers":
    "X-Tollgate-Request-Id, X-Tollgate-Cache, X-Tollgate-Similarity, X-Tollgate-Provider, X-Tollgate-Model, X-Tollgate-Fallbacks, X-RateLimit-Remaining-Requests, Retry-After",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...headers },
  });
}

/** An error in the shape OpenAI clients already know how to read. */
export function fail(status: number, code: string, message: string, headers: Record<string, string> = {}, extra: object = {}): Response {
  const type = status === 429 ? "rate_limit_error" : status >= 500 ? "upstream_error" : status === 401 ? "authentication_error" : "invalid_request_error";
  const body: ApiError = { error: { message, type, code, ...extra } };
  return json(body, status, headers);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}
