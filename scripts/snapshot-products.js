#!/usr/bin/env node
/**
 * snapshot-products.js
 * Fetches /api/products from the live API and writes a committed snapshot used
 * for instant price rendering and as a fallback when the API is unreachable.
 * Run at build/deploy time (see "preserve" npm script).
 */
const fs = require('fs');
const path = require('path');

const API_BASE = (process.env.POLYPLACES_API_BASE_URL || 'https://api.polyplaces.co.uk').replace(/\/$/, '');
const OUT = path.resolve(__dirname, '..', 'assets', 'data', 'products-snapshot.json');

(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/products`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : [];
    if (products.length === 0) throw new Error('API returned zero products');

    const snapshot = {
      generatedAt: new Date().toISOString(),
      products,
      framePrices: data?.framePrices || null,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log(`Snapshot written: ${products.length} products -> ${path.relative(process.cwd(), OUT)}`);
  } catch (err) {
    // Never fail the build for this: a previous snapshot on disk is still valid.
    if (fs.existsSync(OUT)) {
      console.warn(`[snapshot-products] fetch failed (${err.message}); keeping existing snapshot.`);
    } else {
      console.warn(`[snapshot-products] fetch failed (${err.message}); NO snapshot exists — prices will depend on the live API.`);
    }
  }
})();
