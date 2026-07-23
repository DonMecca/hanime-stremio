/**
 * Stream Transformer
 * Transforms Hanime streams to Stremio format
 */

/**
 * Build the right-side stream description shown in Stremio's stream picker.
 * Omit size/duration when unknown (handshake sources do not include them).
 * @param {Object} stream
 * @returns {string}
 */
function buildStreamTitle(stream) {
  const parts = ['HLS'];

  if (stream.filesize_mbs && Number(stream.filesize_mbs) > 0) {
    parts.push(`💾 ${Number(stream.filesize_mbs).toFixed(0)} MB`);
  }

  if (stream.duration_in_ms && Number(stream.duration_in_ms) > 0) {
    const durationMin = Math.round(Number(stream.duration_in_ms) / 60000);
    parts.push(`⌚ ${durationMin} min`);
  }

  return parts.join('\n ');
}

/**
 * Transform Hanime stream to Stremio stream object
 * @param {Object} stream - Hanime stream object
 * @returns {Object} Stremio stream object
 */
function toStremioStream(stream) {
  if (!stream || !stream.url) return null;

  const height = stream.height || 0;

  return {
    name: `Hanime.TV\n${height}p`,
    title: buildStreamTitle(stream),
    url: stream.url
  };
}

/**
 * Transform array of Hanime streams to Stremio streams
 * @param {Array} hanimeStreams - Array of Hanime stream objects
 * @param {Object} cacheConfig - Cache configuration
 * @returns {Object} Stremio streams response
 */
function toStremioStreams(hanimeStreams, cacheConfig) {
  if (!Array.isArray(hanimeStreams)) {
    return { streams: [] };
  }

  const streams = hanimeStreams
    .map((stream) => toStremioStream(stream))
    .filter((stream) => stream?.url?.trim());

  return {
    streams: streams,
    cacheMaxAge: cacheConfig.maxAge,
    staleError: cacheConfig.staleError
  };
}

module.exports = {
  toStremioStream,
  toStremioStreams,
  buildStreamTitle
};
