'use strict';

// Relay for vidlink's "surge" proxy:  /api/surge/<path>?<query>  ->  https://surge.flooderrr.store/<path>?<query>
// Surge only answers requests that look like they come from vidlink.pro, and a browser on another site
// can't send that Referer, so we send it from here. Also used for every segment of the DASH stream.

const https = require('https');

const SURGE_HOST = 'surge.flooderrr.store';
const REFERER = 'https://vidlink.pro/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const u = new URL(req.url, 'http://localhost');
  const rest = u.pathname.replace(/^\/api\/surge\/?/, '');
  // Vercel may add the dynamic route segment as ?path=...; drop it, keep everything else byte-for-byte
  const search = u.search.replace(/^\?/, '').split('&').filter(p => p && !/^path=/.test(p)).join('&');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  const headers = { 'User-Agent': UA, Referer: REFERER, Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;

  const up = https.request(
    { host: SURGE_HOST, path: '/' + rest + (search ? '?' + search : ''), method: 'GET', headers },
    r => {
      const ct = (r.headers['content-type'] || '').toLowerCase();

      if (r.statusCode >= 400 && r.statusCode !== 416) {
        const chunks = []; let n = 0;
        r.on('data', c => { if (n < 2000) { chunks.push(c); n += c.length; } });
        r.on('end', () => {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: 'surge ' + r.statusCode, contentType: ct,
            snippet: Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300),
          }));
        });
        return;
      }

      const isMpd = ct.includes('dash+xml') || /\.mpd$/i.test(u.pathname);
      if (isMpd) {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          // keep any absolute surge links pointing back through this relay
          const body = Buffer.concat(chunks).toString('utf8')
            .replace(/https?:\/\/surge\.flooderrr\.store/g, base + '/api/surge');
          res.statusCode = r.statusCode;
          res.setHeader('Content-Type', ct || 'application/dash+xml');
          res.end(body);
        });
        return;
      }

      res.statusCode = r.statusCode;
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        if (r.headers[h]) res.setHeader(h, r.headers[h]);
      }
      r.pipe(res);
    }
  );
  up.on('error', e => { res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: e.message })); });
  up.end();
};
