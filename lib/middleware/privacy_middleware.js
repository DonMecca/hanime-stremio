'use strict';

/**
 * Anti-indexing + optional access gate for Stremio addons.
 *
 * Env:
 *   ADDON_ACCESS_SECRET   - if set, require secret via path /s/<secret>/...,
 *                           ?access_key=, or X-Addon-Access header
 *   CONFIGURE_PASSWORD    - if set, HTTP Basic Auth on HTML configure/landing pages only
 *                           (username can be anything; password must match)
 */

const ROBOTS_BODY = 'User-agent: *\nDisallow: /\n';

const HTML_PATHS = new Set(['/', '/configure', '/landing']);

function isExemptPath(pathname) {
  return (
    pathname === '/health' ||
    pathname === '/robots.txt' ||
    pathname === '/favicon.ico' ||
    pathname === '/sukebei-status'
  );
}

function isHtmlSurface(pathname) {
  if (HTML_PATHS.has(pathname)) return true;
  if (pathname.endsWith('/configure')) return true;
  if (pathname.startsWith('/admin')) return true;
  return false;
}

function extractSecret(req) {
  const header = req.get('x-addon-access') || req.get('x-access-key');
  if (header) return String(header).trim();

  const q = req.query || {};
  if (q.access_key) return String(q.access_key).trim();
  if (q.key) return String(q.key).trim();

  const parts = (req.path || '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) return parts[1];

  return null;
}

function stripSecretPrefix(req) {
  const parts = (req.url || '').split('?');
  const pathOnly = parts[0] || '';
  const qs = parts.length > 1 ? `?${parts.slice(1).join('?')}` : '';
  const segs = pathOnly.split('/').filter(Boolean);
  if (segs[0] === 's' && segs[1]) {
    const rest = '/' + segs.slice(2).join('/');
    req.url = (rest === '/' ? '/' : rest) + qs;
    // Keep Express path helpers consistent when available
    if (typeof req.path === 'string') {
      // path is derived from url in Express; rewriting url is enough for most routers
    }
  }
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  try {
    return require('crypto').timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function createNoIndexMiddleware() {
  return function noIndexMiddleware(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  };
}

function createRobotsHandler() {
  return function robotsHandler(_req, res) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.status(200).send(ROBOTS_BODY);
  };
}

/**
 * Optional full-API gate. When ADDON_ACCESS_SECRET is unset, this is a no-op.
 * Stremio-compatible: put secret in the install URL as /s/<secret>/manifest.json
 */
function createAccessSecretMiddleware(options = {}) {
  const secret = (options.secret || process.env.ADDON_ACCESS_SECRET || '').trim();
  const extraExempt = options.extraExemptPaths || [];

  return function accessSecretMiddleware(req, res, next) {
    if (!secret) return next();

    const pathname = (req.path || '/').split('?')[0];
    if (isExemptPath(pathname) || extraExempt.includes(pathname)) {
      return next();
    }

    // Allow secret-prefixed URLs through after strip
    const provided = extractSecret(req);
    if (provided && timingSafeEqualString(provided, secret)) {
      stripSecretPrefix(req);
      return next();
    }

    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.status(401).json({
      error: 'Unauthorized',
      hint: 'Set ADDON_ACCESS_SECRET and use /s/<secret>/manifest.json (or ?access_key=)'
    });
  };
}

/**
 * Optional Basic Auth for configure/landing HTML only.
 * Does not block Stremio catalog/stream JSON routes.
 */
function createConfigurePasswordMiddleware(options = {}) {
  const password = (options.password || process.env.CONFIGURE_PASSWORD || '').trim();

  return function configurePasswordMiddleware(req, res, next) {
    if (!password) return next();

    const pathname = (req.path || '/').split('?')[0];
    if (!isHtmlSurface(pathname)) return next();

    const header = req.get('authorization') || '';
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
        if (timingSafeEqualString(pass, password)) return next();
      } catch {
        // fall through
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Addon Configure"');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.status(401).send('Authentication required');
  };
}

module.exports = {
  ROBOTS_BODY,
  createNoIndexMiddleware,
  createRobotsHandler,
  createAccessSecretMiddleware,
  createConfigurePasswordMiddleware
};
