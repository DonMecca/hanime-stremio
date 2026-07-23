/**
 * Hanime watch-page enrichment
 *
 * The public search index and handshake sources omit duration/filesize.
 * Watch pages still expose ISO-8601 duration in schema.org JSON-LD, e.g.:
 *   "duration":"PT26M9S"
 *
 * Fetch is direct by default (works from Netlify). Optional proxy fallback
 * reuses the handshake proxy pool if Cloudflare challenges the HTML page.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../logger');
const HandshakeProxyPool = require('./handshake_proxy_pool');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // slug -> { durationInMs, expiresAt }

function parseIso8601Duration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const match = iso.trim().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseFloat(match[3] || '0');
  const ms = Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1000);
  return ms > 0 ? ms : null;
}

function extractDurationFromHtml(html) {
  if (!html) return null;

  // Prefer JSON-LD VideoObject duration
  const ldBlocks = String(html).match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];

  for (const block of ldBlocks) {
    const jsonText = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(jsonText);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        if (node && node.duration) {
          const ms = parseIso8601Duration(node.duration);
          if (ms) return ms;
        }
      }
    } catch (_) {
      // fall through to regex
    }
  }

  const regex = String(html).match(/"duration"\s*:\s*"(PT[^"]+)"/i);
  return regex ? parseIso8601Duration(regex[1]) : null;
}

class HanimeWatchPageClient {
  constructor(config = {}) {
    this.siteBase = config.api?.authority
      ? `https://${config.api.authority}`
      : 'https://hanime.tv';
    this.ttlMs = config.api?.watchPageDurationTtlMs || DEFAULT_TTL_MS;
    this.proxyPool = new HandshakeProxyPool({
      proxies: config.api?.handshakeProxies,
      enabled: config.api?.handshakeUseProxy !== false
    });
  }

  /**
   * @param {string} slug
   * @returns {Promise<number|null>} duration in milliseconds
   */
  async getDurationInMs(slug) {
    if (!slug) return null;

    const cached = cache.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.durationInMs;
    }

    const durationInMs = await this._fetchDuration(slug);
    cache.set(slug, {
      durationInMs,
      expiresAt: Date.now() + this.ttlMs
    });
    return durationInMs;
  }

  async _fetchDuration(slug) {
    const url = `${this.siteBase}/videos/hentai/${encodeURIComponent(slug)}`;
    const headers = {
      accept: 'text/html,application/xhtml+xml',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      referer: 'https://hanime.tv/'
    };

    // Direct first
    try {
      const response = await axios.get(url, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d]
      });

      if (response.status === 200) {
        const ms = extractDurationFromHtml(response.data);
        if (ms) {
          logger.debug('Watch-page duration resolved (direct)', { slug, durationInMs: ms });
          return ms;
        }
      } else {
        logger.warn('Watch-page duration direct fetch non-200', {
          slug,
          status: response.status
        });
      }
    } catch (error) {
      logger.warn('Watch-page duration direct fetch failed', {
        slug,
        error: error.message
      });
    }

    // Optional proxy fallback (same pool as handshake)
    if (!this.proxyPool.isEnabled()) {
      return null;
    }

    for (const proxyUrl of this.proxyPool.getRotationOrder().slice(0, 3)) {
      try {
        const agent = new HttpsProxyAgent(proxyUrl);
        const response = await axios.get(url, {
          headers,
          timeout: 15000,
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          validateStatus: () => true,
          responseType: 'text',
          transformResponse: [(d) => d]
        });

        if (response.status === 200) {
          const ms = extractDurationFromHtml(response.data);
          if (ms) {
            this.proxyPool.markSuccess(proxyUrl);
            logger.debug('Watch-page duration resolved (proxy)', {
              slug,
              proxyUrl,
              durationInMs: ms
            });
            return ms;
          }
        }

        this.proxyPool.markFailure(proxyUrl);
      } catch (error) {
        this.proxyPool.markFailure(proxyUrl);
        logger.debug('Watch-page duration proxy attempt failed', {
          slug,
          proxyUrl,
          error: error.message
        });
      }
    }

    return null;
  }
}

HanimeWatchPageClient.parseIso8601Duration = parseIso8601Duration;
HanimeWatchPageClient.extractDurationFromHtml = extractDurationFromHtml;

module.exports = HanimeWatchPageClient;
