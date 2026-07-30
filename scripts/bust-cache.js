#!/usr/bin/env node
/**
 * bust-cache.js
 * Rewrites ?v= query strings on CSS/JS asset references in every HTML file.
 * The version is the first 8 hex chars of each file's SHA-256 content hash,
 * so it only changes when the file actually changes.
 *
 * Usage:  node scripts/bust-cache.js
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Assets to hash — add more here if needed
const ASSETS = [
  'assets/css/styles.css',
  'assets/js/app.js',
  'assets/js/env.js',
  'assets/js/contact.js',
  'assets/js/analytics.js',
  'assets/js/reviews.js',
  'assets/js/turnstile.js',
];

// Find all HTML files in the project (excluding node_modules)
function findHtml(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findHtml(full, results);
    else if (entry.name.endsWith('.html')) results.push(full);
  }
  return results;
}

// Compute short content hash for a file
function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

// Build a map of  asset-path-fragment → hash
const hashes = {};
for (const rel of ASSETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.warn(`  [skip] ${rel} not found`); continue; }
  hashes[rel] = hashFile(abs);
  // Also match the ./  and ../ prefix variants used in HTML
  hashes['./' + rel]  = hashes[rel];
  hashes['../../' + rel] = hashes[rel];
}

// Replace ?v=<anything> (or add ?v=) for each known asset in HTML files
function rewrite(html) {
  let out = html;
  for (const [fragment, hash] of Object.entries(hashes)) {
    // Match the fragment followed by optional ?v=... and then a quote/space
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace existing ?v=xxx
    out = out.replace(
      new RegExp(`(${escaped})\\?v=[^"'\\s]+`, 'g'),
      `$1?v=${hash}`
    );
    // Add ?v= if not present yet
    out = out.replace(
      new RegExp(`(${escaped})(?!\\?v=)(?=["'\\s])`, 'g'),
      `$1?v=${hash}`
    );
  }
  return out;
}

const htmlFiles = findHtml(ROOT);
let changed = 0;

for (const file of htmlFiles) {
  const original = fs.readFileSync(file, 'utf8');
  const updated  = rewrite(original);
  if (updated !== original) {
    fs.writeFileSync(file, updated, 'utf8');
    console.log(`  updated  ${path.relative(ROOT, file)}`);
    changed++;
  }
}

console.log(`\nDone. ${changed} file(s) updated.`);
console.log('Hashes:');
for (const [k, v] of Object.entries(hashes)) {
  if (!k.startsWith('./') && !k.startsWith('../../')) console.log(`  ${k}  →  ${v}`);
}
