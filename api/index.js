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
// vidlink answers in several shapes depending on who asks. The browser gets a DASH stream
// (stream.playlist + CloudFront cookies, played through vidlink's "surge" proxy); some clients get
// mp4 "qualities" whose links the CDN rejects. We ask like a browser and prefer dash/hls.
const SURGE = 'https://surge.flooderrr.store';

// Same URL scheme vidlink's own player uses:
//   <surge>/<first label of cdn host><path>?host=<cdn origin>&sc=<base64(cookie header)>
function surgeDash(playlist, cookie) {
  const u = new URL(playlist);
  const label = u.hostname.split('.')[0];
  const sc = Buffer.from(cookie, 'utf8').toString('base64');
  return `${SURGE}/${label}${u.pathname}?host=${encodeURIComponent(u.origin)}&sc=${encodeURIComponent(sc)}`;
}

function playableFrom(o) {
  if (!o || typeof o.playlist !== 'string') return null;
  const ph = o.playlistHeaders || o.headers || {};
  const cookie = ph.Cookie || ph.cookie;
  const isDash = o.type === 'dash' || /\.mpd(\?|$)/i.test(o.playlist);
  if (isDash) {
    return { type: 'dash', url: (o.requiresProxy && cookie) ? surgeDash(o.playlist, cookie) : o.playlist };
  }
  return { type: 'hls', url: o.playlist };
}

function fileResult(s, wantedQuality) {
  if (!s?.qualities || typeof s.qualities !== 'object') return null;
  const qualities = {};
  for (const [k, v] of Object.entries(s.qualities)) {
    if (v && v.url) qualities[k] = { url: v.url, type: v.type, codec: v.codecName, size: v.size };
  }
  const keys = Object.keys(qualities).sort((a, b) => parseInt(b) - parseInt(a));
  if (!keys.length) return null;
  const pick = wantedQuality && qualities[wantedQuality] ? wantedQuality : keys[0];
  return { url: qualities[pick].url, type: 'file', quality: pick, qualities };
}

const VIDLINK_PROFILES = [
  pageUrl => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
    Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    Referer: pageUrl, Origin: ORIGIN,
    'sec-ch-ua': '"Chromium";v="158", "Not.A/Brand";v="24", "Google Chrome";v="158"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  }),
  pageUrl => ({
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
    Accept: '*/*', Referer: pageUrl, Origin: ORIGIN,
  }),
  () => ({ 'User-Agent': UA, Referer: REFERER, Origin: ORIGIN }),
];

// Returns:
//   dash -> { type:'dash', url:<surge mpd url>, captions }
//   hls  -> { type:'hls',  url }
//   file -> { type:'file', url, quality, qualities }   (last resort; CDN usually rejects these)
async function getStream(id, season, episode, wantedQuality) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;
  const pageUrl = season
    ? `https://vidlink.pro/tv/${id}/${season}/${episode || 1}`
    : `https://vidlink.pro/movie/${id}`;

  let fallback = null;
  let lastErr = null;
  for (let i = 0; i < VIDLINK_PROFILES.length; i++) {
    try {
      const res = await fetch(apiUrl, { headers: VIDLINK_PROFILES[i](pageUrl) });
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 300);
        lastErr = new Error(`vidlink API returned ${res.status}: ${txt}`);
        continue;
      }
      const data = await res.json();
      const s = data?.stream;
      const meta = { captions: s?.captions, ttl: s?.TTL, source: data?.sourceId, attempt: i + 1 };

      const direct = playableFrom(s);
      if (direct) return { ...direct, ...meta };

      // qualities that are themselves dash/hls entries
      if (s?.qualities && typeof s.qualities === 'object') {
        const entries = Object.entries(s.qualities)
          .map(([k, v]) => [k, playableFrom(v)]).filter(([, p]) => p);
        if (entries.length) {
          entries.sort((a, b) => parseInt(b[0]) - parseInt(a[0]));
          const pick = entries.find(([k]) => k === wantedQuality) || entries[0];
          return { ...pick[1], quality: pick[0], ...meta };
        }
      }

      const f = fileResult(s, wantedQuality);
      if (f && !fallback) fallback = { ...f, ...meta };
      if (!f) lastErr = new Error('Unknown response shape: ' + JSON.stringify(data).slice(0, 400));
    } catch (e) {
      lastErr = e;
    }
  }
  if (fallback) return fallback;
  throw lastErr || new Error('No stream found');
}

// ── Upstream fetcher with redirect + Range support ────────────────────────────
// Header sets are chosen per host. The MovieBox CDN (hakunaymatata.com) only serves requests whose
// Referer is a MovieBox site, so we try those in turn and remember the one that works.
const CDN_HOST_RE = /hakunaymatata\.com$/i;
const CDN_REFERERS = [
  'https://themoviebox.xyz/',
  'https://h5.aoneroom.com/',
  'https://moviebox.ph/',
  'https://videasy.net/',
];
let goodCdnReferer = null; // survives warm invocations

function headerSetsFor(url) {
  const base = { 'User-Agent': UA, Accept: '*/*' };
  let host = '';
  try { host = new URL(url).hostname; } catch (e) {}
  if (CDN_HOST_RE.test(host)) {
    const refs = goodCdnReferer
      ? [goodCdnReferer, ...CDN_REFERERS.filter(r => r !== goodCdnReferer)]
      : CDN_REFERERS;
    return [...refs.map(r => ({ ...base, Referer: r, Origin: r.replace(/\/$/, '') })), base];
  }
  return [
    { ...base, Referer: REFERER, Origin: ORIGIN },
    base,
    { Accept: '*/*' },
  ];
}

const RETRY_STATUS = new Set([401, 403, 428, 429]);

function fetchUpstream(url, range, mode = 0, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const sets = headerSetsFor(url);
    const headers = { ...sets[mode] };
    if (range) headers.Range = range;
    (url.startsWith('https') ? https : http).get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        res.resume();
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, range, mode, redirects + 1));
      }
      if (RETRY_STATUS.has(res.statusCode) && mode < sets.length - 1) {
        res.resume();
        return resolve(fetchUpstream(url, range, mode + 1, redirects));
      }
      if (res.statusCode < 400 && headers.Referer && CDN_REFERERS.includes(headers.Referer)) {
        goodCdnReferer = headers.Referer;
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

      // Upstream refused us: report the real reason instead of piping an HTML error page as "video"
      if (upstream.statusCode >= 400 && upstream.statusCode !== 416) {
        const chunks = []; let n = 0;
        for await (const c of upstream) { chunks.push(c); n += c.length; if (n > 2000) break; }
        upstream.destroy();
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          error: 'upstream ' + upstream.statusCode,
          contentType: ct,
          snippet: Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300)
        }));
      }
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
