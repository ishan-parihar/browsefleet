import type { Context, Next } from 'hono';
import { config } from './config.js';

export async function authMiddleware(c: Context, next: Next) {
  if (!config.authEnabled) {
    return next();
  }

  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return c.json({ error: 'Missing x-api-key header' }, 401);
  }

  if (!config.apiKeys.includes(apiKey)) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  c.set('apiKey', apiKey);
  return next();
}
