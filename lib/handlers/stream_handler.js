const { isHanimeId, stripAddonPrefix } = require('../utils/formatters');
const { toStremioStreams } = require('../transformers/stream_transformer');
const { cacheWrapStream } = require('../cache');
const { emptyResponse } = require('./response_helpers');
const HanimeWebApiClient = require('../clients/hanime_web_api_client');
const HanimeWatchPageClient = require('../clients/hanime_watch_page_client');

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

      return {
        ...streams,
        cacheMaxAge: this.config.cache.ttl.stream,
        staleRevalidate: 600
      };
    } catch (error) {
      this.logger.error('Stream handler error', {
        id: args.id,
        error: error.message,
        stack: error.stack
      });
      return emptyResponse('stream');
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

      const [streams, durationInMs] = await Promise.all([
        this.webApiClient.getStreamsForSlug(videoId),
        this.watchPageClient.getDurationInMs(videoId)
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
    });
  }
}

module.exports = StreamHandler;
