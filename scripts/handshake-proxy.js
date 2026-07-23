#!/usr/bin/env node
/**
 * Tiny residential handshake sidecar for cloud-hosted Stremio addons.
 *
 * Cloud hosts (Netlify/Render) get Cloudflare-challenged on auth.hanime.tv.
 * Run this on a home/residential IP and point HANDSHAKE_PROXY_URL at it
 * (via cloudflared quick tunnel or a named tunnel).
 *
 *   PORT=61328 node scripts/handshake-proxy.js
 *   cloudflared tunnel --url http://127.0.0.1:61328
 */
const express = require('express');
const HanimeWebApiClient = require('../lib/clients/hanime_web_api_client');
const config = require('../lib/config');

const port = parseInt(process.env.PORT, 10) || 61328;
const secret = process.env.HANDSHAKE_PROXY_SECRET || null;
const client = new HanimeWebApiClient(config);
const app = express();

app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, role: 'hanime-handshake-proxy' });
});

app.post('/handshake', async (req, res) => {
  try {
    if (secret && req.get('x-proxy-secret') !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const slug = String(req.body?.slug || '').trim();
    if (!slug) {
      return res.status(400).json({ error: 'slug required' });
    }

    const streams = await client.getStreamsForSlug(slug);
    return res.json({ streams });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'handshake failed' });
  }
});

app.listen(port, () => {
  console.log(`Hanime handshake proxy on http://127.0.0.1:${port}`);
});
