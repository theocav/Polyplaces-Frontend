# Backend Spec: GET /api/config

## Purpose

Frontend fetches this endpoint on page load to retrieve runtime configuration,
including environment-specific values that should not be hardcoded in the
frontend repository. Eliminates the need to commit environment-specific values
to source control.

---

## Endpoint

```
GET /api/config
```

No authentication required. This is a public endpoint — the values returned are
consumed by client-side JavaScript, so treat them as non-secret in the sense that
any browser can read them. The point is to keep them out of source control and
deployable artifacts.

---

## Request

No body. No query parameters. No auth headers.

---

## Response

**Status:** `200 OK`  
**Content-Type:** `application/json`

```json
{
  "POLYPLACES_API_BASE_URL": "https://api.polyplaces.co.uk/",
  "POLYPLACES_SITE_URL": "https://polyplaces.co.uk",
  "POLYPLACES_NOMINATIM_URL": "https://nominatim.openstreetmap.org/search",
  "POLYPLACES_SEARCH_COUNTRY_CODES": "gb",
  "POLYPLACES_SEARCH_VIEWBOX": "-8.7,60.9,1.9,49.8",
  "SENTRY_DSN": "<SENTRY_DSN — from backend env>"
}
```

All fields must be present. If a value is not applicable for an environment
(e.g. no Sentry in staging), return an empty string for that key rather than
omitting it.

---

## Current values (production)

| Key | Value |
|-----|-------|
| `POLYPLACES_API_BASE_URL` | `https://api.polyplaces.co.uk/` |
| `POLYPLACES_SITE_URL` | `https://polyplaces.co.uk` |
| `POLYPLACES_NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` |
| `POLYPLACES_SEARCH_COUNTRY_CODES` | `gb` |
| `POLYPLACES_SEARCH_VIEWBOX` | `-8.7,60.9,1.9,49.8` |
| `SENTRY_DSN` | `<SENTRY_DSN — from backend env>` |

---

## Required response headers

```
Access-Control-Allow-Origin: https://polyplaces.co.uk
Cache-Control: no-store
```

- `no-store` prevents CDN/proxy from caching a stale or wrong-environment config.
- CORS must be restricted to `https://polyplaces.co.uk` only (not `*`).
- For local dev, also allow `http://localhost:*` (or whatever local origin is used).

---

## Error behaviour

If the backend cannot serve config (e.g. env vars not set), return `503` with no
body rather than a partial JSON object. The frontend handles fetch failure
gracefully — Sentry will be inactive for that session and all other config falls
back to hardcoded defaults. A silent failure is better than a broken JSON
response that crashes the parse.

---

## Notes for frontend integration

- Frontend fires this fetch immediately on page load with `cache: 'no-store'`.
- It does not block page render — store defaults are set before the fetch so the
  UI is functional even if the request is slow.
- Sentry is initialised only after this fetch resolves. Any errors thrown in the
  first ~200ms of page load will not be captured. Acceptable tradeoff.
- `POLYPLACES_API_BASE_URL` in the response is used to override the bootstrap
  value from `env.js`. Both should point to the same host in production.
