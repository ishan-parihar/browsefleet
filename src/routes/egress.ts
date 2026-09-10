import { Hono } from 'hono';
import { resolveApiKey } from '../auth.js';

/**
 * Lightweight HTTP-egress probe. Runs on the BF server itself, so the request
 * egresses from the server's IP (residential, on omarchy) rather than from
 * whatever datacenter IP launched the client.
 *
 * Use case: LinkedIn session liveness. The linkedin-lyr client probes a cookie
 * set via GET /v1/egress/probe; BF performs the voyager GET from the trusted
 * residential egress. This avoids LinkedIn rotating sessions that are probed
 * from a datacenter IP (the exact failure in HI-RG-056).
 */
export function egressRoutes(): Hono {
  const app = new Hono();

  app.post('/egress/probe', async (c) => {
    const apiKey = resolveApiKey(c);
    let body: {
      url?: string;
      cookies?: Record<string, string> | string[];
      csrfToken?: string;
      userAgent?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      method?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    const url = body.url;
    if (!url || !/^https:\/\//i.test(url)) {
      return c.json({ error: 'url (https) is required' }, 400);
    }

    let cookieHeader = '';
    if (Array.isArray(body.cookies)) {
      // Chrome cookie-array form
      const arr = body.cookies as any[];
      const parts: string[] = [];
      for (const ck of arr) {
        if (ck?.name && ck?.value != null) parts.push(`${encodeURIComponent(ck.name)}=${encodeURIComponent(ck.value)}`);
      }
      cookieHeader = parts.join('; ');
    } else if (body.cookies && typeof body.cookies === 'object') {
      cookieHeader = Object.entries(body.cookies)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('; ');
    }

    const headers: Record<string, string> = {
      'user-agent':
        body.userAgent ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      accept: 'application/json, text/plain, */*',
      'x-restli-protocol-version': '2.0.0',
      ...(body.csrfToken ? { 'csrf-token': body.csrfToken } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(body.headers ?? {}),
    };

    const method = (body.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.min(body.timeoutMs ?? 15_000, 60_000);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      const setCookie = resp.headers.get('set-cookie') ?? '';
      const location = resp.headers.get('location') ?? '';
      const text = await resp.text().catch(() => '');
      return c.json({
        status: resp.status,
        ok: resp.status >= 200 && resp.status < 300,
        location,
        setCookie: setCookie.slice(0, 500),
        clearSiteData: resp.headers.get('clear-site-data'),
        bodyHead: text.slice(0, 1000),
        egressFrom: 'bf-server',
      });
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      return c.json(
        { error: aborted ? `timeout after ${timeoutMs}ms` : err.message, egressFrom: 'bf-server' },
        aborted ? 504 : 502,
      );
    }
  });

  return app;
}