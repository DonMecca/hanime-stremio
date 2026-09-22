/**
 * Small sticky rotating HTTP proxy pool for Hanime handshake only.
 *
 * Design goals:
 * - Do NOT fetch a fresh public proxy list on every stream request.
 * - Keep a short curated list of recently-verified free proxies.
 * - Prefer the last known-good proxy; on failure rotate to the next.
 *
 * Playback HLS still goes directly from the Stremio client to hanime.tv.
 * Only auth.hanime.tv handshake traffic uses these proxies (Cloudflare bypass).
 */

const DEFAULT_PROXIES = [
  // Ranked by latency in local probe (2026-07-23); HTTP 401 through auth.hanime.tv
  'http://64.112.184.210:3128',
  'http://37.59.125.131:8888',
  'http://91.98.86.26:8888',
  'http://109.120.184.202:1080',
  'http://159.195.49.27:8888',
  'http://181.39.25.196:8118',
  'http://103.167.61.162:3128',
  'http://146.103.43.35:3128'
];

function normalizeProxyUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || /^socks5h?:\/\//i.test(raw)) {
    return raw;
  }
  return `http://${raw}`;
}

function parseProxyList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map(normalizeProxyUrl)
    .filter(Boolean);
}

class HandshakeProxyPool {
  /**
   * @param {object} [options]
   * @param {string[]} [options.proxies]
   * @param {boolean} [options.enabled]
   */
  constructor(options = {}) {
    const fromEnv = parseProxyList(process.env.HANDSHAKE_HTTP_PROXIES);
    this.proxies = (options.proxies && options.proxies.length
      ? options.proxies
      : fromEnv.length
        ? fromEnv
        : DEFAULT_PROXIES
    )
      .map(normalizeProxyUrl)
      .filter(Boolean);

    this.enabled =
      options.enabled !== undefined
        ? Boolean(options.enabled)
        : process.env.HANDSHAKE_USE_PROXY !== 'false';

    this.preferredIndex = 0;
    this.cooldownUntil = new Map(); // proxyUrl -> timestamp ms
    this.cooldownMs = parseInt(process.env.HANDSHAKE_PROXY_COOLDOWN_MS, 10) || 5 * 60 * 1000;
  }

  isEnabled() {
    return this.enabled && this.proxies.length > 0;
  }

  size() {
    return this.proxies.length;
  }

  /**
   * Ordered candidates starting from sticky preferred, skipping cooldowns when possible.
   * @returns {string[]}
   */
  getRotationOrder() {
    if (!this.proxies.length) return [];

    const now = Date.now();
    const ordered = [];
    const n = this.proxies.length;

    for (let i = 0; i < n; i++) {
      const idx = (this.preferredIndex + i) % n;
      ordered.push(this.proxies[idx]);
    }

    const available = ordered.filter((p) => (this.cooldownUntil.get(p) || 0) <= now);
    // Prefer proxies that are not cooling down, but ALWAYS return a usable list.
    // Returning [] when everything is cooling left callers with only a direct
    // attempt, and Cloudflare blocks direct handshakes from Netlify — so streams
    // went silently empty. Retrying a cooling proxy is the better trade: the
    // caller's per-attempt timeout and overall budget bound the cost, and a
    // proxy is often only "cooling" because of a transient upstream error.
    return available.length ? available : ordered;
  }

  markSuccess(proxyUrl) {
    const idx = this.proxies.indexOf(proxyUrl);
    if (idx >= 0) {
      this.preferredIndex = idx;
    }
    this.cooldownUntil.delete(proxyUrl);
  }

  markFailure(proxyUrl) {
    if (!proxyUrl) return;
    this.cooldownUntil.set(proxyUrl, Date.now() + this.cooldownMs);
    // Advance sticky pointer so the next request starts on a different proxy
    const idx = this.proxies.indexOf(proxyUrl);
    if (idx >= 0) {
      this.preferredIndex = (idx + 1) % this.proxies.length;
    }
  }
}

HandshakeProxyPool.DEFAULT_PROXIES = DEFAULT_PROXIES;

module.exports = HandshakeProxyPool;
