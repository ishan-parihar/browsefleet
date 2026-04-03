import { Hono } from 'hono';
import type { BrowserPool } from '../pool/browser-pool.js';
import type { CreateSessionRequest, ReleaseRequest } from '../types.js';

export function sessionsRoutes(pool: BrowserPool): Hono {
  const app = new Hono();

  // Create session
  app.post('/', async (c) => {
    const body = await c.req.json<CreateSessionRequest>().catch(() => ({}));

    try {
      const session = await pool.createSession(body);
      return c.json(session.toApiObject(), 201);
    } catch (err: any) {
      const status = err.message?.includes('Maximum') ? 429 : 500;
      return c.json({ error: err.message }, status);
    }
  });

  // List sessions
  app.get('/', (c) => {
    const sessions = pool.listSessions().map(s => s.toApiObject());
    return c.json({ sessions, count: sessions.length });
  });

  // Get session
  app.get('/:id', (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session.toApiObject());
  });

  // Release session
  app.post('/:id/release', async (c) => {
    const released = await pool.releaseSession(c.req.param('id'));
    if (!released) return c.json({ error: 'Session not found' }, 404);
    return c.json({ released: true });
  });

  // Release all or batch
  app.post('/release', async (c) => {
    const body = await c.req.json<ReleaseRequest>().catch(() => ({} as ReleaseRequest));

    if (body.ids && body.ids.length > 0) {
      let count = 0;
      for (const id of body.ids) {
        if (await pool.releaseSession(id)) count++;
      }
      return c.json({ released: count });
    }

    const count = await pool.releaseAll();
    return c.json({ released: count });
  });

  // Live viewer (SSE — streams screenshots)
  app.get('/:id/live', async (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let running = true;

        const interval = setInterval(async () => {
          if (!running) return;
          try {
            const page = await session.getPage();
            const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ screenshot })}\n\n`));
          } catch {
            running = false;
            clearInterval(interval);
            controller.close();
          }
        }, 500);

        // Cleanup after 5 minutes max
        setTimeout(() => {
          running = false;
          clearInterval(interval);
          controller.close();
        }, 300_000);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  return app;
}
