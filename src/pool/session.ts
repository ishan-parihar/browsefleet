import type { Browser, Page } from 'puppeteer-core';
import type { Session, CreateSessionRequest } from '../types.js';
import { config } from '../config.js';

export class BrowserSession {
  readonly id: string;
  readonly browser: Browser;
  readonly cdpEndpoint: string;
  readonly options: CreateSessionRequest;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly timeout: number;

  private expiryTimer: ReturnType<typeof setTimeout>;
  private _status: 'active' | 'released' | 'expired' | 'error' = 'active';
  private onExpire: () => void;

  constructor(
    id: string,
    browser: Browser,
    cdpEndpoint: string,
    options: CreateSessionRequest,
    onExpire: () => void,
  ) {
    this.id = id;
    this.browser = browser;
    this.cdpEndpoint = cdpEndpoint;
    this.options = options;
    this.onExpire = onExpire;
    this.createdAt = new Date();
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

  get status() { return this._status; }

  async getPage(): Promise<Page> {
    const pages = await this.browser.pages();
    return pages[0] ?? await this.browser.newPage();
  }

  async release(): Promise<void> {
    if (this._status !== 'active') return;
    this._status = 'released';
    clearTimeout(this.expiryTimer);
    await this.browser.close().catch(() => {});
  }

  getBrowserHours(): number {
    const end = this._status === 'active' ? new Date() : this.expiresAt;
    const ms = end.getTime() - this.createdAt.getTime();
    return ms / 3_600_000;
  }

  toApiObject(): Session {
    const { CDP_EXTERNAL_SCHEME, CDP_EXTERNAL_HOST, CDP_EXTERNAL_PORT } = config;
    return {
      id: this.id,
      status: this._status,
      websocketUrl: `${CDP_EXTERNAL_SCHEME}://${CDP_EXTERNAL_HOST}:${CDP_EXTERNAL_PORT}/cdp/${this.id}`,
      viewerUrl: `http://${CDP_EXTERNAL_HOST}:${CDP_EXTERNAL_PORT}/v1/sessions/${this.id}/live`,
      createdAt: this.createdAt.toISOString(),
      expiresAt: this.expiresAt.toISOString(),
      timeout: this.timeout,
      proxyUrl: this.options.proxyUrl,
      stealth: this.options.stealth ?? config.STEALTH_DEFAULT,
      viewport: this.options.viewport ?? { width: 1280, height: 900 },
      profileId: this.options.profileId,
    };
  }
}
