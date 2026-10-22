// Site Worker: serves the static assets and the 3D preview's data routes
// (MODELGEN_SPEC.md B4). Static files are answered by the assets layer before
// this runs; anything unmatched falls through to env.ASSETS.

import { MAPTERHORN_URL, OVERTURE_RELEASES, OVERTURE_TILES_URL, OVERTURE_THEMES } from '../src/preview/config.js';

const SITE_ORIGINS = ['https://polyplaces.co.uk', 'https://www.polyplaces.co.uk'];
const DSM_COVERAGE = '9ba4d5ac-d596-445a-9056-dae3ddec0178';
const DSM_URL = `https://environment.data.gov.uk/geoservices/datasets/${DSM_COVERAGE}/wcs`;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin && SITE_ORIGINS.includes(origin) ? origin : SITE_ORIGINS[0],
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag',
    Vary: 'Origin',
  };
}

// Upstream failures pass the status through with an empty body, never HTML.
function empty(status, request, extra = {}) {
  return new Response(null, { status, headers: { ...corsHeaders(request), ...extra } });
}

async function rateLimited(env, request) {
  if (!env.PREVIEW_LIMITER) return false;
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.PREVIEW_LIMITER.limit({ key });
  return !success;
}

// B4.1 Mapterhorn passthrough, z15 only.
async function tiles(request, ctx, z, x, y) {
  if (z !== '15') return empty(400, request);
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + `/api/tiles/${z}/${x}/${y}.webp`);
  const hit = await cache.match(key);
  if (hit) return withCors(hit, request);

  const upstream = await fetch(MAPTERHORN_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  let res;
  if (upstream.status === 200) {
    res = new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  } else if (upstream.status === 404) {
    res = new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } });
  } else {
    return empty(upstream.status, request);
  }
  ctx.waitUntil(cache.put(key, res.clone()));
  return withCors(res, request);
}

// B4.2 UK EA LiDAR DSM, Part A 5.4 request with a 2048 px cap.
async function dsm(request, ctx, params) {
  const vals = ['s', 'w', 'n', 'e'].map((k) => Number(params.get(k)));
  if (!vals.every(Number.isFinite)) return empty(400, request);
  const [s, w, n, e] = vals.map((v) => Math.round(v * 1e6) / 1e6);
  if (!(s < n && w < e) || n - s > 0.1 || e - w > 0.1) return empty(400, request);

  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + `/api/dsm?s=${s}&w=${w}&n=${n}&e=${e}`);
  const hit = await cache.match(key);
  if (hit) return withCors(hit, request);

  const lat = (s + n) / 2;
  const widthM = (e - w) * 111320 * Math.cos((lat * Math.PI) / 180);
  const heightM = (n - s) * 111320;
  const longer = Math.max(widthM, heightM);
  const crs = 'http://www.opengis.net/def/crs/EPSG/0/4326';
  const q = new URLSearchParams({
    service: 'WCS',
    version: '2.0.1',
    request: 'GetCoverage',
    coverageId: `${DSM_COVERAGE}__Lidar_Composite_Elevation_LZ_DSM_1m`,
    format: 'image/tiff',
    subsettingCrs: crs,
    outputCrs: crs,
  });
  q.append('subset', `Long(${w},${e})`);
  q.append('subset', `Lat(${s},${n})`);
  if (longer > 2048) q.append('scalefactor', String(2048 / longer));

  let upstream;
  try {
    upstream = await fetch(`${DSM_URL}?${q}`, { signal: AbortSignal.timeout(60000) });
  } catch (err) {
    return empty(err?.name === 'TimeoutError' ? 504 : 502, request);
  }
  const type = upstream.headers.get('Content-Type') || '';
  if (!upstream.ok || /xml|json|text/i.test(type)) return empty(204, request);

  const res = new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'image/tiff', 'Cache-Control': 'public, max-age=2592000' },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return withCors(res, request);
}

// B4.3 Overture PMTiles range proxy, used only when direct S3 access fails.
async function overture(request, ctx, theme, params) {
  if (!OVERTURE_THEMES.includes(theme)) return empty(404, request);
  const release = params.get('release') || OVERTURE_RELEASES[0];
  if (!OVERTURE_RELEASES.includes(release)) return empty(404, request);

  const range = request.headers.get('Range') || '';
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) return empty(416, request);
  const start = Number(m[1]), end = Number(m[2]);
  if (end < start || end - start + 1 > MAX_RANGE_BYTES) return empty(416, request);

  // The Cache API ignores Range, so each range gets its own synthetic key.
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + `/api/overture-pmtiles/${release}/${theme}/${start}-${end}`);
  const hit = await cache.match(key);
  if (hit) return withCors(toPartial(hit), request);

  const upstream = await fetch(OVERTURE_TILES_URL.replace('{release}', release).replace('{theme}', theme), {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (upstream.status !== 206) return empty(upstream.status === 200 ? 502 : upstream.status, request);

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Range': upstream.headers.get('Content-Range') || '',
    'Cache-Control': 'public, max-age=604800',
  };
  const etag = upstream.headers.get('ETag');
  if (etag) headers.ETag = etag;
  const body = await upstream.arrayBuffer();
  // Stored as a 200 (the Cache API refuses 206) and re-served as a 206.
  ctx.waitUntil(cache.put(key, new Response(body, { status: 200, headers })));
  return withCors(new Response(body, { status: 206, headers }), request);
}

function toPartial(res) {
  return new Response(res.body, { status: 206, headers: res.headers });
}

function withCors(res, request) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(request))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET') return empty(405, request);
    if (await rateLimited(env, request)) return empty(429, request);

    let m;
    if ((m = /^\/api\/tiles\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(path))) return tiles(request, ctx, m[1], m[2], m[3]);
    if (path === '/api/dsm') return dsm(request, ctx, url.searchParams);
    if ((m = /^\/api\/overture-pmtiles\/([a-z]+)$/.exec(path))) return overture(request, ctx, m[1], url.searchParams);
    return env.ASSETS.fetch(request);
  },
};
