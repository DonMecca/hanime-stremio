/**
 * Hanime Web API Client (v11)
 * Uses CSRF + WASM request signatures + encrypted /api/v11/handshake for streams.
 *
 * Notes:
 * - Public catalogs use guest.freeanimehentai.net search_hvs (handled elsewhere).
 * - Free streams work without account login.
 * - Premium 1080p still requires an authenticated session (Turnstile login) — not implemented here yet.
 * - Cloud hosts (Netlify/Render) are Cloudflare-challenged on auth.hanime.tv; handshake
 *   requests rotate through a small sticky HTTP proxy pool when needed.
 */

const crypto = require('crypto');
const axios = require('axios');
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
      timeout: 20000,
      validateStatus: () => true
    };

    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false;
    }

    const response = await axios.post(
      `${this.authApiBase}/api/v11/handshake`,
      { token },
      axiosConfig
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

    for (const attempt of attempts) {
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
        if (attempt.proxyUrl) {
          this.proxyPool.markFailure(attempt.proxyUrl);
        }
        errors.push(`${attempt.label}: ${error.message}`);
        logger.warn('Hanime handshake attempt failed', {
          slug,
          via: attempt.label,
          status: error.status,
          cloudflare: Boolean(error.cloudflare),
          error: error.message
        });
      }
    }

    throw new Error(`Handshake failed after ${attempts.length} attempt(s): ${errors.join(' | ')}`);
  }
}

module.exports = HanimeWebApiClient;
