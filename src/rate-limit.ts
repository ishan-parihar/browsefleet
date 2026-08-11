import type { Context, Next } from 'hono';
import { config } from './config.js';

// Token bucket per key (API key, else client IP).
// Each key holds up to `burst` tokens; `rate` tokens refill every second.
// This is smoother than a fixed window: short bursts are allowed up to the
// burst capacity, sustained traffic is throttled at the steady rate.
interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

interface RateLimitOptions {
  rate?: number;
  burst?: number;
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}) {
  const rate = opts.rate ?? config.RATE_LIMIT_PER_SECOND;
  const burst = opts.burst ?? config.RATE_LIMIT_BURST;
  const windowMs = 60_000;

  return async (c: Context, next: Next) => {
    const key = c.req.header('x-api-key') ?? c.req.header('x-forwarded-for') ?? 'anonymous';
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.lastRefill + windowMs) {
      bucket = { tokens: burst, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens proportional to elapsed time.
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / rate));
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    bucket.tokens -= 1;

    c.header('X-RateLimit-Limit', String(burst));
    c.header('X-RateLimit-Remaining', String(Math.max(0, Math.floor(bucket.tokens))));

    return next();
  };
}

// Cleanup idle buckets every 60 seconds so the map stays bounded under
// traffic with many distinct keys (e.g. per-IP limit).
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.lastRefill + 60_000) {
      buckets.delete(key);
    }
  }
}, 60_000).unref();

export { buckets as _bucketsForTesting };
