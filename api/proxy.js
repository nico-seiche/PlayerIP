// Kleiner Pass-Through-Proxy für Xtream-API und Streams.
// Nötig, weil IPTV-Server meist kein CORS senden und oft nur http anbieten.
//
// Aufruf: /api/proxy?u=<ziel-url>&k=<ACCESS_KEY>
// Schutz: ACCESS_KEY (Env) ist Pflicht, private/lokale Ziele werden blockiert.

const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { timingSafeEqual } = require('node:crypto');

const MAX_REDIRECTS = 5;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertPublicTarget(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Nur http/https erlaubt');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('Ziel nicht erlaubt');
}

function keyOk(given) {
  const expected = process.env.ACCESS_KEY || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchFollow(startUrl, headers) {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicTarget(url);
    const res = await fetch(url, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error('Zu viele Weiterleitungen');
}

function proxify(target, key) {
  return `/api/proxy?u=${encodeURIComponent(target)}&k=${encodeURIComponent(key)}`;
}

function rewritePlaylist(text, baseUrl, key) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(new URL(uri, baseUrl).href, key)}"`);
      }
      return proxify(new URL(t, baseUrl).href, key);
    })
    .join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('Method not allowed');
    return;
  }
  if (!process.env.ACCESS_KEY) {
    res.status(500).send('ACCESS_KEY ist nicht konfiguriert');
    return;
  }
  const { u, k } = req.query;
  if (!keyOk(k)) {
    res.status(401).send('Zugriffsschlüssel ungültig');
    return;
  }

  let target;
  try {
    target = new URL(u);
  } catch {
    res.status(400).send('Ungültige URL');
    return;
  }

  // Manche Anbieter lassen nur bekannte IPTV-Clients zu; per Env UPSTREAM_USER_AGENT überschreibbar.
  const headers = { 'user-agent': process.env.UPSTREAM_USER_AGENT || 'IPTVSmartersPro', accept: '*/*' };
  if (req.headers.range) headers.range = req.headers.range;

  try {
    const { res: upstream, finalUrl } = await fetchFollow(target, headers);
    const type = upstream.headers.get('content-type') || '';
    const looksLikePlaylist = /mpegurl/i.test(type) || /\.m3u8?$/i.test(finalUrl.pathname);

    if (looksLikePlaylist && upstream.ok) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.status(200);
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.setHeader('cache-control', 'no-store');
        res.send(rewritePlaylist(text, finalUrl.href, k));
        return;
      }
      res.status(upstream.status);
      if (type) res.setHeader('content-type', type);
      res.send(text);
      return;
    }

    res.status(upstream.status);
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Proxy-Fehler: ${err.message}`);
    else res.destroy();
  }
};
