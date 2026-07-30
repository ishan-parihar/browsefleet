import { ensureBinary } from 'cloakbrowser';
import * as puppeteerCore from 'puppeteer-core';
import { v4 as uuid } from 'uuid';
import { BrowserSession } from './session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { CreateSessionRequest } from '../types.js';
import type { Browser } from 'puppeteer-core';

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { profileExists, profileUserDataDir, touchProfile } from '../routes/profiles.js';

export class BrowserPool {
  private sessions = new Map<string, BrowserSession>();
  private utilityBrowser: Browser | null = null;
  private cloakBinaryPath?: Promise<string>;

  get activeCount(): number {
    return this.sessions.size;
  }

  private buildArgs(opts: CreateSessionRequest): string[] {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      // Allow WebSocket connections from the CDP proxy and any external agent.
      // Without this Chrome rejects WS upgrades with 403 from non-localhost origins.
      '--remote-allow-origins=*',
    ];

    if (opts.blockAds) {
      args.push(
        '--host-resolver-rules=MAP *.doubleclick.net 0.0.0.0, MAP *.googlesyndication.com 0.0.0.0',
      );
    }

    return args;
  }

  private buildLaunchOpts(opts: CreateSessionRequest) {
    const viewport = opts.viewport ?? { width: 1280, height: 900 };
    const args = this.buildArgs(opts);
    const userDataDir = opts.profileId ? profileUserDataDir(opts.profileId) : undefined;

    if (opts.profileId) {
      if (!profileExists(opts.profileId)) {
        throw new Error(`Profile ${opts.profileId} not found`);
      }
      mkdirSync(userDataDir!, { recursive: true });
    }

    return {
      headless: opts.headless ?? true,
      args,
      // ponytail: ensureBinary downloads and verifies the latest entitled build.
      proxy: opts.proxyUrl || config.PROXY_URL || undefined,
      licenseKey: config.CLOAKBROWSER_LICENSE_KEY || undefined,
      // Raw puppeteer launch options — userDataDir, defaultViewport, etc.
      launchOptions: {
        userDataDir,
        defaultViewport: viewport,
        timeout: 30_000,
      },
    };
  }

  async createSession(opts: CreateSessionRequest = {}, apiKey?: string): Promise<BrowserSession> {
    if (this.sessions.size >= config.MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${config.MAX_CONCURRENT_SESSIONS}) reached`);
    }

    const id = opts.sessionId || uuid();

    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }

    let browser: Browser;
    const launchOpts = this.buildLaunchOpts(opts);

    if (opts.stealth === 'none') {
      // ponytail: 'none' = vanilla puppeteer-core, no CloakBrowser patches.
      // Used for internal/utility pages where stealth doesn't matter.
      const { launchOptions, headless, args } = launchOpts;
      browser = await puppeteerCore.launch({
        headless,
        args,
        executablePath: config.chromePath || undefined,
        defaultViewport: launchOptions.defaultViewport,
        userDataDir: launchOptions.userDataDir,
        timeout: launchOptions.timeout,
      });
    } else {
      // The current Pro build detaches network frames when its runtime
      // --fingerprint flag is injected. The binary still provides its compiled
      // patches, so use the documented binary + Puppeteer Core path instead.
      this.cloakBinaryPath ??= ensureBinary(launchOpts.licenseKey);
      browser = await puppeteerCore.launch({
        headless: launchOpts.headless,
        args: launchOpts.args,
        executablePath: await this.cloakBinaryPath,
        defaultViewport: launchOpts.launchOptions.defaultViewport,
        userDataDir: launchOpts.launchOptions.userDataDir,
        timeout: launchOpts.launchOptions.timeout,
      });
    }

    // CloakBrowser Pro's bootstrap target detaches on first navigation.
    // Keep it open and use the fresh target created after launch.
    const sessionPage = await browser.newPage();

    const cdpEndpoint = browser.wsEndpoint();
    if (opts.profileId) touchProfile(opts.profileId);

    const session = new BrowserSession(
      id,
      browser,
      cdpEndpoint,
      sessionPage,
      opts,
      () => {
        this.releaseSession(id).catch(() => {});
      },
      apiKey,
    );

    // Apply random viewport if not specified (CloakBrowser handles fingerprint noise).
    // Skip when no viewport is set — calling setViewport() on the freshly-created
    // session page currently detaches the navigation frame in the Pro build.
    if (opts.viewport) {
      await sessionPage.setViewport(opts.viewport);
    }
    // Side note: randomized viewport assignment is disabled in this build to
    // avoid a known detach-frame crash in CloakBrowser Pro 150; the fingerprint
    // coverage CloakBrowser provides at the C++ level already randomizes
    // viewport-equivalent signals independently of puppeteer.

    // Set user agent if provided
    if (opts.userAgent) {
      await sessionPage.setUserAgent(opts.userAgent);
    }

    // Set extra headers if provided
    if (opts.headers) {
      await sessionPage.setExtraHTTPHeaders(opts.headers);
    }

    // Inject cookies if provided
    if (opts.cookies && opts.cookies.length > 0) {
      await sessionPage.setCookie(
        ...opts.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? '/',
        })),
      );
    }

    this.sessions.set(id, session);
    logger.info({ sessionId: id, stealth: opts.stealth ?? config.STEALTH_DEFAULT, viewport: opts.viewport }, 'Session created');

    return session;
  }

  getSession(id: string): BrowserSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): BrowserSession[] {
    return Array.from(this.sessions.values());
  }

  async releaseSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    const browserHours = session.getBrowserHours();
    await session.release();
    this.sessions.delete(id);

    // Clean up temporary upload/download directories
    try {
      rmSync(`/tmp/bf-uploads-${id}`, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(`/tmp/bf-downloads-${id}`, { recursive: true, force: true });
    } catch {}

    logger.info({ sessionId: id, browserHours: browserHours.toFixed(4) }, 'Session released');

    return true;
  }

  async releaseAll(): Promise<number> {
    const ids = Array.from(this.sessions.keys());
    let count = 0;
    for (const id of ids) {
      if (await this.releaseSession(id)) count++;
    }
    return count;
  }

  // Utility browser for quick actions (shared, not counted as a session)
  async getUtilityBrowser(): Promise<Browser> {
    if (this.utilityBrowser?.connected) {
      return this.utilityBrowser;
    }

    this.cloakBinaryPath ??= ensureBinary(config.CLOAKBROWSER_LICENSE_KEY || undefined);
    this.utilityBrowser = await puppeteerCore.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: await this.cloakBinaryPath,
      defaultViewport: { width: 1280, height: 900 },
      timeout: 30_000,
    });

    this.utilityBrowser!.on('disconnected', () => {
      this.utilityBrowser = null;
    });

    return this.utilityBrowser!;
  }

  // Run a quick action in an incognito context (fast, isolated)
  async withEphemeralContext<T>(
    fn: (page: puppeteerCore.Page) => Promise<T>,
    opts?: { proxyUrl?: string; stealth?: string; viewport?: { width: number; height: number } },
  ): Promise<T> {
    const browser = await this.getUtilityBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    if (opts?.viewport) {
      await page.setViewport(opts.viewport);
    }

    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    await this.releaseAll();
    if (this.utilityBrowser) {
      await this.utilityBrowser.close().catch(() => {});
      this.utilityBrowser = null;
    }
  }
}
