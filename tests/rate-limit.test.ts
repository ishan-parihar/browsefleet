import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware, _bucketsForTesting } from '../src/rate-limit.js';

function buildApp(opts?: { rate?: number; burst?: number }) {
  const app = new Hono();
  app.use('/limited/*', rateLimitMiddleware(opts));
  app.get('/limited/ping', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  _bucketsForTesting.clear();
});

afterEach(() => {
  _bucketsForTesting.clear();
});

describe('rateLimitMiddleware', () => {
  it('allows requests up to the burst capacity', async () => {
    const app = buildApp({ rate: 5, burst: 5 });
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/limited/ping', {
        headers: { 'x-api-key': 'k1' },
      });
      expect(res.status).toBe(200);
    }
  });

  it('rejects with 429 once the burst is exhausted', async () => {
    const app = buildApp({ rate: 5, burst: 5 });
    for (let i = 0; i < 5; i++) {
      await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    }
    const res = await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' });
  });

  it('sets Retry-After and X-RateLimit headers', async () => {
    const app = buildApp({ rate: 2, burst: 2 });
    await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    const ok = await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    expect(ok.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(ok.headers.get('X-RateLimit-Remaining')).toBe('0');
    const limited = await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });

  it('keys by API key, so different keys get independent buckets', async () => {
    const app = buildApp({ rate: 1, burst: 1 });
    await app.request('/limited/ping', { headers: { 'x-api-key': 'a' } });
    const resA = await app.request('/limited/ping', { headers: { 'x-api-key': 'a' } });
    expect(resA.status).toBe(429);
    const resB = await app.request('/limited/ping', { headers: { 'x-api-key': 'b' } });
    expect(resB.status).toBe(200);
  });

  it('falls back to x-forwarded-for when no API key is present', async () => {
    const app = buildApp({ rate: 1, burst: 1 });
    await app.request('/limited/ping', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    const res = await app.request('/limited/ping', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(res.status).toBe(429);
    const other = await app.request('/limited/ping', { headers: { 'x-forwarded-for': '5.6.7.8' } });
    expect(other.status).toBe(200);
  });

  it('refills tokens over time instead of blocking forever', async () => {
    const app = buildApp({ rate: 10, burst: 1 });
    await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    const blocked = await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    expect(blocked.status).toBe(429);

    // Simulate ~1 second elapsing by backdating the bucket's lastRefill.
    const bucket = _bucketsForTesting.get('k1');
    expect(bucket).toBeTruthy();
    bucket!.lastRefill = Date.now() - 1100;
    const afterRefill = await app.request('/limited/ping', { headers: { 'x-api-key': 'k1' } });
    expect(afterRefill.status).toBe(200);
  });
});
