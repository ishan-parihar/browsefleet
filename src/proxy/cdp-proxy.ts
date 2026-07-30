import { WebSocket, WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { BrowserPool } from '../pool/browser-pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function createCdpProxy(
  pool: BrowserPool,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });

  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Extract session ID from /cdp/:sessionId
    const match = url.pathname.match(/^\/cdp\/([a-zA-Z0-9-]+)/);
    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];

    // Auth check
    if (config.authEnabled) {
      const apiKey = url.searchParams.get('apiKey') ?? (req.headers['x-api-key'] as string);
      const logUrl = new URL(url.toString());
      logUrl.searchParams.delete('apiKey');
      logger.debug({ url: logUrl.toString() }, 'CDP upgrade request');
      const keyValid =
        apiKey &&
        config.apiKeys.some((k) => {
          const a = Buffer.from(apiKey);
          const b = Buffer.from(k);
          return a.length === b.length && timingSafeEqual(a, b);
        });
      if (!keyValid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const session = pool.getSession(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Session Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // CRITICAL: handle the upgrade SYNCHRONOUSLY before returning, so Node's
    // HTTP server does not subsequently emit `request` to the Hono fetch
    // handler (which would respond 404 first and break the upgrade).
    // We accept the client side immediately, then bridge to Chrome.
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      logger.debug({ sessionId, cdp: session.cdpEndpoint }, 'CDP proxy client upgraded');

      // Open the Chrome-side connection AFTER the client is upgraded so
      // Node has already consumed the upgrade request.
      // Use the same options as puppeteer-core's browser.connect() to avoid
      // Chrome's CSRF protection rejecting the WS upgrade.
      const chromeWs = new WebSocket(session.cdpEndpoint, {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024,
        headers: {
          Host: new URL(session.cdpEndpoint).host,
        },
      });

      const cleanup = () => {
        try { chromeWs.close(); } catch {}
        try { clientWs.close(); } catch {}
      };

      // Buffer client messages until chromeWs is open
      const pendingFromClient: Buffer[] = [];

      chromeWs.on('open', () => {
        logger.debug({ sessionId, cdp: session.cdpEndpoint }, 'CDP proxy chrome connected');
        // Flush any messages that arrived before chrome was ready
        for (const msg of pendingFromClient) {
          if (chromeWs.readyState === WebSocket.OPEN) chromeWs.send(msg);
        }
        pendingFromClient.length = 0;
      });

      clientWs.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        logger.debug(
          {
            sessionId,
            dataLen: Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : data.byteLength,
            isBinary,
            chromeState: chromeWs.readyState,
          },
          'CDP proxy client msg',
        );
        if (chromeWs.readyState === WebSocket.OPEN) {
          // CDP frames are binary; pass through as-is. Convert ArrayBuffer to Buffer.
          chromeWs.send(data, { binary: isBinary });
        } else {
          pendingFromClient.push(data as Buffer);
        }
      });

      chromeWs.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', () => {
        logger.debug({ sessionId }, 'CDP proxy client closed');
        cleanup();
      });

      chromeWs.on('close', (code, reason) => {
        logger.debug(
          { sessionId, code, reason: reason?.toString() || '' },
          'CDP proxy chrome closed',
        );
        cleanup();
      });

      clientWs.on('error', (err) => {
        logger.warn({ sessionId, error: err.message }, 'CDP proxy client error');
        cleanup();
      });

      chromeWs.on('error', (err) => {
        logger.warn({ sessionId, error: err.message }, 'CDP proxy chrome error');
        // Don't cleanup yet — client is already upgraded; if chrome fails,
        // close gracefully so client sees the failure.
        try { clientWs.close(1011, 'upstream error'); } catch {}
        try { chromeWs.close(); } catch {}
      });
    });
  };
}
