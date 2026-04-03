import type { Context, Next } from 'hono';

// In-memory sliding window rate limiter
const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(defaultLimit: number = 10) {
  return async (c: Context, next: Next) => {
    const key = c.req.header('x-api-key') ?? c.req.header('x-forwarded-for') ?? 'anonymous';
    const now = Date.now();
    const windowMs = 1000;

    let window = windows.get(key);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }

    window.count++;

    if (window.count > defaultLimit) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    c.header('X-RateLimit-Limit', String(defaultLimit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, defaultLimit - window.count)));

    return next();
  };
}

// Cleanup old windows every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of windows) {
    if (now >= window.resetAt + 60_000) {
      windows.delete(key);
    }
  }
}, 60_000);
