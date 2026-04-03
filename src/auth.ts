import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function authMiddleware(c: Context, next: Next) {
  if (!config.authEnabled) {
    return next();
  }

  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return c.json({ error: 'Missing x-api-key header' }, 401);
  }

  const valid = config.apiKeys.some((key) => safeCompare(key, apiKey));
  if (!valid) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('apiKey', apiKey);
  return next();
}
