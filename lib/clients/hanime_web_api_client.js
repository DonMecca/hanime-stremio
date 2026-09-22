/**
 * Hanime Web API Client (v11)
 * Uses CSRF + WASM request signatures + encrypted /api/v11/handshake for streams.
 *
 * Notes:
 * - Public catalogs use guest.freeanimehentai.net search_hvs (handled elsewhere).
 * - Free streams work without account login.
 * - Premium 1080p still requires an authenticated session (Turnstile login) — not implemented here yet.
 * - Cloud hosts (e.g. Netlify) are Cloudflare-challenged on auth.hanime.tv; handshake
 *   requests rotate through a small sticky HTTP proxy pool when needed.
 */

const crypto = require('crypto');
const axios = require('axios');

/**
 * Race any promise against a hard deadline.
 *
 * Required for proxy requests: axios's own `timeout` does NOT cover the connect
 * phase when an httpAgent/httpsAgent is supplied, so a dead free proxy stalls
 * for the OS-level TCP timeout instead. Measured 2026-09-22: timeout:6000 through
 * an unreachable proxy actually took 75013ms. This wrapper enforces the deadline
 * the caller asked for — the request may still linger in the background, but it
 * can no longer hold up the response.
 */
function withHardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded hard timeout of ${ms}ms`)),
        ms
      );
    })
  ]);
}
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../logger');
const { getSignatureHeaders } = require('./hanime_web_signer');
const HandshakeProxyPool = require('./handshake_proxy_pool');

const HANDSHAKE_KEY_MATERIAL = 'htv-insecure-handshake-v1';
const HANDSHAKE_AAD = 'htv-insecure-v1';

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function getHandshakeKey() {
  return crypto.createHash('sha256').update(HANDSHAKE_KEY_MATERIAL).digest();
}

function encryptHandshakePayload(payload) {
  const iv = crypto.randomBytes(12);
  const key = getHandshakeKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(HANDSHAKE_AAD, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const envelope = {
    v: 1,
    alg: 'AES-256-GCM',
    iv: b64urlEncode(iv),
    tag: b64urlEncode(tag),
    data: b64urlEncode(encrypted)
  };
  return b64urlEncode(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

function decryptHandshakeToken(token) {
  const envelope = JSON.parse(b64urlDecode(token).toString('utf8'));
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getHandshakeKey(),
    b64urlDecode(envelope.iv)
  );
  decipher.setAAD(Buffer.from(HANDSHAKE_AAD, 'utf8'));
  decipher.setAuthTag(b64urlDecode(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(b64urlDecode(envelope.data)),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

function isCloudflareChallenge(status, data) {
  if (status !== 403 && status !== 503) return false;
  const text = typeof data === 'string' ? data : JSON.stringify(data || '');
  return /just a moment|cloudflare|cf-browser-verification|Enable JavaScript/i.test(text);
}

class HanimeWebApiClient {
  constructor(config = {}) {
    this.authApiBase = config.api?.authApiBase || 'https://auth.hanime.tv';
    this.csrfUrl = config.api?.csrfUrl || 'https://ct.hanime.tv/csrf-token';
    this.hlsBase = config.api?.hlsBase || 'https://hanime.tv';
    this.csrfToken = null;
    this.csrfExpiresAt = 0;
    this.proxyPool = new HandshakeProxyPool({
      proxies: config.api?.handshakeProxies,
      enabled: config.api?.handshakeUseProxy
    });
  }

  async getCsrfToken(force = false) {
    const now = Date.now();
    if (!force && this.csrfToken && now < this.csrfExpiresAt - 30_000) {
      return this.csrfToken;
    }

    try {
      const response = await axios.get(this.csrfUrl, {
        timeout: 15000,
        headers: {
          accept: 'application/json',
          origin: 'https://hanime.tv',
          referer: 'https://hanime.tv/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        validateStatus: () => true
      });

      if (response.status === 200 && response.data?.csrf_token) {
        this.csrfToken = response.data.csrf_token;
        this.csrfExpiresAt =
          (response.data.csrf_token_expires_at || 0) * 1000 || now + 10 * 60 * 1000;
        return this.csrfToken;
      }

      logger.warn('CSRF token unavailable; continuing with WASM signature only', {
        status: response.status
      });
      return null;
    } catch (error) {
      logger.warn('CSRF token request failed; continuing with WASM signature only', {
        error: error.message
      });
      return null;
    }
  }

  async buildAuthHeaders() {
    // Skip CSRF on cloud — ct.hanime.tv is also CF-challenged there; signatures are enough.
    const [csrf, sig] = await Promise.all([
      process.env.HANDSHAKE_SKIP_CSRF === 'true' ? null : this.getCsrfToken(),
      getSignatureHeaders()
    ]);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: 'https://hanime.tv',
      referer: 'https://hanime.tv/',
      'user-agent': sig.userAgent,
      'x-signature-version': 'web2',
      'x-signature': sig.signature,
      'x-time': String(sig.time)
    };

    if (csrf) {
      headers['x-csrf-token'] = csrf;
    }

    return headers;
  }

  _mapSourcesToStreams(sources) {
    return sources
      .filter((source) => source && source.kind === 'normal' && source.src)
      .map((source) => {
        const src = String(source.src);
        const url = src.startsWith('http') ? src : `${this.hlsBase}${src}`;
        return {
          url,
          height: source.height || 0,
          width: source.width || 0,
          duration_in_ms: 0,
          filesize_mbs: 0,
          mime_type: source.type || 'application/x-mpegURL',
          extension: 'm3u8',
          video_stream_group_id: `hls-${source.label || source.height || 'sd'}`,
          is_guest_allowed: true,
          is_member_allowed: true,
          is_premium_allowed: false,
          is_downloadable: false
        };
      })
      .sort((a, b) => (b.height || 0) - (a.height || 0));
  }

  async _postHandshake(slug, headers, proxyUrl = null) {
    const token = encryptHandshakePayload({
      timestamp_unix: Math.floor(Date.now() / 1000),
      directive: 'htv_player_handshake',
      slug
    });

    const axiosConfig = {
      headers,
      // Per-attempt timeout for proxy attempts. Kept well under the overall
      // rotation budget below so several proxies can actually be tried; a dead
      // free proxy fails fast (ECONNREFUSED/timeout) rather than needing 20s.
      timeout: proxyUrl ? 6000 : 15000,
      validateStatus: () => true
    };

    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false;
    }

    // Hard deadline: axios's `timeout` is unreliable for proxied connects, so
    // this is what actually bounds a dead proxy (see withHardTimeout above).
    const attemptTimeoutMs = proxyUrl ? 6000 : 15000;
    const response = await withHardTimeout(
      axios.post(`${this.authApiBase}/api/v11/handshake`, { token }, axiosConfig),
      attemptTimeoutMs,
      proxyUrl ? `handshake via ${proxyUrl}` : 'handshake (direct)'
    );

    return response;
  }

  _decodeHandshakeResponse(response) {
    if (response.status !== 200) {
      const err = new Error(`Handshake failed (${response.status})`);
      err.status = response.status;
      err.data = response.data;
      err.cloudflare = isCloudflareChallenge(response.status, response.data);
      throw err;
    }

    const xToken = response.headers['x-token'];
    if (!xToken) {
      throw new Error('Handshake response missing x-token');
    }

    let decoded;
    try {
      decoded = JSON.parse(decryptHandshakeToken(xToken));
    } catch (error) {
      throw new Error(`Failed to decrypt handshake token: ${error.message}`);
    }

    const sources = Array.isArray(decoded.sources) ? decoded.sources : [];
    return this._mapSourcesToStreams(sources);
  }

  async _getStreamsViaProxy(proxyUrl, slug) {
    const url = proxyUrl.replace(/\/$/, '') + '/handshake';
    const response = await axios.post(
      url,
      { slug },
      {
        timeout: 25000,
        headers: {
          'content-type': 'application/json',
          ...(process.env.HANDSHAKE_PROXY_SECRET
            ? { 'x-proxy-secret': process.env.HANDSHAKE_PROXY_SECRET }
            : {})
        },
        validateStatus: () => true
      }
    );

    if (response.status !== 200 || !Array.isArray(response.data?.streams)) {
      logger.error('Handshake sidecar failed', {
        slug,
        status: response.status,
        data: response.data
      });
      throw new Error(`Handshake sidecar failed (${response.status})`);
    }

    return response.data.streams;
  }

  /**
   * Resolve playable streams for a video slug via /api/v11/handshake
   * @param {string} slug
   * @returns {Promise<Array>} streams in the shape expected by stream_transformer
   */
  async getStreamsForSlug(slug) {
    if (!slug) return [];

    // Optional dedicated sidecar (home tunnel / paid proxy service)
    const sidecarUrl = process.env.HANDSHAKE_PROXY_URL;
    if (sidecarUrl) {
      return this._getStreamsViaProxy(sidecarUrl, slug);
    }

    const headers = await this.buildAuthHeaders();
    const tryDirectFirst = process.env.HANDSHAKE_DIRECT_FIRST === 'true';
    const errors = [];

    // Self-heal / verify the pool BEFORE building the rotation order.
    // - Fresh instance (never probed): probe up front. The shipped list is mostly
    //   dead, so a blind first attempt usually costs a full connect timeout; a
    //   bounded probe finds the live host instead (~1.7s vs ~6s wasted).
    // - Otherwise only when degraded (no success and repeated connection failures).
    // Throttled between passes and bounded, so it cannot become the latency problem.
    if (this.proxyPool.isEnabled()) {
      try {
        const coldStart = !this.proxyPool.lastProbeAt;
        const refreshed = await this.proxyPool.refreshIfDegraded({ force: coldStart });
        if (refreshed) {
          logger.info('Hanime handshake: proxy pool verified', {
            slug,
            coldStart,
            ...refreshed
          });
        }
      } catch (error) {
        logger.warn('Hanime handshake: proxy refresh failed', {
          slug,
          error: error.message
        });
      }
    }

    const attempts = [];
    if (tryDirectFirst) {
      attempts.push({ proxyUrl: null, label: 'direct' });
    }
    if (this.proxyPool.isEnabled()) {
      for (const proxyUrl of this.proxyPool.getRotationOrder()) {
        attempts.push({ proxyUrl, label: proxyUrl });
      }
    }
    if (!attempts.length) {
      attempts.push({ proxyUrl: null, label: 'direct' });
    }

    // Bound the whole rotation. Free proxies go dead in batches — measured
    // 2026-09-22, all eight were unreachable and the unbounded loop stalled for
    // 301 seconds on a single stream request (each attempt paying a full
    // connect timeout). A hard budget keeps a dead pool a slow-but-finite
    // failure instead of an apparent hang.
    // Overall rotation budget. With a verified-live host ordered first, a working
    // request finishes in ~1-2s, so this mostly bounds the failure case: a doomed
    // request returns in ~15s instead of the ~32s it could reach at 20s.
    const PROXY_BUDGET_MS = Number(process.env.HANDSHAKE_PROXY_BUDGET_MS) || 15000;
    const startedAt = Date.now();
    let attempted = 0;

    let probeTriggered = false;
    for (const attempt of attempts) {
      // NOTE: do NOT skip proxies parked as dead. Ranking already tries live ones
      // first, and skipping caused "Handshake failed after 0 attempt(s)" whenever a
      // (possibly flaky) probe pass had parked everything — an outage in which we
      // never even attempted a request.
      if (attempted > 0 && Date.now() - startedAt > PROXY_BUDGET_MS) {
        errors.push(`budget exhausted after ${attempted} attempt(s) in ${Date.now() - startedAt}ms`);
        logger.warn('Hanime handshake: proxy budget exhausted', {
          slug,
          attempted,
          elapsedMs: Date.now() - startedAt
        });
        break;
      }
      attempted += 1;
      try {
        const response = await this._postHandshake(slug, headers, attempt.proxyUrl);
        const streams = this._decodeHandshakeResponse(response);

        if (attempt.proxyUrl) {
          this.proxyPool.markSuccess(attempt.proxyUrl);
        }

        logger.info('Hanime handshake streams resolved', {
          slug,
          via: attempt.label,
          streamsCount: streams.length,
          resolutions: streams.map((s) => `${s.height}p`).join(', ')
        });

        return streams;
      } catch (error) {
        // Distinguish "proxy is broken" from "the origin answered but rejected us".
        // _decodeHandshakeResponse sets `status` when it RECEIVED an HTTP response,
        // which means the proxy connected successfully and the origin replied —
        // the proxy is healthy. Marking those as failures evicted working proxies
        // (all 8 were wrongly cooling down), and combined with the pool returning
        // [] that left only the direct attempt, which Cloudflare blocks from
        // Netlify — so streams silently went empty.
        const receivedHttpResponse = Boolean(error.status);
        if (attempt.proxyUrl && !receivedHttpResponse) {
          this.proxyPool.markFailure(attempt.proxyUrl);
        }

        errors.push(`${attempt.label}: ${error.message}`);
        logger.warn('Hanime handshake attempt failed', {
          slug,
          via: attempt.label,
          status: error.status,
          cloudflare: Boolean(error.cloudflare),
          proxyHealthy: receivedHttpResponse,
          error: error.message
        });

        // A clean 401/404 is the ORIGIN's verdict on this request (bad signature /
        // no such video). Rotating to another proxy cannot change it, so stop
        // instead of burning the whole budget repeating the same answer.
        if (receivedHttpResponse && !error.cloudflare && (error.status === 401 || error.status === 404)) {
          logger.warn('Hanime handshake: definitive origin response, stopping rotation', {
            slug,
            status: error.status
          });
          break;
        }

        // First connection-level failure means we guessed the wrong proxy.
        // Re-probe once so the remaining iterations skip known-dead hosts instead
        // of each paying a full timeout.
        if (!receivedHttpResponse && !probeTriggered) {
          probeTriggered = true;
          try {
            const refreshed = await this.proxyPool.refreshIfDegraded({ force: true });
            if (refreshed) {
              logger.info('Hanime handshake: pool refreshed mid-rotation', { slug, ...refreshed });
            }
          } catch (refreshError) {
            logger.debug('Hanime handshake: mid-rotation refresh failed', {
              error: refreshError.message
            });
          }
        }
      }
    }

    throw new Error(`Handshake failed after ${attempted} attempt(s): ${errors.join(' | ')}`);
  }
}

module.exports = HanimeWebApiClient;
