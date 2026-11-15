// API keys. A key is random, shown once, and stored only as its SHA-256.

import { type CacheMode, DEMO_KEY } from "../shared/api";
import type { AppEnv } from "./env";
import type { Limits } from "./gate";
import { bearer, sha256Hex } from "./http";

export interface Key extends Limits {
  id: string;
  name: string;
  cacheMode: CacheMode;
  demo: boolean;
}

/** One visitor of the public demo. */
export const DEMO_VISITOR: Limits = { requestsPerMinute: 20, tokensPerDay: 20_000 };
/** Every visitor of the public demo together. Sized to stay inside Workers AI's free daily allocation. */
export const DEMO_TOTAL: Limits = { requestsPerMinute: 240, tokensPerDay: 150_000 };
export const DEMO_MAX_TOKENS = 300;
export const DEMO_MAX_PROMPT_CHARS = 4000;

const DEMO: Key = { id: "demo", name: "Public demo", cacheMode: "exact", demo: true, ...DEMO_VISITOR };

interface Row {
  id: string;
  name: string;
  requests_per_minute: number;
  tokens_per_day: number;
  cache_mode: CacheMode;
}

// Looked-up keys are remembered for a short while per isolate, so most requests skip the
// database. The price: a revoked key can keep working for up to this long.
const REMEMBER_MS = 30_000;
const remembered = new Map<string, { key: Key | null; at: number }>();

export async function authenticate(env: AppEnv, request: Request): Promise<Key | null> {
  const token = bearer(request);
  if (!token) return null;
  if (token === DEMO_KEY) return DEMO;
  const hash = await sha256Hex(token);
  const known = remembered.get(hash);
  if (known && Date.now() - known.at < REMEMBER_MS) return known.key;

  const row = await env.DB.prepare(
    "SELECT id, name, requests_per_minute, tokens_per_day, cache_mode FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<Row>();
  const key: Key | null = row
    ? { id: row.id, name: row.name, requestsPerMinute: row.requests_per_minute, tokensPerDay: row.tokens_per_day, cacheMode: row.cache_mode, demo: false }
    : null;
  if (remembered.size > 500) remembered.clear();
  remembered.set(hash, { key, at: Date.now() });
  return key;
}

export function forget(): void {
  remembered.clear();
}

export async function isAdmin(env: AppEnv, request: Request): Promise<boolean> {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN || !token) return false;
  // Comparing hashes takes the same time whatever the guess shares with the real token.
  const [a, b] = await Promise.all([sha256Hex(token), sha256Hex(env.ADMIN_TOKEN)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  return `tg_live_${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

export interface NewKey {
  name: string;
  requestsPerMinute: number;
  tokensPerDay: number;
  cacheMode: CacheMode;
}

export async function createKey(env: AppEnv, input: NewKey): Promise<{ id: string; key: string }> {
  const key = newKey();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, key_prefix, requests_per_minute, tokens_per_day, cache_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, input.name, await sha256Hex(key), key.slice(0, 12), input.requestsPerMinute, input.tokensPerDay, input.cacheMode, Date.now())
    .run();
  return { id, key };
}

export async function listKeys(env: AppEnv): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, key_prefix, requests_per_minute, tokens_per_day, cache_mode, created_at, revoked_at FROM api_keys ORDER BY created_at DESC",
  ).all();
  return results;
}

export async function revokeKey(env: AppEnv, id: string): Promise<boolean> {
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), id).run();
  forget();
  return result.meta.changes > 0;
}

/** The Durable Objects that have to admit a request on this key. */
export async function gatesFor(key: Key, request: Request): Promise<{ name: string; limits: Limits }[]> {
  if (!key.demo) return [{ name: `key:${key.id}`, limits: key }];
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const visitor = (await sha256Hex(address)).slice(0, 24);
  return [
    { name: `demo:${visitor}`, limits: DEMO_VISITOR },
    { name: "demo:all", limits: DEMO_TOTAL },
  ];
}
