/**
 * Network utilities — shared SSRF protection and URL validation.
 *
 * Used by: WebFetchTool, plugin CapabilityBroker
 */

// ─── SSRF Protection ────────────────────────────────────

/**
 * Check if a URL targets a blocked address (localhost, RFC1918, link-local, metadata).
 * Returns a reason string if blocked, null if allowed.
 */
export function isBlockedUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return 'Invalid URL';
  }

  // Block non-HTTP(S) protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0'
  ) {
    return 'Blocked: localhost/loopback address';
  }

  // Block metadata endpoints (AWS, GCP, Azure)
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return 'Blocked: cloud metadata endpoint';
  }

  // Block RFC1918 private ranges and link-local
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, aStr, bStr] = ipMatch;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 10) return 'Blocked: private network (10.0.0.0/8)';
    if (a === 172 && b >= 16 && b <= 31) return 'Blocked: private network (172.16.0.0/12)';
    if (a === 192 && b === 168) return 'Blocked: private network (192.168.0.0/16)';
    if (a === 169 && b === 254) return 'Blocked: link-local address (169.254.0.0/16)';
    if (a === 0) return 'Blocked: invalid address (0.0.0.0/8)';
  }

  return null;
}
