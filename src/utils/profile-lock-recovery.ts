import { lstatSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

/**
 * Chromium singleton lock artifacts which — when stale — block relaunch even
 * though no browser process actually owns the profile anymore.
 *
 * Chromium writes these on start and removes them on clean exit. If a browser
 * crashes (OOM-killed on a small VPS, SIGKILL from a supervisor, kernel
 * panic), the lock files stay. The next launch then fails with:
 *   "The browser is already running for /path/to/profile."
 *
 * Deleting these artifacts is safe when no live chrome process is bound to
 * the profile. Recovery proceeds only when puppeteer fails with that exact
 * signature, so we never delete lockfiles owned by a live browser.
 *
 * IMPORTANT: `SingletonLock`/`SingletonCookie`/`SingletonSocket` are often
 * symlinks (e.g. `SingletonLock -> "host-pid"`). A symlink to a dangling
 * target reads as "does not exist" via existsSync, but `lstatSync` reports
 * the LINK itself. We must use lstat, not exists, or stale symlinks are
 * invisible and never get cleaned up.
 */
const LOCKFILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  // Chromium sometimes leaves a stale DevToolsActivePort file that confuses
  // subsequent launches into believing a devtools server already exists.
  'DevToolsActivePort',
];

export interface LockRecoveryResult {
  recovered: boolean;
  filesRemoved: string[];
  reason?: string;
}

/** True if the path is a file OR symlink that exists (including dangling links). */
function pathExistsIncludingSymlinks(p: string): boolean {
  return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Attempt to clear stale Chromium profile locks under `userDataDir`.
 * Returns details about what was removed so the caller can log/metric.
 */
export function clearStaleProfileLocks(userDataDir: string | undefined): LockRecoveryResult {
  if (!userDataDir) return { recovered: false, filesRemoved: [], reason: 'no_userDataDir' };
  if (!pathExistsIncludingSymlinks(userDataDir)) return { recovered: true, filesRemoved: [] };

  const removed: string[] = [];

  // Level 1: top-level singletons in userDataDir. lstat first because
  // SingletonLock is typically a symlink whose target is a stale "host-pid"
  // that doesn't exist anymore — existsSync would say false but the link
  // itself still has to be unlinked.
  for (const f of LOCKFILES) {
    const p = join(userDataDir, f);
    try {
      if (pathExistsIncludingSymlinks(p)) {
        rmSync(p, { force: true, recursive: false });
        removed.push(p);
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, path: p }, 'lockfile removal failed');
    }
  }

  // Level 2: subprofiles. Chromium sometimes also drops lockfiles one level
  // deep (Default/, Profile */). Walk only one level deep to avoid sweeping
  // too aggressively.
  try {
    for (const sub of readdirSync(userDataDir)) {
      const subPath = join(userDataDir, sub);
      try {
        if (!statSync(subPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (sub !== 'Default' && !sub.startsWith('Profile')) continue;
      for (const f of LOCKFILES) {
        const p = join(subPath, f);
        try {
          if (pathExistsIncludingSymlinks(p)) {
            rmSync(p, { force: true });
            removed.push(p);
          }
        } catch (err: any) {
          logger.warn({ err: err?.message, path: p }, 'subprofile lockfile removal failed');
        }
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, userDataDir }, 'sub-profile sweep failed');
  }

  return { recovered: removed.length > 0, filesRemoved: removed };
}

/** Detect whether a puppeteer launch error is the "already running" profile lock. */
export function isProfileLockError(err: unknown): boolean {
  const msg = (err as any)?.message ?? String(err ?? '');
  return (
    msg.includes('already running') ||
    msg.includes('userDataDir') && msg.includes('in use') ||
    msg.includes('Failed to create a ProcessSingleton') ||
    msg.includes('profile appears to be in use by another Chromium process') ||
    msg.includes('Existing browser session')
  );
}
