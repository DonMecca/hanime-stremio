/**
 * Small sticky rotating HTTP proxy pool for Hanime handshake only.
 *
 * Design goals:
 * - Do NOT fetch a fresh public proxy list on every stream request.
 * - Keep a short curated list of recently-verified free proxies.
 * - Prefer the last known-good proxy; on failure rotate to the next.
 * - Self-heal: free proxies die constantly, so when the pool has no usable
 *   proxy it re-probes on the next request instead of retrying the same dead
 *   list forever. See refreshIfDegraded().
 *
 * Playback HLS still goes directly from the Stremio client to hanime.tv.
 * Only auth.hanime.tv handshake traffic uses these proxies (Cloudflare bypass).
 */

const logger = require('../logger');

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

/** Hard ceiling per proxy probe. axios's own timeout does not bound a proxied
 *  connect, so probing needs the race helper below. Generous on purpose: the one
 *  working free proxy answers in ~1.7s but occasionally spikes past 4.5s, and a
 *  probe that times out a healthy proxy would wrongly park it. */
const PROBE_TIMEOUT_MS = parseInt(process.env.HANDSHAKE_PROXY_PROBE_MS, 10) || 8000;
/** Total wall clock allowed for one refresh pass. A refresh only runs when the
 *  pool is already failing, so a bounded wait here is cheaper than the alternative
 *  (serially re-trying every dead proxy at its own timeout). */
const REFRESH_BUDGET_MS = parseInt(process.env.HANDSHAKE_PROXY_REFRESH_BUDGET_MS, 10) || 10000;
/** How long a proxy that fails a *probe* is deprioritised. Deliberately short:
 *  a probe is one flaky sample of an unreliable host, unlike a real handshake
 *  failure, so it must not exclude a working proxy for hours. */
const PROBE_PARK_MS = parseInt(process.env.HANDSHAKE_PROXY_PROBE_PARK_MS, 10) || 5 * 60 * 1000;
/** Minimum gap between refresh passes. */
const REFRESH_THROTTLE_MS = parseInt(process.env.HANDSHAKE_PROXY_REFRESH_MS, 10) || 10 * 60 * 1000;
/** Consecutive connection failures before a proxy is parked long-term. */
const DEAD_AFTER_FAILURES = parseInt(process.env.HANDSHAKE_PROXY_DEAD_AFTER, 10) || 3;
/** How long a repeatedly-failing proxy stays out of rotation. */
const DEAD_FOR_MS = parseInt(process.env.HANDSHAKE_PROXY_DEAD_MS, 10) || 6 * 60 * 60 * 1000;
/** Connection failures with no success since the last pass before we re-probe. */
const STRUGGLING_FAILURES = parseInt(process.env.HANDSHAKE_PROXY_STRUGGLING, 10) || 3;

/**
 * Public plain-text proxy list used to REPLENISH the pool.
 *
 * Re-probing the hardcoded DEFAULT_PROXIES can only tell us which of those eight
 * still work — it cannot replace them, and measured 2026-09-22 only one was left
 * (and it was intermittent). Fetching candidates is what makes the refresh real:
 * a 20-proxy sample of this list yielded 5 reachable hosts, fastest 48ms.
 *
 * Only auth.hanime.tv handshake traffic goes through these (free streams, no
 * account credentials), same trust level as the curated list. Set
 * HANDSHAKE_PROXY_SOURCE_URL=off to disable outbound fetching entirely.
 */
const SOURCE_URL =
  process.env.HANDSHAKE_PROXY_SOURCE_URL !== undefined
    ? process.env.HANDSHAKE_PROXY_SOURCE_URL
    : 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt';
/** How many listed candidates to probe per replenish pass. */
const CANDIDATE_SAMPLE = parseInt(process.env.HANDSHAKE_PROXY_CANDIDATES, 10) || 30;
/** Per-candidate probe timeout. Unknown hosts mostly fail fast or not at all. */
const CANDIDATE_PROBE_MS = parseInt(process.env.HANDSHAKE_PROXY_CANDIDATE_MS, 10) || 5000;
/** Upper bound on pool size, so rotation stays cheap. */
const MAX_POOL_SIZE = parseInt(process.env.HANDSHAKE_PROXY_MAX_POOL, 10) || 8;
/** Replenish when fewer than this many hosts are usable. */
const MIN_LIVE_TARGET = parseInt(process.env.HANDSHAKE_PROXY_MIN_LIVE, 10) || 2;

/** Race any promise against a hard deadline (axios cannot bound proxied connects). */
function hardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded hard timeout of ${ms}ms`)), ms);
    })
  ]);
}

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
    this.cooldownUntil = new Map(); // proxyUrl -> timestamp ms (short-term park)
    this.cooldownMs = parseInt(process.env.HANDSHAKE_PROXY_COOLDOWN_MS, 10) || 5 * 60 * 1000;

    // Health tracking so the pool can refresh itself and stop preferring dead hosts
    this.deadUntil = new Map(); // proxyUrl -> timestamp ms (long-term park)
    this.consecutiveFailures = new Map(); // proxyUrl -> count
    // Hosts we have SEEN answer (probe or real handshake). Distinct from
    // liveProxies(), which only means "not parked yet" and counts unverified
    // hosts as usable — the wrong basis for deciding to replenish.
    this.verifiedAlive = new Set();
    this.lastProbeAt = 0;
    this.lastProbeResult = null;
    this.probeInFlight = null;
    // Probe the exact host we need, so a pass proves real reachability.
    this.probeUrl =
      process.env.HANDSHAKE_PROXY_PROBE_URL || 'https://auth.hanime.tv/api/v11/handshake';
  }

  isEnabled() {
    return this.enabled && this.proxies.length > 0;
  }

  size() {
    return this.proxies.length;
  }

  /** Proxies not parked long-term. */
  liveProxies() {
    const now = Date.now();
    return this.proxies.filter((p) => (this.deadUntil.get(p) || 0) <= now);
  }

  hasLiveProxies() {
    return this.liveProxies().length > 0;
  }

  /** Is this proxy parked long-term (probe or repeated failure)? */
  isDead(proxyUrl) {
    return (this.deadUntil.get(proxyUrl) || 0) > Date.now();
  }

  health() {
    const now = Date.now();
    return {
      total: this.proxies.length,
      live: this.liveProxies().length,
      cooling: this.proxies.filter((p) => (this.cooldownUntil.get(p) || 0) > now).length,
      dead: this.proxies.filter((p) => (this.deadUntil.get(p) || 0) > now).length,
      lastProbeAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      lastProbeResult: this.lastProbeResult
    };
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

    // Rank healthy first, then short-term cooling, then long-term dead — but
    // ALWAYS return a usable list. Returning [] when everything was parked left
    // callers with only a direct attempt, and Cloudflare blocks direct handshakes
    // from Netlify, so streams silently went empty.
    return ordered.sort((a, b) => this._rank(a, now) - this._rank(b, now));
  }

  /** 0 = healthy, 1 = cooling, 2 = parked long-term. */
  _rank(proxyUrl, now) {
    if ((this.deadUntil.get(proxyUrl) || 0) > now) return 2;
    if ((this.cooldownUntil.get(proxyUrl) || 0) > now) return 1;
    return 0;
  }

  markSuccess(proxyUrl) {
    if (!proxyUrl) return;
    const idx = this.proxies.indexOf(proxyUrl);
    if (idx >= 0) {
      this.preferredIndex = idx;
    }
    this.cooldownUntil.delete(proxyUrl);
    this.deadUntil.delete(proxyUrl);
    this.consecutiveFailures.delete(proxyUrl);
    this.verifiedAlive.add(proxyUrl);
    this.successSinceRefresh = true;
  }

  markFailure(proxyUrl) {
    if (!proxyUrl) return;
    const now = Date.now();
    this.cooldownUntil.set(proxyUrl, now + this.cooldownMs);
    this.connectionFailuresSinceRefresh = (this.connectionFailuresSinceRefresh || 0) + 1;

    // Escalate: a proxy that keeps failing at the connection level is parked
    // long-term, so a permanently-dead host stops being tried every few minutes
    // (and refreshIfDegraded can replace it).
    const fails = (this.consecutiveFailures.get(proxyUrl) || 0) + 1;
    this.consecutiveFailures.set(proxyUrl, fails);
    if (fails >= DEAD_AFTER_FAILURES) {
      this.deadUntil.set(proxyUrl, now + DEAD_FOR_MS);
    }

    // Advance sticky pointer so the next request starts on a different proxy
    const idx = this.proxies.indexOf(proxyUrl);
    if (idx >= 0) {
      this.preferredIndex = (idx + 1) % this.proxies.length;
    }
  }

  /** Record that a probe found this proxy reachable. */
  markProbeAlive(proxyUrl, latencyMs) {
    if (!proxyUrl) return;
    this.deadUntil.delete(proxyUrl);
    this.cooldownUntil.delete(proxyUrl);
    this.consecutiveFailures.delete(proxyUrl);
    this._probeLatency = this._probeLatency || new Map();
    this._probeLatency.set(proxyUrl, latencyMs);
    this.verifiedAlive.add(proxyUrl);
  }

  /** Record that a probe found this proxy unreachable; deprioritises it briefly. */
  markProbeDead(proxyUrl) {
    if (!proxyUrl) return;
    // Short park only. A probe is a single flaky sample, and the pool frequently
    // has just one working host — parking it for hours on one bad sample would
    // take streaming down. Real handshake failures escalate separately.
    this.deadUntil.set(proxyUrl, Date.now() + PROBE_PARK_MS);
    this.verifiedAlive.delete(proxyUrl);
  }

  /**
   * Probe one proxy by requesting the exact host the handshake needs. ANY HTTP
   * response proves the tunnel works (the endpoint answers 401/404 to a bodyless
   * request), so only a connection-level failure counts as dead.
   */
  async probeProxy(proxyUrl, timeoutMs = PROBE_TIMEOUT_MS) {
    const axios = require('axios');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    const startedAt = Date.now();
    try {
      await hardTimeout(
        axios.get(this.probeUrl, {
          timeout: timeoutMs,
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          validateStatus: () => true,
          headers: {
            accept: 'application/json',
            origin: 'https://hanime.tv',
            referer: 'https://hanime.tv/',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }),
        timeoutMs + 500,
        `probe ${proxyUrl}`
      );
      return { proxyUrl, alive: true, ms: Date.now() - startedAt };
    } catch (error) {
      return {
        proxyUrl,
        alive: false,
        ms: Date.now() - startedAt,
        error: error.code || error.message
      };
    }
  }

  /**
   * Re-verify every known proxy and re-prefer the fastest reachable one.
   * Bounded by REFRESH_BUDGET_MS so it can be awaited on a request path.
   */
  /** Apply a probe outcome to pool health. */
  _applyProbeResult(r) {
    if (!r || !r.proxyUrl) return;
    if (r.alive) this.markProbeAlive(r.proxyUrl, r.ms);
    else this.markProbeDead(r.proxyUrl);
  }

  /**
   * Re-verify every known proxy and re-prefer the fastest reachable one.
   *
   * Resolves as soon as ANY proxy answers, rather than waiting for all eight:
   * with one live proxy and seven dead ones the full pass costs ~8s of timeouts,
   * and we only need to find one working host. Stragglers keep updating health in
   * the background. Bounded by REFRESH_BUDGET_MS so it is safe to await.
   */
  async probeAll() {
    const results = [];
    let onFirstAlive;
    const firstAlive = new Promise((resolve) => {
      onFirstAlive = resolve;
    });

    const tasks = this.proxies.map(async (proxyUrl) => {
      const r = await this.probeProxy(proxyUrl);
      results.push(r);
      this._applyProbeResult(r);
      if (r.alive) onFirstAlive(r);
      return r;
    });

    const allSettled = Promise.all(tasks);
    const budget = new Promise((resolve) => setTimeout(() => resolve(null), REFRESH_BUDGET_MS));

    await Promise.race([firstAlive, allSettled, budget]);

    // Let any remaining probes finish updating health without blocking the caller.
    allSettled
      .then((final) => {
        const live = final.filter((r) => r.alive).sort((a, b) => a.ms - b.ms);
        if (live.length) {
          const idx = this.proxies.indexOf(live[0].proxyUrl);
          if (idx >= 0) this.preferredIndex = idx;
        }
        this.successSinceRefresh = false;
        this.connectionFailuresSinceRefresh = 0;
      })
      .catch(() => {});

    const live = results.filter((r) => r.alive).sort((a, b) => a.ms - b.ms);
    if (live.length) {
      const idx = this.proxies.indexOf(live[0].proxyUrl);
      if (idx >= 0) this.preferredIndex = idx;
    }
    this.lastProbeResult = {
      probed: results.length,
      alive: live.length,
      fastestMs: live.length ? live[0].ms : null
    };
    return this.lastProbeResult;
  }

  /**
   * Fetch fresh candidates from the public list, probe them, and swap the dead
   * hosts out for the fastest reachable ones. This is what actually refreshes the
   * pool — re-probing the hardcoded list can only reveal that it is exhausted.
   */
  async replenishFromSource() {
    if (!SOURCE_URL || /^off$/i.test(String(SOURCE_URL).trim())) return null;

    let text;
    try {
      const axios = require('axios');
      const res = await hardTimeout(
        axios.get(SOURCE_URL, {
          timeout: 8000,
          responseType: 'text',
          transformResponse: [(d) => d]
        }),
        9000,
        'proxy list fetch'
      );
      text = res.data;
    } catch (error) {
      this.lastReplenishResult = { error: error.message };
      return this.lastReplenishResult;
    }

    const known = new Set(this.proxies);
    const candidates = parseProxyList(text)
      .filter((p) => !known.has(p))
      .slice(0, CANDIDATE_SAMPLE);
    if (!candidates.length) {
      this.lastReplenishResult = { tested: 0, alive: 0, added: 0 };
      return this.lastReplenishResult;
    }

    const results = await Promise.all(
      candidates.map((p) => this.probeProxy(p, CANDIDATE_PROBE_MS))
    );
    const good = results.filter((r) => r.alive).sort((a, b) => a.ms - b.ms);

    // Keep hosts we have not written off, then add the fastest new candidates.
    const keep = this.proxies.filter((p) => !this.isDead(p));
    const next = keep.slice();
    for (const r of good) {
      if (next.length >= MAX_POOL_SIZE) break;
      next.push(r.proxyUrl);
      this.markProbeAlive(r.proxyUrl, r.ms);
    }

    const added = next.length - keep.length;
    if (added > 0) {
      this.proxies = next;
      this.preferredIndex = Math.max(0, this.proxies.indexOf(good[0].proxyUrl));
      logger.info('Hanime proxy pool replenished', {
        tested: candidates.length,
        alive: good.length,
        added,
        poolSize: this.proxies.length
      });
    }

    this.lastReplenishResult = {
      tested: candidates.length,
      alive: good.length,
      added,
      poolSize: this.proxies.length
    };
    return this.lastReplenishResult;
  }

  /**
   * Called when the pool is degraded (no live proxy). Throttled, de-duplicated
   * across concurrent requests, and bounded — so a dead pool heals itself on the
   * next request instead of retrying the same dead list until someone edits the file.
   */
  async refreshIfDegraded({ force = false } = {}) {
    if (!this.isEnabled()) return null;

    // Degraded = nothing usable left, OR we have been failing with no success at
    // all since the last pass. That second condition is what catches a COLD pool:
    // every proxy starts out assumed-live, so hasLiveProxies() alone never fired
    // a refresh and the same dead list was retried indefinitely.
    const struggling =
      !this.hasLiveProxies() ||
      (!this.successSinceRefresh && (this.connectionFailuresSinceRefresh || 0) >= STRUGGLING_FAILURES);
    if (!force && !struggling) return null;

    const now = Date.now();
    if (now - this.lastProbeAt < REFRESH_THROTTLE_MS) return null;
    if (this.probeInFlight) return this.probeInFlight;

    this.lastProbeAt = now;
    this.probeInFlight = (async () => {
      const probed = await this.probeAll();
      // If re-probing the known hosts left us short, pull replacements.
      // Decide on VERIFIED hosts: right after a partial probe, unprobed hosts are
      // still "not parked" and would otherwise mask a nearly-empty pool.
      if (this.verifiedAlive.size < MIN_LIVE_TARGET) {
        const replenished = await this.replenishFromSource().catch(() => null);
        if (replenished && replenished.added) {
          return { ...probed, ...replenished };
        }
      }
      return probed;
    })().finally(() => {
      this.probeInFlight = null;
    });
    return this.probeInFlight;
  }
}

HandshakeProxyPool.DEFAULT_PROXIES = DEFAULT_PROXIES;

module.exports = HandshakeProxyPool;
