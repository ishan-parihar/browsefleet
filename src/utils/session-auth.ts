import type { BrowserPool } from '../pool/browser-pool.js';
import type { BrowserSession } from '../pool/session.js';

/**
 * Gets a session only if it belongs to the requesting API key.
 * Throws an object with status + message for easy HTTP error responses.
 */
export function getOwnedSession(
  pool: BrowserPool,
  sessionId: string,
  apiKey: string | undefined,
): BrowserSession {
  const session = pool.getSession(sessionId);
  if (!session) {
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }
  if (session.apiKey && apiKey && session.apiKey !== apiKey) {
    // Return 404 to avoid leaking session existence
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }
  return session;
}
