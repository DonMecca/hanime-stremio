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

/**
 * Race any promise against a hard deadline. Needed for proxy requests because
 * axios's `timeout` does not bound the connect phase when an agent is supplied.
 */
function withHardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded hard timeout of ${ms}ms`)), ms);
    })
  ]);
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
        timeout: 8000,
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
        // A 200 that parses but has no duration is a definitive answer (the page
        // renders, the field is just absent). Rotating proxies cannot change it.
        logger.debug('Watch-page duration absent on a 200; not retrying via proxy', { slug });
        return null;
      }

      // Redirects (302) and 4xx mean the slug/page is not fetchable this way.
      // These are NOT proxy-fixable: the block is per-resource, not per-IP, so
      // retrying through dead free proxies only burned their full timeout each.
      if (response.status >= 300 && response.status < 500) {
        logger.debug('Watch-page duration: non-retryable status, skipping proxy fallback', {
          slug,
          status: response.status
        });
        return null;
      }

      logger.warn('Watch-page duration direct fetch non-200', {
        slug,
        status: response.status
      });
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

    // Bound the whole fallback. Free proxies are frequently dead and each stalled
    // attempt costs a full timeout, so this loop was the dominant cost on a page
    // whose duration is simply unavailable (measured: 225s for one slug before
    // this bound, versus ~50ms for a direct 200).
    const PROXY_ATTEMPTS = 2;
    const PROXY_TIMEOUT_MS = 4000;
    const PROXY_BUDGET_MS = 6000;
    const startedAt = Date.now();

    for (const proxyUrl of this.proxyPool.getRotationOrder().slice(0, PROXY_ATTEMPTS)) {
      if (Date.now() - startedAt > PROXY_BUDGET_MS) {
        logger.debug('Watch-page duration: proxy budget exhausted', { slug });
        break;
      }
      try {
        const agent = new HttpsProxyAgent(proxyUrl);
        // Hard-deadline the proxied fetch: axios's `timeout` does not cover the
        // connect phase for agent-supplied requests, so a dead proxy otherwise
        // stalls ~75s (measured) regardless of the value passed below.
        const response = await withHardTimeout(
          axios.get(url, {
            headers,
            timeout: PROXY_TIMEOUT_MS,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            validateStatus: () => true,
            responseType: 'text',
            transformResponse: [(d) => d]
          }),
          PROXY_TIMEOUT_MS + 1000,
          `watch-page via ${proxyUrl}`
        );

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
          // Parsed but duration absent — proxies cannot change that.
          this.proxyPool.markSuccess(proxyUrl);
          return null;
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
