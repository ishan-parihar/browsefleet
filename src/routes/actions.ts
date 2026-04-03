import { Hono } from 'hono';
import type { BrowserPool } from '../pool/browser-pool.js';
import type { ActionRequest, ActionResponse } from '../types.js';

export function actionsRoutes(pool: BrowserPool): Hono {
  const app = new Hono();

  app.post('/:id/actions', async (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const body = await c.req.json<ActionRequest>().catch(() => null);
    if (!body?.actions?.length) return c.json({ error: 'actions array is required' }, 400);

    const page = await session.getPage();
    const results: ActionResponse['results'] = [];

    for (const action of body.actions) {
      try {
        switch (action.type) {
          case 'screenshot': {
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'screenshot', success: true, screenshot: ss as string });
            break;
          }
          case 'click': {
            await page.mouse.click(action.x, action.y, {
              button: action.button ?? 'left',
              clickCount: action.clickCount ?? 1,
            });
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'click', success: true, screenshot: ss as string });
            break;
          }
          case 'type': {
            await page.keyboard.type(action.text, { delay: 30 });
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'type', success: true, screenshot: ss as string });
            break;
          }
          case 'press_key': {
            await page.keyboard.press(action.key as any);
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'press_key', success: true, screenshot: ss as string });
            break;
          }
          case 'scroll': {
            await page.mouse.wheel({ deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
            await new Promise(r => setTimeout(r, 500));
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'scroll', success: true, screenshot: ss as string });
            break;
          }
          case 'move_mouse': {
            await page.mouse.move(action.x, action.y);
            results.push({ type: 'move_mouse', success: true });
            break;
          }
          case 'wait': {
            await new Promise(r => setTimeout(r, Math.min(action.duration, 30_000)));
            results.push({ type: 'wait', success: true });
            break;
          }
          case 'navigate': {
            await page.goto(action.url, { waitUntil: 'networkidle2', timeout: 30_000 });
            const ss = await page.screenshot({ encoding: 'base64', type: 'png' });
            results.push({ type: 'navigate', success: true, screenshot: ss as string });
            break;
          }
          default:
            results.push({ type: (action as any).type, success: false, error: 'Unknown action type' });
        }
      } catch (err: any) {
        results.push({ type: action.type, success: false, error: err.message });
      }
    }

    return c.json({ results });
  });

  return app;
}
