# Hanime.tv Stremio Addon

[![Fly.io](https://img.shields.io/badge/Fly.io-hosting-unavailable?logo=fly.io&color=lightgrey)](#)

A Stremio addon for browsing and streaming content from Hanime.tv.

## Current API layout (2026)

| Surface | Endpoint | Auth needed? |
|---------|----------|--------------|
| Catalogs / search | `guest.freeanimehentai.net/api/v11/search_hvs` | No — Hanime’s own site uses this guest full-index dump |
| Free streams (≤720p) | WASM-signed `POST auth.hanime.tv/api/v11/handshake` | No account login |
| Premium 1080p | Same handshake **plus** logged-in session | Yes — Turnstile + CSRF login |

Credentials in the manifest are **optional** today (useful later for premium). They are **not** required for browsing or free playback.

### Hosting caveat

`auth.hanime.tv` Cloudflare-challenges many cloud IPs (including Netlify Functions). Catalogs work on Netlify; **streams must run from a residential/self-hosted IP or a non-blocked host** (Render/Docker/local).

## Quick Start

### Using Docker Compose (Recommended)

```bash
docker compose up -d
```

The addon will be accessible at `http://localhost:61327/manifest.json`

### Using Podman Compose

```bash
podman compose up -d
```

### Using Node.js Directly

```bash
npm install
npm start
```

## Deployed / Hosted Version Status

🚫 **Public hosted version is currently unavailable**

The addon is **no longer hosted publicly**.

Running this addon on Fly.io (or similar platforms) requires **paid plans with high and unpredictable costs** due to:

- Continuous traffic from Stremio clients
- Bandwidth-heavy streaming metadata requests
- Always-on server requirements

Because of this, maintaining a **free or public hosted instance is not financially sustainable**.

Stremio Addons page:
```
https://stremio-addons.net/addons/hanime
```
> **Note:** Issues with the deployed version may be caused by free hosting limitations or Hanime CDN blocking. For best performance, self-host using Docker.

## Installation in Stremio

1. Open Stremio
2. Go to Addons → Community Addons
3. Paste the manifest URL (local: `http://localhost:61327/manifest.json`)
4. Click "Install"

## Configuration

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `61327` | Server port |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |
| `CACHE_ENABLED` | `true` | Enable caching |
| `CACHE_MAX_SIZE` | `1000` | Maximum cache entries |
| `CACHE_BROWSER_CACHE` | `true` | Enable browser caching |
| `CACHE_REDIS_URL` | - | Redis connection URL for persistent cache |
| `CACHE_UPSTASH_REDIS_URL` | - | Upstash Redis URL for persistent cache |
| `CACHE_UPSTASH_REDIS_TOKEN` | - | Upstash Redis token for persistent cache |

See `docker-compose.yml` for all available options.

## Available Catalogs

- General catalog, Series, Recent, Most Likes, Most Views, Newest
- Search by name and filter by genre

## Troubleshooting

- **Thumbnails not loading**: Ensure `PUBLIC_URL` is set correctly
- **Catalogs empty on Netlify, streams empty**: Catalogs should work (guest search). Empty streams usually mean Cloudflare is challenging `auth.hanime.tv` from the host IP — run locally (`npm start`) or deploy to Render/Docker instead of Netlify Functions.
- **No streams locally**: Enable `LOG_LEVEL=debug` and check handshake errors
- **High memory**: Reduce `CACHE_MAX_SIZE`
- **Slow catalogs**: Increase `CACHE_MAX_SIZE` or adjust cache TTLs

## Credits

Forked from [mrcanelas/hanime-tv-addon](https://github.com/mrcanelas/hanime-tv-addon).

## License

MIT

## Disclaimer

This addon is for educational purposes only. Ensure you comply with local laws and Hanime.tv's terms of service when using this addon.
