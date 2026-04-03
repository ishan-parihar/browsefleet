import { Hono } from 'hono';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import type { BrowserPool } from '../pool/browser-pool.js';

export function filesRoutes(pool: BrowserPool): Hono {
  const app = new Hono();

  // Upload file to session
  app.post('/:id/files', async (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'file field is required (multipart)' }, 400);
    }

    const dir = `/tmp/bf-uploads-${session.id}`;
    mkdirSync(dir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(`${dir}/${file.name}`, buffer);

    return c.json({ uploaded: file.name, size: buffer.length });
  });

  // List files
  app.get('/:id/files', (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const uploadDir = `/tmp/bf-uploads-${session.id}`;
    const downloadDir = `/tmp/bf-downloads-${session.id}`;

    const files: string[] = [];
    if (existsSync(uploadDir)) files.push(...readdirSync(uploadDir).map(f => `uploads/${f}`));
    if (existsSync(downloadDir)) files.push(...readdirSync(downloadDir).map(f => `downloads/${f}`));

    return c.json({ files });
  });

  // Download file
  app.get('/:id/files/:name', (c) => {
    const session = pool.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const name = c.req.param('name');

    // Check uploads first, then downloads
    for (const dir of [`/tmp/bf-uploads-${session.id}`, `/tmp/bf-downloads-${session.id}`]) {
      const path = `${dir}/${name}`;
      if (existsSync(path)) {
        const data = readFileSync(path);
        return new Response(data, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${name}"`,
          },
        });
      }
    }

    return c.json({ error: 'File not found' }, 404);
  });

  return app;
}
