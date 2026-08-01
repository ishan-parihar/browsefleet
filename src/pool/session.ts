import type { Browser, Page } from 'puppeteer-core';
import type { Session, CreateSessionRequest, SessionControlMode } from '../types.js';
import { config } from '../config.js';

export class BrowserSession {
  readonly id: string;
  readonly browser: Browser;
  readonly cdpEndpoint: string;
  readonly page: Page;
  readonly options: CreateSessionRequest;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly timeout: number;
  readonly apiKey: string | undefined;

  private releasedAt: Date | undefined;
  private expiryTimer: ReturnType<typeof setTimeout>;
  private _status: 'active' | 'released' | 'expired' | 'error' = 'active';
  private _controlMode: SessionControlMode = 'agent';
  private _sensitiveMode: boolean;
  private controlReason: string | undefined;
  private onExpire: () => void;

  constructor(
    id: string,
    browser: Browser,
    cdpEndpoint: string,
    page: Page,
    options: CreateSessionRequest,
    onExpire: () => void,
    apiKey?: string,
  ) {
    this.id = id;
    this.browser = browser;
    this.cdpEndpoint = cdpEndpoint;
    this.page = page;
    this.options = options;
    this.onExpire = onExpire;
    this.apiKey = apiKey;
    this.createdAt = new Date();
    this._controlMode = options.operatorMode ? 'human' : 'agent';
    this._sensitiveMode = options.sensitiveMode ?? false;
    this.timeout = Math.min(
      options.timeout ?? config.DEFAULT_SESSION_TIMEOUT,
      config.MAX_SESSION_TIMEOUT,
    );
    this.expiresAt = new Date(this.createdAt.getTime() + this.timeout);

    this.expiryTimer = setTimeout(() => {
      this._status = 'expired';
      this.onExpire();
    }, this.timeout);
  }

  get status() {
    return this._status;
  }
  get controlMode() {
    return this._controlMode;
  }
  get sensitiveMode() {
    return this._sensitiveMode;
  }

  setControl(controlMode: SessionControlMode, reason?: string): void {
    this._controlMode = controlMode;
    this.controlReason = reason;
  }

  setSensitiveMode(enabled: boolean): void {
    this._sensitiveMode = enabled;
  }

  assertAgentControl(): void {
    if (this._status !== 'active') {
      throw Object.assign(new Error(`Session is ${this._status}`), { status: 409 });
    }
    if (this._controlMode === 'human') {
      throw Object.assign(
        new Error(
          'Session is in human-control mode. Resume agent control before sending automation actions.',
        ),
        { status: 423 },
      );
    }
    if (this._controlMode === 'paused') {
      throw Object.assign(
        new Error('Session is paused. Resume agent control before sending automation actions.'),
        { status: 423 },
      );
    }
  }

  async getPage(): Promise<Page> {
    return this.page;
  }

  async getSnapshot(opts: { includeScreenshot?: boolean; quality?: number } = {}) {
    const page = await this.getPage();
    const [title, currentUrl] = await Promise.all([
      page.title().catch(() => ''),
      Promise.resolve(page.url()),
    ]);
    const snapshot: {
      sessionId: string;
      status: string;
      controlMode: SessionControlMode;
      sensitiveMode: boolean;
      controlReason?: string;
      url: string;
      title: string;
      screenshot?: string;
      screenshotSuppressed?: boolean;
    } = {
      sessionId: this.id,
      status: this._status,
      controlMode: this._controlMode,
      sensitiveMode: this._sensitiveMode,
      controlReason: this.controlReason,
      url: currentUrl,
      title,
    };

    if (opts.includeScreenshot) {
      if (this._sensitiveMode) {
        snapshot.screenshotSuppressed = true;
      } else {
        snapshot.screenshot = (await page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: opts.quality ?? 60,
        })) as string;
      }
    }

    return snapshot;
  }

  async release(): Promise<void> {
    if (this._status !== 'active') return;
    this._status = 'released';
    this.releasedAt = new Date();
    clearTimeout(this.expiryTimer);
    await this.browser.close().catch(() => {});
  }

  getBrowserHours(): number {
    const end = this._status === 'active' ? new Date() : (this.releasedAt ?? this.expiresAt);
    const ms = end.getTime() - this.createdAt.getTime();
    return ms / 3_600_000;
  }

  toApiObject(): Session {
    const { CDP_EXTERNAL_SCHEME, CDP_EXTERNAL_HOST, CDP_EXTERNAL_PORT } = config;
    
    // Construct CDP URL without port when using standard ports (80/443)
    // This handles Cloudflare tunnel and reverse proxy scenarios
    const cdpHost = CDP_EXTERNAL_PORT === 443 || CDP_EXTERNAL_PORT === 80
      ? CDP_EXTERNAL_HOST
      : `${CDP_EXTERNAL_HOST}:${CDP_EXTERNAL_PORT}`;
    
    // Construct viewer/events URLs - use standard HTTP(S) without port for public URLs
    const httpScheme = CDP_EXTERNAL_SCHEME === 'wss' ? 'https' : 'http';
    const viewerHost = CDP_EXTERNAL_PORT === 443 || CDP_EXTERNAL_PORT === 80
      ? CDP_EXTERNAL_HOST
      : `${CDP_EXTERNAL_HOST}:${CDP_EXTERNAL_PORT}`;
    
    return {
      id: this.id,
      status: this._status,
      websocketUrl: `${CDP_EXTERNAL_SCHEME}://${cdpHost}/cdp/${this.id}`,
      viewerUrl: `${httpScheme}://${viewerHost}/v1/sessions/${this.id}/live`,
      eventsUrl: `${httpScheme}://${viewerHost}/v1/sessions/${this.id}/events`,
      createdAt: this.createdAt.toISOString(),
      expiresAt: this.expiresAt.toISOString(),
      timeout: this.timeout,
      proxyUrl: this.options.proxyUrl,
      stealth: this.options.stealth ?? config.STEALTH_DEFAULT,
      viewport: this.options.viewport ?? { width: 1280, height: 900 },
      profileId: this.options.profileId,
      operatorMode: this.options.operatorMode ?? false,
      controlMode: this._controlMode,
      sensitiveMode: this._sensitiveMode,
    };
  }
}
