import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(__dirname, '../..');

function htmlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'tests' ||
        entry.name === 'mockups' || entry.name === 'src' || entry.name === 'test-results' ||
        entry.name === 'playwright-report') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
const csp = /Content-Security-Policy: (.+)/.exec(headers)[1];
const allowedHashes = [...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
const scriptSrc = /script-src ([^;]+)/.exec(csp)[1];

// Inline executable scripts (JSON-LD is data and is not subject to script-src).
function inlineScripts(html) {
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs = '']) => !/\bsrc=/.test(attrs) && !/application\/ld\+json/.test(attrs))
    .map(([, , body]) => body);
}

describe('Content-Security-Policy', () => {
  const pages = htmlFiles(ROOT);

  it('finds the site pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of pages) {
    const rel = path.relative(ROOT, file);
    const html = fs.readFileSync(file, 'utf8');

    it(`${rel}: every inline script is allowed by a CSP hash`, () => {
      for (const body of inlineScripts(html)) {
        // Hash the committed (LF) form. A Windows checkout with core.autocrlf
        // has CRLF on disk, which hashes differently - deploying straight from
        // such a checkout would get the inline script blocked.
        const hash = crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('base64');
        expect(allowedHashes, `inline script in ${rel} is blocked by CSP`).toContain(hash);
      }
    });

    it(`${rel}: every external script host is allowed by script-src`, () => {
      for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
        if (!/^https?:/.test(src)) continue;
        const origin = new URL(src).origin;
        expect(scriptSrc, `${src} in ${rel} is blocked by CSP`).toContain(origin);
      }
    });
  }
});
