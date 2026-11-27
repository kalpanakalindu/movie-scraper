'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  // if boot fails, allow a retry on the next request instead of caching the failure
  bootPromise.catch(() => { bootPromise = null; });
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
// Returns:
//   HLS source  -> { url, type: 'hls' }
//   MP4 source  -> { url, type: 'file', quality, qualities: { "360": {url,...}, ... } }
async function getStream(id, season, episode, wantedQuality) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 300);
    throw new Error(`vidlink API returned ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const s = data?.stream;

  // Old format: HLS playlist
  if (s?.playlist) return { url: s.playlist, type: 'hls', captions: s.captions };

  // New format: direct mp4 files per quality
  if (s?.qualities && typeof s.qualities === 'object') {
    const qualities = {};
    for (const [k, v] of Object.entries(s.qualities)) {
      if (v && v.url) {
        qualities[k] = { url: v.url, type: v.type, codec: v.codecName, size: v.size };
      }
    }
    const keys = Object.keys(qualities).sort((a, b) => parseInt(b) - parseInt(a));
    if (!keys.length) throw new Error('qualities was empty');
    const pick = wantedQuality && qualities[wantedQuality] ? wantedQuality : keys[0];
    return { url: qualities[pick].url, type: 'file', quality: pick, qualities, captions: s.captions };
  }

  throw new Error('Unknown response shape: ' + JSON.stringify(data).slice(0, 400));
}

// ── Upstream fetcher with redirect + Range support ────────────────────────────
function fetchUpstream(url, range, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const headers = { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = range;
    (url.startsWith('https') ? https : http).get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        res.resume();
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, range, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = q.url; // searchParams already decodes it
    try {
      const upstream = await fetchUpstream(url, req.headers.range);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        for (const h of ['content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        }
        if (!upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2   (optional &q=480 for mp4 quality)
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const out = await getStream(q.id, q.s, q.e, q.q);
    res.end(JSON.stringify(out));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
