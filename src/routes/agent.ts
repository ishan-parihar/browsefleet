import { Hono } from 'hono';
import type { BrowserPool } from '../pool/browser-pool.js';
import { runAgent } from '../agent/agent.js';
import type { AgentRequest } from '../agent/agent.js';
import { getOwnedSession } from '../utils/session-auth.js';
import { validateUrl } from '../utils/url-validator.js';

export function agentRoutes(pool: BrowserPool): Hono {
  const app = new Hono();

  // Autonomous agent — creates a session, runs the task, releases the session
  // POST /v1/agent
  app.post('/', async (c) => {
    const body = await c.req.json<AgentRequest>().catch(() => null);
    if (!body?.task) return c.json({ error: 'task is required' }, 400);

    const apiKey = c.req.header('x-api-key');
    let session;
    try {
      session = await pool.createSession(
        {
          stealth: 'full',
          viewport: { width: 1280, height: 900 },
        },
        apiKey,
      );
    } catch (err: any) {
      return c.json({ error: `Failed to create session: ${err.message}` }, 500);
    }

    try {
      const page = await session.getPage();
      const result = await runAgent(page, body);

      // Strip screenshots from response to reduce payload (keep only final)
      const lightSteps = result.steps.map((s, i) => ({
        iteration: s.iteration,
        reasoning: s.reasoning,
        actions: s.actions,
        screenshot: i === result.steps.length - 1 ? s.screenshot : undefined,
      }));

      return c.json({
        ...result,
        steps: lightSteps,
        sessionId: session.id,
      });
    } finally {
      await pool.releaseSession(session.id);
    }
  });

  // Agent on existing session — uses an already-created session
  // POST /v1/sessions/:id/agent
  app.post('/:id/agent', async (c) => {
    const apiKey = c.req.header('x-api-key');
    let session;
    try {
      session = getOwnedSession(pool, c.req.param('id'), apiKey);
    } catch (e: any) {
      return c.json({ error: e.message }, e.status ?? 404);
    }

    const body = await c.req.json<AgentRequest>().catch(() => null);
    if (!body?.task) return c.json({ error: 'task is required' }, 400);

    const page = await session.getPage();
    const result = await runAgent(page, body);

    // Strip intermediate screenshots
    const lightSteps = result.steps.map((s, i) => ({
      iteration: s.iteration,
      reasoning: s.reasoning,
      actions: s.actions,
      screenshot: i === result.steps.length - 1 ? s.screenshot : undefined,
    }));

    return c.json({ ...result, steps: lightSteps });
  });

  // Agent streaming — SSE stream of agent steps as they happen.
  // Thin wrapper: the loop lives in runAgent(); this route only frames the
  // onEvent callback as SSE `data:` lines and closes the stream on completion.
  // POST /v1/agent/stream
  app.post('/stream', async (c) => {
    const body = await c.req.json<AgentRequest>().catch(() => null);
    if (!body?.task) return c.json({ error: 'task is required' }, 400);

    const apiKey = c.req.header('x-api-key');
    let session;
    try {
      session = await pool.createSession(
        {
          stealth: 'full',
          viewport: { width: 1280, height: 900 },
        },
        apiKey,
      );
    } catch (err: any) {
      return c.json({ error: `Failed to create session: ${err.message}` }, 500);
    }

    const sessionId = session.id;
    const poolRef = pool;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const safeClose = () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        };
        const emit = (data: any) => {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const page = await session!.getPage();
          await runAgent(page, body!, (event) => emit(event));
        } finally {
          await poolRef.releaseSession(sessionId);
          safeClose();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}
