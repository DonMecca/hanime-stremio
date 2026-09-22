const { isHanimeId, stripAddonPrefix } = require('../utils/formatters');
const { toStremioStreams } = require('../transformers/stream_transformer');
const { cacheWrapStream } = require('../cache');
const { emptyResponse } = require('./response_helpers');
const HanimeWebApiClient = require('../clients/hanime_web_api_client');
const HanimeWatchPageClient = require('../clients/hanime_watch_page_client');

// An empty stream list is a transient condition: the free proxy pool may just
// have rotated, or the handshake may have lost a race. Never let one such miss
// hold a slug empty for the full 36h stream TTL.
const EMPTY_RETRY_MAX_AGE_S = 60;
const DURATION_BUDGET_MS = 1500;

class StreamHandler {
  constructor(apiClient, logger, config, userApiManager) {
    this.logger = logger;
    this.config = config;
    this.userApiManager = userApiManager;
    this.apiClient = apiClient;
    this.webApiClient = new HanimeWebApiClient(config);
    this.watchPageClient = new HanimeWatchPageClient(config);
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  async handle(args) {
    try {
      const id = args.id;

      if (!id) {
        this.logger.warn('Stream handler called without ID');
        return emptyResponse('stream');
      }

      if (!isHanimeId(id)) {
        return emptyResponse('stream');
      }

      // Free streams use the public web handshake (WASM-signed).
      // Credentials remain accepted for future premium session support.
      const streams = await this._getStreams(id);

      const isEmpty = !Array.isArray(streams.streams) || streams.streams.length === 0;

      return {
        ...streams,
        cacheMaxAge: isEmpty ? EMPTY_RETRY_MAX_AGE_S : this.config.cache.ttl.stream,
        staleRevalidate: isEmpty ? 0 : 600
      };
    } catch (error) {
      this.logger.error('Stream handler error', {
        id: args.id,
        error: error.message,
        stack: error.stack
      });
      // Nothing was cached on this path (the throw propagates out of the cache
      // wrapper), and the short max age tells the client to try again shortly
      // rather than sit on an empty list.
      return {
        ...emptyResponse('stream'),
        cacheMaxAge: EMPTY_RETRY_MAX_AGE_S,
        staleRevalidate: 0
      };
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Extract video ID from stream request ID
   * @private
   */
  _extractVideoId(strippedId) {
    if (strippedId.startsWith('series:')) {
      const parts = strippedId.split(':');
      if (parts.length === 3) {
        this.logger.debug('Parsed series episode ID', { strippedId, videoId: parts[2] });
        return parts[2];
      }
      if (parts.length === 2) {
        return null;
      }
    }

    return strippedId;
  }

  /**
   * Get streams for a video or series episode via web handshake
   * @private
   */
  async _getStreams(id) {
    return cacheWrapStream(id, async () => {
      const strippedId = stripAddonPrefix(id);
      const videoId = this._extractVideoId(strippedId);

      if (!videoId) {
        this.logger.info('Stream requested for parent series ID - returning empty', {
          id,
          strippedId
        });
        return emptyResponse('stream');
      }

      // Duration is decoration on the stream cards. Start it in parallel but cap
      // how long it can hold the response back: a cold watch-page fetch used to
      // add seconds of dead time before any play option appeared.
      const durationPromise = this.watchPageClient
        .getDurationInMs(videoId)
        .catch(() => null);

      const streams = await this.webApiClient.getStreamsForSlug(videoId);

      const durationInMs = await Promise.race([
        durationPromise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), DURATION_BUDGET_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
        })
      ]);

      if (!streams || !Array.isArray(streams) || streams.length === 0) {
        this.logger.warn('Stream handler: no streams returned', {
          id,
          videoId
        });
        return emptyResponse('stream');
      }

      if (durationInMs) {
        for (const stream of streams) {
          stream.duration_in_ms = durationInMs;
        }
      }

      const cacheConfig = {
        maxAge: this.config.cache.browserCacheMaxAge,
        staleError: 6 * 30 * 24 * 60 * 60
      };

      const response = toStremioStreams(streams, cacheConfig);

      if (!response.streams || response.streams.length === 0) {
        return emptyResponse('stream');
      }

      return response;
    }, {
      // Metrics on what a *stored* empty result costs: 36h of "no streams" for a
      // slug whose only problem was a proxy that died mid-request.
      shouldCache: (value) => Array.isArray(value?.streams) && value.streams.length > 0
    });
  }
}

module.exports = StreamHandler;
