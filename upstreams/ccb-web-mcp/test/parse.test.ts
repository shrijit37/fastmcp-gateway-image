import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseBingHtml, unwrapBingUrl } from '../src/backends/bing.ts';
import { parseResults, parseSse } from '../src/backends/exa.ts';
import { decodeEntities, toText, extractTitle } from '../src/html.ts';
import { matchesDomainFilter, applyDomainFilter, dedupe } from '../src/filter.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures-bing.html'), 'utf8');

test('decodeEntities handles named, decimal and hex references', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;script&gt;'), '<script>');
  assert.equal(decodeEntities('it&#39;s'), "it's");
  assert.equal(decodeEntities('&#x27;'), "'");
  assert.equal(decodeEntities('caf&eacute; &mdash; ok'), 'café — ok');
  // Unknown entities are left untouched rather than mangled.
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('toText strips tags and collapses whitespace', () => {
  assert.equal(toText('<p>Hello   <b>world</b></p>'), 'Hello world');
  assert.equal(toText('a&amp;b'), 'a&b');
});

test('extractTitle pulls the first title element', () => {
  assert.equal(extractTitle('<html><head><title> Hi &amp; bye </title></head></html>'), 'Hi & bye');
  assert.equal(extractTitle('<html><body>no title</body></html>'), undefined);
});

test('unwrapBingUrl decodes the /ck/a redirect wrapper', () => {
  assert.equal(
    unwrapBingUrl('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9hbnRocm9waWMuY29tL8&ntb=1'),
    'https://anthropic.com/',
  );
});

test('unwrapBingUrl rejects unusable hrefs but passes direct URLs through', () => {
  assert.equal(unwrapBingUrl('/relative/path'), undefined);
  assert.equal(unwrapBingUrl('#anchor'), undefined);
  // A bing.com URL we cannot unwrap is useless to the caller.
  assert.equal(unwrapBingUrl('https://www.bing.com/search?q=x'), undefined);
  assert.equal(unwrapBingUrl('https://example.com/page'), 'https://example.com/page');
});

test('parseBingHtml extracts real destination URLs from a saved results page', () => {
  const results = parseBingHtml(fixture);

  assert.ok(results.length >= 5, `expected several results, got ${results.length}`);
  for (const r of results) {
    assert.match(r.url, /^https?:\/\//, `url must be absolute, got ${r.url}`);
    assert.ok(
      !r.url.includes('bing.com/ck/a'),
      `redirect wrapper leaked through: ${r.url}`,
    );
    assert.ok(r.title.length > 0, 'every result needs a title');
  }
});

test('parseBingHtml survives markup with no recognisable results', () => {
  assert.deepEqual(parseBingHtml('<html><body>nothing here</body></html>'), []);
});

test('parseSse extracts the text block from an MCP SSE payload', () => {
  // Build the JSON with JSON.stringify so the embedded newline stays escaped.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'Title: A\nURL: https://a.example' }] },
  });
  const payload = ['event: message', `data: ${body}`, ''].join('\n');
  assert.match(parseSse(payload), /Title: A/);
  assert.equal(parseSse('data: [DONE]'), '');
  assert.equal(parseSse('garbage'), '');
});

test('parseResults handles the Title/URL/Content format and fallbacks', () => {
  const doc = 'Title: First\nURL: https://one.example\nContent: body one\n---\nTitle: Second\nURL: https://two.example\nContent: body two';
  const results = parseResults(doc);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://one.example');
  assert.equal(results[0].snippet, 'body one');

  // Markdown-link fallback.
  const md = parseResults('see [Link A](https://a.example) and [Link B](https://b.example)');
  assert.equal(md.length, 2);
  assert.equal(md[1].title, 'Link B');
});

test('domain filter matches subdomains and blocks correctly', () => {
  assert.ok(matchesDomainFilter('https://docs.example.com/x', ['example.com']));
  assert.ok(matchesDomainFilter('https://example.com/x', ['example.com']));
  assert.ok(!matchesDomainFilter('https://notexample.com/x', ['example.com']));
  assert.ok(!matchesDomainFilter('https://evil.com/x', undefined, ['evil.com']));
  // A blocked domain wins over an allowed one.
  assert.ok(!matchesDomainFilter('https://ads.example.com/x', ['example.com'], ['ads.example.com']));
});

test('applyDomainFilter and dedupe', () => {
  const input = [
    { title: 'a', url: 'https://a.example.com/', snippet: '' },
    { title: 'b', url: 'https://b.example.com/', snippet: '' },
    { title: 'a-dup', url: 'https://a.example.com/', snippet: '' },
  ];
  // Filtering does not dedupe — that is a separate step, applied in that order.
  assert.equal(applyDomainFilter(input, ['example.com']).length, 3);
  assert.equal(applyDomainFilter(input, ['other.com']).length, 0);
  assert.equal(dedupe(input).length, 2);
  assert.equal(dedupe(input)[0].title, 'a', 'first occurrence wins');
});
