import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Validates a URL to prevent SSRF attacks.
 * Rejects non-HTTP(S) schemes and private/loopback/link-local IP addresses.
 */
export async function validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // If the hostname is already an IP, check it directly
  if (isIPv4(hostname) || isIPv6(hostname)) {
    assertNotPrivateIp(hostname);
    return;
  }

  // Resolve hostname and check the resulting IP
  try {
    const { address } = await lookup(hostname);
    assertNotPrivateIp(address);
  } catch (err: any) {
    if (err.message?.startsWith('Blocked')) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
  }
}

function assertNotPrivateIp(ip: string): void {
  if (isPrivateIp(ip)) {
    throw new Error(`Blocked request to private/reserved IP: ${ip}`);
  }
}

function isPrivateIp(ip: string): boolean {
  // IPv6
  if (ip === '::1') return true;
  if (ip.toLowerCase().startsWith('fd')) return true; // fd00::/8 unique local
  if (ip.toLowerCase().startsWith('fe80')) return true; // link-local

  // IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;

  const [a, b] = parts;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true;
  // 0.0.0.0
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;

  return false;
}
