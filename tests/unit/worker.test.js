import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../worker/index.js';
import { OVERTURE_RELEASES } from '../../src/preview/config.js';

const ORIGIN = 'https://polyplaces.co.uk';

let cache;
let upstream;

function makeEnv({ limited = false } = {}) {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('asset', { status: 200 })) },
    PREVIEW_LIMITER: { limit: vi.fn(async () => ({ success: !limited })) },
  };
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
}

function req(path, init = {}) {
  return new Request(`https://polyplaces.co.uk${path}`, init);
}

beforeEach(() => {
  const store = new Map();
  cache = {
    match: vi.fn(async (r) => {
      const hit = store.get(r.url);
      return hit ? hit.clone() : undefined;
    }),
    put: vi.fn(async (r, res) => { store.set(r.url, res); }),
  };
  vi.stubGlobal('caches', { default: cache });
  upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => vi.unstubAllGlobals());

async function call(path, init, env = makeEnv()) {
  const ctx = makeCtx();
  const res = await worker.fetch(req(path, init), env, ctx);
  await Promise.all(ctx.pending);
  return { res, env };
}

describe('routing', () => {
  it('passes non-API paths to the assets binding', async () => {
    const { res, env } = await call('/store/');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    expect(await res.text()).toBe('asset');
    expect(env.PREVIEW_LIMITER.limit).not.toHaveBeenCalled();
  });

  it('passes unknown /api/ paths to the assets binding', async () => {
    const { env } = await call('/api/unknown');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it('answers CORS preflight', async () => {
    const { res } = await call('/api/tiles/15/1/1.webp', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Range');
  });

  it('rejects non-GET methods', async () => {
    const { res } = await call('/api/dsm', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('rate-limits per IP', async () => {
    const env = makeEnv({ limited: true });
    const { res } = await call('/api/tiles/15/1/1.webp', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, env);
    expect(res.status).toBe(429);
    expect(env.PREVIEW_LIMITER.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('works without a limiter binding', async () => {
    upstream.mockResolvedValue(new Response('img', { status: 200 }));
    const env = makeEnv();
    delete env.PREVIEW_LIMITER;
    const { res } = await call('/api/tiles/15/1/1.webp', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('CORS', () => {
  it('echoes allowed origins and falls back to the main site otherwise', async () => {
    upstream.mockImplementation(async () => new Response('img', { status: 200 }));
    const www = await call('/api/tiles/15/1/1.webp', { headers: { Origin: 'https://www.polyplaces.co.uk' } });
    expect(www.res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.polyplaces.co.uk');
    const evil = await call('/api/tiles/15/1/2.webp', { headers: { Origin: 'https://evil.example' } });
    expect(evil.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(evil.res.headers.get('Vary')).toBe('Origin');
  });
});

describe('/api/tiles', () => {
  it('rejects zooms outside 10-15', async () => {
    expect((await call('/api/tiles/9/1/1.webp')).res.status).toBe(400);
    expect((await call('/api/tiles/16/1/1.webp')).res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('proxies Mapterhorn, caches immutably, and serves the cache next time', async () => {
    upstream.mockResolvedValue(new Response('img', { status: 200 }));
    const first = await call('/api/tiles/12/5/6.webp');
    expect(upstream).toHaveBeenCalledWith('https://tiles.mapterhorn.com/12/5/6.webp');
    expect(first.res.headers.get('Content-Type')).toBe('image/webp');
    expect(first.res.headers.get('Cache-Control')).toContain('immutable');
    expect(cache.put).toHaveBeenCalledOnce();

    const second = await call('/api/tiles/12/5/6.webp');
    expect(upstream).toHaveBeenCalledOnce();
    expect(await second.res.text()).toBe('img');
  });

  it('caches a 404 for an hour', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 404 }));
    const { res } = await call('/api/tiles/15/1/1.webp');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it('passes other upstream failures through empty and uncached', async () => {
    upstream.mockResolvedValue(new Response('<html>oops</html>', { status: 503 }));
    const { res } = await call('/api/tiles/15/1/1.webp');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe('/api/dsm', () => {
  const q = (s, w, n, e) => `/api/dsm?s=${s}&w=${w}&n=${n}&e=${e}`;

  it('validates the box', async () => {
    expect((await call('/api/dsm?s=1&w=2&n=3')).res.status).toBe(400);
    expect((await call(q(51.5, -0.1, 51.4, -0.05))).res.status).toBe(400);
    expect((await call(q(51.5, -0.1, 51.65, -0.05))).res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('requests a WCS GeoTIFF and caches it', async () => {
    upstream.mockResolvedValue(new Response('tiff', { status: 200, headers: { 'Content-Type': 'image/tiff' } }));
    const { res } = await call(q(51.5, -0.1, 51.51, -0.09));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/tiff');
    const url = new URL(upstream.mock.calls[0][0]);
    expect(url.searchParams.get('request')).toBe('GetCoverage');
    expect(url.searchParams.getAll('subset')).toEqual(['Long(-0.1,-0.09)', 'Lat(51.5,51.51)']);
    expect(url.searchParams.has('scalefactor')).toBe(false); // ~1.1 km, under 2048 px
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it('caps the output at 2048 px for wide boxes', async () => {
    upstream.mockResolvedValue(new Response('tiff', { status: 200, headers: { 'Content-Type': 'image/tiff' } }));
    await call(q(51.5, -0.1, 51.58, -0.02));
    const sf = Number(new URL(upstream.mock.calls[0][0]).searchParams.get('scalefactor'));
    expect(sf).toBeGreaterThan(0);
    expect(sf).toBeLessThan(1);
  });

  it('returns 204 for an XML error body (outside UK coverage)', async () => {
    upstream.mockResolvedValue(new Response('<ows:Exception/>', { status: 200, headers: { 'Content-Type': 'application/xml' } }));
    const { res } = await call(q(48.8, 2.3, 48.81, 2.31));
    expect(res.status).toBe(204);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('maps a timeout to 504 and other network errors to 502', async () => {
    upstream.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    expect((await call(q(51.5, -0.1, 51.51, -0.09))).res.status).toBe(504);
    upstream.mockRejectedValueOnce(new TypeError('network'));
    expect((await call(q(51.5, -0.1, 51.51, -0.09))).res.status).toBe(502);
  });
});

describe('/api/overture-pmtiles', () => {
  const range = (r) => ({ headers: { Range: r } });

  it('only serves known themes and releases', async () => {
    expect((await call('/api/overture-pmtiles/roads', range('bytes=0-10'))).res.status).toBe(404);
    expect((await call('/api/overture-pmtiles/base?release=1999-01-01.0', range('bytes=0-10'))).res.status).toBe(404);
  });

  it('requires a valid, bounded Range header', async () => {
    expect((await call('/api/overture-pmtiles/base')).res.status).toBe(416);
    expect((await call('/api/overture-pmtiles/base', range('bytes=10-'))).res.status).toBe(416);
    expect((await call('/api/overture-pmtiles/base', range('bytes=10-5'))).res.status).toBe(416);
    expect((await call('/api/overture-pmtiles/base', range(`bytes=0-${4 * 1024 * 1024}`))).res.status).toBe(416);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('proxies a 206 range from the latest release and re-serves it from cache as 206', async () => {
    upstream.mockResolvedValue(new Response('abc', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-2/100', ETag: '"e1"' },
    }));
    const first = await call('/api/overture-pmtiles/buildings', range('bytes=0-2'));
    expect(first.res.status).toBe(206);
    expect(first.res.headers.get('Content-Range')).toBe('bytes 0-2/100');
    expect(first.res.headers.get('ETag')).toBe('"e1"');
    expect(upstream.mock.calls[0][0]).toContain(`/tiles/${OVERTURE_RELEASES[0]}/buildings.pmtiles`);
    expect(upstream.mock.calls[0][1].headers.Range).toBe('bytes=0-2');

    const second = await call('/api/overture-pmtiles/buildings', range('bytes=0-2'));
    expect(upstream).toHaveBeenCalledOnce();
    expect(second.res.status).toBe(206);
    expect(await second.res.text()).toBe('abc');
  });

  it('treats a full 200 from S3 as a bad gateway', async () => {
    upstream.mockResolvedValue(new Response('whole file', { status: 200 }));
    expect((await call('/api/overture-pmtiles/base', range('bytes=0-2'))).res.status).toBe(502);
  });
});
