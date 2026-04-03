import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { config } from '../config.js';
import type { Profile, CreateProfileRequest } from '../types.js';

const profilesDir = () => `${config.dataDir}/profiles`;

function getProfileMeta(id: string): Profile | null {
  const metaPath = `${profilesDir()}/${id}/meta.json`;
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

function listProfiles(): Profile[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  const { readdirSync } = require('node:fs');
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e: any) => e.isDirectory())
    .map((e: any) => getProfileMeta(e.name))
    .filter(Boolean) as Profile[];
}

export function profilesRoutes(): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await c.req.json<CreateProfileRequest>().catch(() => null);
    if (!body?.name) return c.json({ error: 'name is required' }, 400);

    const id = uuid();
    const now = new Date().toISOString();
    const profile: Profile = { id, name: body.name, createdAt: now, updatedAt: now };

    const dir = `${profilesDir()}/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/meta.json`, JSON.stringify(profile, null, 2));
    writeFileSync(`${dir}/cookies.json`, '[]');
    writeFileSync(`${dir}/localStorage.json`, '{}');

    return c.json(profile, 201);
  });

  app.get('/', (c) => {
    return c.json({ profiles: listProfiles() });
  });

  app.get('/:id', (c) => {
    const profile = getProfileMeta(c.req.param('id'));
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    return c.json(profile);
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const dir = `${profilesDir()}/${id}`;
    if (!existsSync(dir)) return c.json({ error: 'Profile not found' }, 404);
    rmSync(dir, { recursive: true });
    return c.json({ deleted: true });
  });

  return app;
}

// Helpers for session integration
export function loadProfileCookies(profileId: string): any[] {
  const path = `${profilesDir()}/${profileId}/cookies.json`;
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveProfileCookies(profileId: string, cookies: any[]): void {
  const path = `${profilesDir()}/${profileId}/cookies.json`;
  writeFileSync(path, JSON.stringify(cookies, null, 2));
}
