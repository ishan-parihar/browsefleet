import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Resolves an API key from incoming request, accepting in order:
 *  1. `x-api-key` header (canonical)
 *  2. `Authorization: Bearer <key>` (matches generic OAuth-style tooling)
 *  3. `?apiKey=<key>` query param (needed by browser-based /viewer links,
 *     where the user cannot set custom headers; SSE/EventSource also sends
 *     only query parameters)
 *
 * Returns the raw candidate string, or empty string if none supplied.
 * Authentication of that candidate happens in authMiddleware.
 */
export function resolveApiKey(c: Context): string {
  const header = c.req.header('x-api-key');
  if (header) return header;

  const auth = c.req.header('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];

  const query = c.req.query('apiKey') ?? '';
  return query;
}

export async function authMiddleware(c: Context, next: Next) {
  if (!config.authEnabled) {
    return next();
  }

  const apiKey = resolveApiKey(c);
  if (!apiKey) {
    return c.json({ error: 'Missing API key (x-api-key header, Authorization: Bearer, or ?apiKey= query param)' }, 401);
  }

  const valid = config.apiKeys.some((key) => safeCompare(key, apiKey));
  if (!valid) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('apiKey', apiKey);
  return next();
}
