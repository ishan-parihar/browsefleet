import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSession } from '../src/pool/session.js';
import { config } from '../src/config.js';

function makeSession(overrides: any = {}) {
  const browser = overrides.browser ?? {
    close: vi.fn().mockResolvedValue(undefined),
  };
  const page = overrides.page ?? {
    title: vi.fn().mockResolvedValue('Test Page'),
    screenshot: vi.fn().mockResolvedValue('c2NyZWVuc2hvdA=='),
    url: () => 'https://example.com',
  };
  const onExpire = overrides.onExpire ?? vi.fn();
  return new BrowserSession(
    overrides.id ?? 's1',
    browser,
    'ws://fake/cdp',
    page,
    overrides.options ?? { timeout: 5_000 },
    onExpire,
    overrides.apiKey,
  );
}

describe('BrowserSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts active with the configured timeout', () => {
    const s = makeSession({ options: { timeout: 10_000 } });
    expect(s.status).toBe('active');
    expect(s.timeout).toBe(10_000);
  });

  it('caps timeout at MAX_SESSION_TIMEOUT', () => {
    Object.defineProperty(config, 'MAX_SESSION_TIMEOUT', { value: 5_000, configurable: true });
    const s = makeSession({ options: { timeout: 999_999_999 } });
    expect(s.timeout).toBe(5_000);
  });

  it('defaults control mode to agent, honors operatorMode', () => {
    expect(makeSession().controlMode).toBe('agent');
    expect(makeSession({ options: { operatorMode: true } }).controlMode).toBe('human');
  });

  it('setControl changes the control mode', () => {
    const s = makeSession();
    s.setControl('paused', 'manual pause');
    expect(s.controlMode).toBe('paused');
  });

  it('assertAgentControl throws 423 when in human control mode', () => {
    const s = makeSession({ options: { operatorMode: true } });
    expect(() => s.assertAgentControl()).toThrowError(
      expect.objectContaining({ status: 423 }),
    );
  });

  it('assertAgentControl throws 409 when session is not active', () => {
    const s = makeSession();
    expect(() => s.assertAgentControl()).not.toThrow();
    const expired = makeSession();
    vi.advanceTimersByTime(10_000);
    expect(expired.status).toBe('expired');
    expect(() => expired.assertAgentControl()).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('expires after the timeout and fires onExpire', () => {
    const onExpire = vi.fn();
    makeSession({ options: { timeout: 5_000 }, onExpire });
    vi.advanceTimersByTime(5_001);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('release closes the browser and marks the session released', async () => {
    const browser = { close: vi.fn().mockResolvedValue(undefined) };
    const s = makeSession({ browser });
    await s.release();
    expect(s.status).toBe('released');
    expect(browser.close).toHaveBeenCalled();
    // Second release is a no-op.
    await s.release();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('suppresses screenshots in sensitive mode', async () => {
    const s = makeSession({ options: { sensitiveMode: true } });
    const snap = await s.getSnapshot({ includeScreenshot: true });
    expect(snap.screenshotSuppressed).toBe(true);
    expect(snap.screenshot).toBeUndefined();
  });

  it('includes a screenshot when not sensitive', async () => {
    const s = makeSession();
    const snap = await s.getSnapshot({ includeScreenshot: true });
    expect(snap.screenshot).toBe('c2NyZWVuc2hvdA==');
    expect(snap.screenshotSuppressed).toBeUndefined();
  });

  it('toApiObject exposes the CDP endpoint and URLs', () => {
    Object.defineProperty(config, 'CDP_EXTERNAL_PORT', { value: 3000, configurable: true });
    Object.defineProperty(config, 'CDP_EXTERNAL_HOST', { value: 'localhost', configurable: true });
    Object.defineProperty(config, 'CDP_EXTERNAL_SCHEME', { value: 'ws', configurable: true });
    const s = makeSession({ id: 's1' });
    const api = s.toApiObject();
    expect(api.id).toBe('s1');
    expect(api.websocketUrl).toBe('ws://localhost:3000/cdp/s1');
    expect(api.viewerUrl).toContain('/v1/sessions/s1/live');
  });

  it('omits the port for standard 443 and uses wss', () => {
    Object.defineProperty(config, 'CDP_EXTERNAL_PORT', { value: 443, configurable: true });
    Object.defineProperty(config, 'CDP_EXTERNAL_HOST', { value: 'browsefleet.com', configurable: true });
    Object.defineProperty(config, 'CDP_EXTERNAL_SCHEME', { value: 'wss', configurable: true });
    const s = makeSession({ id: 's1' });
    const api = s.toApiObject();
    expect(api.websocketUrl).toBe('wss://browsefleet.com/cdp/s1');
    expect(api.viewerUrl).toContain('https://browsefleet.com/v1/sessions/s1/live');
  });

  it('reports elapsed browser hours', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const s = makeSession();
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    expect(s.getBrowserHours()).toBeGreaterThanOrEqual(1);
  });
});
