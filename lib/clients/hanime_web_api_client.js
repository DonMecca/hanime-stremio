/**
 * Hanime Web API Client (v11)
 * Uses CSRF + WASM request signatures + encrypted /api/v11/handshake for streams.
 *
 * Notes:
 * - Public catalogs use guest.freeanimehentai.net search_hvs (handled elsewhere).
 * - Free streams work without account login.
 * - Premium 1080p still requires an authenticated session (Turnstile login) — not implemented here yet.
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../logger');
const { getSignatureHeaders } = require('./hanime_web_signer');

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

class HanimeWebApiClient {
  constructor(config = {}) {
    this.authApiBase = config.api?.authApiBase || 'https://auth.hanime.tv';
    this.csrfUrl = config.api?.csrfUrl || 'https://ct.hanime.tv/csrf-token';
    this.hlsBase = config.api?.hlsBase || 'https://hanime.tv';
    this.csrfToken = null;
    this.csrfExpiresAt = 0;
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
    const [csrf, sig] = await Promise.all([this.getCsrfToken(), getSignatureHeaders()]);
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

  /**
   * Resolve playable streams for a video slug via /api/v11/handshake
   * @param {string} slug
   * @returns {Promise<Array>} streams in the shape expected by stream_transformer
   */
  async getStreamsForSlug(slug) {
    if (!slug) return [];

    const headers = await this.buildAuthHeaders();
    const token = encryptHandshakePayload({
      timestamp_unix: Math.floor(Date.now() / 1000),
      directive: 'htv_player_handshake',
      slug
    });

    const response = await axios.post(
      `${this.authApiBase}/api/v11/handshake`,
      { token },
      {
        headers,
        timeout: 20000,
        validateStatus: () => true
      }
    );

    if (response.status !== 200) {
      logger.error('Hanime handshake failed', {
        slug,
        status: response.status,
        data: response.data
      });
      throw new Error(`Handshake failed (${response.status})`);
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
    const streams = sources
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

    logger.info('Hanime handshake streams resolved', {
      slug,
      streamsCount: streams.length,
      resolutions: streams.map((s) => `${s.height}p`).join(', ')
    });

    return streams;
  }
}

module.exports = HanimeWebApiClient;
