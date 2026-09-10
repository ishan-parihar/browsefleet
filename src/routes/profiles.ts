import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { clearStaleProfileLocks } from '../utils/profile-lock-recovery.js';
import type { Profile, CreateProfileRequest } from '../types.js';

const profilesDir = () => `${config.dataDir}/profiles`;
export const profileDir = (id: string) => `${profilesDir()}/${id}`;
export const profileUserDataDir = (id: string) => `${profileDir(id)}/chrome`;

export function profileExists(id: string): boolean {
  return UUID_RE.test(id) && existsSync(`${profileDir(id)}/meta.json`);
}

function getProfileMeta(id: string): Profile | null {
  const metaPath = `${profilesDir()}/${id}/meta.json`;
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

export function touchProfile(id: string): void {
  const profile = getProfileMeta(id);
  if (!profile) return;
  const now = new Date().toISOString();
  writeFileSync(
    `${profileDir(id)}/meta.json`,
    JSON.stringify({ ...profile, lastUsedAt: now, updatedAt: now }, null, 2),
  );
}

function listProfiles(): Profile[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e: any) => e.isDirectory())
    .map((e: any) => getProfileMeta(e.name))
    .filter(Boolean) as Profile[];
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function profilesRoutes(): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await c.req.json<CreateProfileRequest>().catch(() => null);
    if (!body?.name) return c.json({ error: 'name is required' }, 400);

    const id = uuid();
    const now = new Date().toISOString();
    const profile: Profile = {
      id,
      name: body.name,
      provider: body.provider,
      createdAt: now,
      updatedAt: now,
    };

    const dir = profileDir(id);
    mkdirSync(dir, { recursive: true });
    mkdirSync(profileUserDataDir(id), { recursive: true });
    writeFileSync(`${dir}/meta.json`, JSON.stringify(profile, null, 2));
    writeFileSync(`${dir}/cookies.json`, '[]');
    writeFileSync(`${dir}/localStorage.json`, '{}');

    return c.json(profile, 201);
  });

  app.get('/', (c) => {
    return c.json({ profiles: listProfiles() });
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid profile ID' }, 400);
    const profile = getProfileMeta(id);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    return c.json(profile);
  });

  // Force-release a stale Chromium profile lock without touching cookies or
  // the profile directory contents. Use when a previous browser session was
  // killed abruptly (OOM, SIGKILL, container restart) and the SingletonLock
  // was never released. Idempotent: deleting non-existent lockfiles is a
  // no-op. Never deletes cookies, history, or other state the user owns.
  app.post('/:id/unlock', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid profile ID' }, 400);
    if (!profileExists(id)) return c.json({ error: 'Profile not found' }, 404);

    const userDataDir = profileUserDataDir(id);
    const result = clearStaleProfileLocks(userDataDir);

    logger.info({ profileId: id, removedCount: result.filesRemoved.length }, 'profile unlocked via API');

    return c.json({
      profileId: id,
      unlocked: true,
      filesRemoved: result.filesRemoved,
      userDataDir,
    });
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid profile ID' }, 400);
    const dir = profileDir(id);
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
