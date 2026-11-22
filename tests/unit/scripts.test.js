import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rewrite } = require('../../scripts/bust-cache.js');
const { parseEnvFile } = require('../../scripts/generate-env.js');

describe('bust-cache rewrite', () => {
  const hashes = {
    'assets/js/app.js': 'aaaa1111',
    './assets/js/app.js': 'aaaa1111',
    '../../assets/js/app.js': 'aaaa1111',
  };

  it('adds ?v= to bare references with every path prefix', () => {
    for (const src of ['./assets/js/app.js', '../assets/js/app.js', '/assets/js/app.js', '../../assets/js/app.js']) {
      expect(rewrite(`<script src="${src}"></script>`, hashes)).toBe(`<script src="${src}?v=aaaa1111"></script>`);
    }
  });

  it('replaces an existing version and never doubles it', () => {
    const html = `<script defer src="../assets/js/app.js?v=deadbeef"></script>`;
    const out = rewrite(html, hashes);
    expect(out).toBe(`<script defer src="../assets/js/app.js?v=aaaa1111"></script>`);
    expect(rewrite(out, hashes)).toBe(out);
  });

  it('handles single quotes and content attributes', () => {
    expect(rewrite(`<meta content='/assets/js/app.js'>`, hashes)).toBe(`<meta content='/assets/js/app.js?v=aaaa1111'>`);
  });

  it('leaves unrelated assets alone', () => {
    const html = `<script src="/assets/js/app.json"></script><script src="/assets/js/other.js"></script>`;
    expect(rewrite(html, hashes)).toBe(html);
  });
});

describe('generate-env parseEnvFile', () => {
  it('parses keys, strips quotes and ignores comments and junk', () => {
    const env = parseEnvFile([
      '# comment',
      '',
      'A=1',
      '  B = two  ',
      'C="quoted value"',
      "D='single'",
      'E=has=equals',
      'not a pair',
      'F=',
    ].join('\r\n'));
    expect(env).toEqual({ A: '1', B: 'two', C: 'quoted value', D: 'single', E: 'has=equals', F: '' });
  });
});
