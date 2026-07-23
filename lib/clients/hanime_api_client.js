/**
 * Hanime API Client
 * Encapsulates all HTTP communication with Hanime.tv APIs
 */

const axios = require('axios');
const logger = require('../logger');

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class HanimeApiClient {
  constructor(config) {
    this.authority = config.api.authority;
    this.defaultAuthority = config.api.defaultAuthority;
    this.searchUrl = config.api.searchUrl;
    this.searchIndexTtlMs = config.api.searchIndexTtlMs || 30 * 60 * 1000;
    this.itemsPerPage = config.pagination?.itemsPerPage || 48;
    this.baseUrl = `https://${this.authority}`;

    this.searchHeaders = {
      'accept': 'application/json, text/plain, */*',
      'origin': 'https://hanime.tv',
      'referer': 'https://hanime.tv/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // In-memory full catalog dump cache (new search API returns everything)
    this._searchIndex = null;
    this._searchIndexFetchedAt = 0;
    this._searchIndexPromise = null;

    // Note: This client is for public/unauthenticated API calls only
    // Authenticated requests (streams) are handled by StreamService using UserApiManager
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Get video data from API
   * @param {string} slug - Video slug/ID
   * @param {number} maxRetries - Maximum number of retries (default: 2)
   * @returns {Promise<Object|null>} Video data object or null
   */
  async getVideoData(slug, maxRetries = 2) {
    if (!slug) {
      logger.warn('getVideoData called without slug');
      return null;
    }

    // Prefer local search-index lookup — hanime.tv/api/v8/video is gone (404 SPA)
    const fromIndex = await this.findBySlugOrId(slug);
    if (fromIndex) {
      return { hentai_video: fromIndex };
    }

    const url = `${this.baseUrl}/api/v8/video?id=${slug}&`;

    try {
      return await this._retryRequest(
        async () => {
          const response = await axios.get(url, {
            headers: this._getVideoHeaders(this.authority)
          });

          logger.info('Video API request details', JSON.stringify({
            url,
            headers: this._getVideoHeaders(this.authority)
          }));

          if (response.status === 200 && response.data) {
            return response.data;
          }

          logger.warn('Hanime video API: no data', { slug, status: response.status });
          return null;
        },
        {
          operation: 'Video API',
          params: { slug }
        },
        maxRetries
      );
    } catch (error) {
      return null;
    }
  }

  /**
   * Find a single video by exact slug or numeric id from the search index
   * @param {string|number} slugOrId
   * @returns {Promise<Object|null>}
   */
  async findBySlugOrId(slugOrId) {
    const index = await this._getSearchIndex();
    if (!index.length) return null;

    const needle = String(slugOrId);
    return index.find(item => item.slug === needle || String(item.id) === needle) || null;
  }

  /**
   * Search for videos.
   * Hanime's public search endpoint now returns the full catalog as a JSON array.
   * Filtering, sorting, and pagination are applied locally.
   *
   * @param {Object} params - Search parameters
   * @param {number} maxRetries - Maximum number of retries (default: 2)
   * @returns {Promise<Array>} Array of video results
   */
  async search({
    query = '',
    tags = [],
    orderBy = 'created_at_unix',
    ordering = 'desc',
    page = 0,
    pageSize = null,
    all = false
  } = {}, maxRetries = 2) {
    try {
      const index = await this._retryRequest(
        () => this._getSearchIndex(true),
        {
          operation: 'Search API',
          params: { query, tagsCount: tags.length, page, all }
        },
        maxRetries
      );

      let results = this._filterResults(index, query, tags);
      results = this._sortResults(results, orderBy, ordering);

      if (all) {
        logger.debug('Hanime search API success', {
          resultsCount: results.length,
          mode: 'all'
        });
        return results;
      }

      const size = pageSize || this.itemsPerPage;
      const start = Math.max(0, (page || 0) * size);
      const pageResults = results.slice(start, start + size);

      logger.debug('Hanime search API success', {
        resultsCount: pageResults.length,
        totalFiltered: results.length,
        page,
        pageSize: size
      });

      return pageResults;
    } catch (error) {
      return [];
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Fetch (and cache) the full public search index
   * @private
   * @param {boolean} allowRefresh - When true, refresh if TTL expired
   * @returns {Promise<Array>}
   */
  async _getSearchIndex(allowRefresh = true) {
    const now = Date.now();
    const isFresh = this._searchIndex
      && (now - this._searchIndexFetchedAt) < this.searchIndexTtlMs;

    if (isFresh || (!allowRefresh && this._searchIndex)) {
      return this._searchIndex;
    }

    // Coalesce concurrent refreshes (important on Netlify cold starts)
    if (this._searchIndexPromise) {
      return this._searchIndexPromise;
    }

    this._searchIndexPromise = (async () => {
      const response = await axios.get(this.searchUrl, {
        headers: this.searchHeaders,
        timeout: 25000
      });

      if (response.status !== 200 || !response.data) {
        throw new Error(`Search index HTTP ${response.status}`);
      }

      let hits = response.data;
      // Legacy shape support, just in case
      if (!Array.isArray(hits) && hits.hits) {
        hits = typeof hits.hits === 'string' ? JSON.parse(hits.hits || '[]') : hits.hits;
      }

      if (!Array.isArray(hits)) {
        throw new Error('Search index response was not an array');
      }

      this._searchIndex = hits;
      this._searchIndexFetchedAt = Date.now();
      logger.info('Hanime search index refreshed', { count: hits.length });
      return hits;
    })();

    try {
      return await this._searchIndexPromise;
    } finally {
      this._searchIndexPromise = null;
    }
  }

  /**
   * Filter search index by query text and tags (AND)
   * @private
   */
  _filterResults(index, query, tags) {
    let results = index;

    const normalizedTags = (tags || [])
      .map(tag => String(tag).trim().toLowerCase())
      .filter(Boolean);

    if (normalizedTags.length > 0) {
      results = results.filter(item => {
        const itemTags = (item.tags || []).map(t => String(t).toLowerCase());
        return normalizedTags.every(tag => itemTags.includes(tag));
      });
    }

    const q = String(query || '').trim().toLowerCase();
    if (q) {
      results = results.filter(item => {
        const haystack = [
          item.name,
          item.slug,
          item.search_titles,
          item.brand,
          item.description
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return results;
  }

  /**
   * Sort results by a field
   * @private
   */
  _sortResults(results, orderBy, ordering) {
    const field = orderBy || 'created_at_unix';
    const direction = ordering === 'asc' ? 1 : -1;

    return [...results].sort((a, b) => {
      const av = a?.[field];
      const bv = b?.[field];

      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;

      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * direction;
      }

      return (av - bv) * direction;
    });
  }

  /**
   * Get headers for video API requests
   * @private
   */
  _getVideoHeaders(authority) {
    return {
      'authority': authority,
      'accept': 'application/json, text/plain, */*',
      'origin': 'https://hanime.tv',
      'if-none-match': 'W/"a5e2787805920a8145ce33ab7c0fd947"'
    };
  }

  /**
   * Sleep utility for retry delays
   * @private
   */
  async _sleep(ms) {
    return sleep(ms);
  }

  /**
   * Generic retry wrapper with exponential backoff for 403 errors
   * @private
   * @param {Function} requestFn - Async function to execute
   * @param {Object} context - Context for logging (operation name, params)
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise} Result of the request function
   */
  async _retryRequest(requestFn, context = {}, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`${context.operation} request`, {
          ...context.params,
          attempt: attempt + 1
        });

        return await requestFn();
      } catch (error) {
        const status = error.response?.status;

        if (status === 403 && attempt < maxRetries) {
          const backoffDelay = [2000, 5000, 10000][attempt] || 10000; // 2s, 5s, 10s
          const jitter = Math.random() * 1000; // Add 0-1s jitter
          const delay = backoffDelay + jitter;

          logger.debug(`${context.operation} 403, retrying with backoff`, {
            ...context.params,
            attempt: attempt + 1,
            delay: `${Math.round(delay)}ms`
          });

          await this._sleep(delay);
          continue;
        }

        if (status === 403) {
          logger.debug(`${context.operation} 403 (likely blocked)`, {
            ...context.params,
            attempt: attempt + 1
          });
        } else {
          logger.error(`${context.operation} error`, {
            ...context.params,
            error: error.message,
            status,
            attempt: attempt + 1
          });
        }

        throw error;
      }
    }
  }
}

module.exports = HanimeApiClient;
