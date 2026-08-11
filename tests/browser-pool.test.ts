import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserPool } from '../src/pool/browser-pool.js';
import { config } from '../src/config.js';

// Mock puppeteer-core + cloakbrowser so no real browser is ever launched.
vi.mock('puppeteer-core', () => ({
  launch: vi.fn(),
}));

vi.mock('cloakbrowser', () => ({
  ensureBinary: vi.fn().mockResolvedValue('/fake/chrome'),
}));

import * as puppeteerCore from 'puppeteer-core';

function fakeBrowser() {
  return {
    wsEndpoint: () => 'ws://fake:9222/devtools/browser/abc',
    newPage: vi.fn().mockResolvedValue(fakePage()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakePage() {
  return {
    setViewport: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setCookie: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('aGVsbG8='),
    title: vi.fn().mockResolvedValue('title'),
    url: () => 'https://example.com',
  };
}

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.clearAllMocks();
    (puppeteerCore.launch as any).mockResolvedValue(fakeBrowser());
    // Ensure a generous limit for most tests; specific tests override it.
    Object.defineProperty(config, 'MAX_CONCURRENT_SESSIONS', { value: 30, configurable: true });
    pool = new BrowserPool();
  });

  it('creates a session and tracks it', async () => {
    const session = await pool.createSession({ stealth: 'none' });
    expect(session.id).toBeTruthy();
    expect(pool.activeCount).toBe(1);
    expect(pool.getSession(session.id)).toBe(session);
    expect(pool.listSessions()).toHaveLength(1);
  });

  it('rejects duplicate session ids', async () => {
    const session = await pool.createSession({ stealth: 'none', sessionId: 'dup' });
    await expect(pool.createSession({ stealth: 'none', sessionId: 'dup' })).rejects.toThrow(
      /already exists/,
    );
    expect(session.id).toBe('dup');
  });

  it('enforces the max concurrent sessions cap', async () => {
    Object.defineProperty(config, 'MAX_CONCURRENT_SESSIONS', { value: 1, configurable: true });
    await pool.createSession({ stealth: 'none' });
    await expect(pool.createSession({ stealth: 'none' })).rejects.toThrow(/Maximum concurrent/);
  });

  it('releases a session, closes its browser, and removes it from tracking', async () => {
    const session = await pool.createSession({ stealth: 'none' });
    const browser = (session as any).browser;
    const released = await pool.releaseSession(session.id);
    expect(released).toBe(true);
    expect(browser.close).toHaveBeenCalled();
    expect(pool.activeCount).toBe(0);
    expect(pool.getSession(session.id)).toBeUndefined();
    // Double release is a no-op that reports false.
    expect(await pool.releaseSession(session.id)).toBe(false);
  });

  it('releaseAll releases every session', async () => {
    await pool.createSession({ stealth: 'none' });
    await pool.createSession({ stealth: 'none' });
    expect(pool.activeCount).toBe(2);
    const count = await pool.releaseAll();
    expect(count).toBe(2);
    expect(pool.activeCount).toBe(0);
  });

  it('launches vanilla puppeteer when stealth=none and CloakBrowser otherwise', async () => {
    await pool.createSession({ stealth: 'none' });
    expect(puppeteerCore.launch).toHaveBeenCalled();
    await pool.createSession({ stealth: 'full' });
    expect(puppeteerCore.launch).toHaveBeenCalledTimes(2);
  });
});
