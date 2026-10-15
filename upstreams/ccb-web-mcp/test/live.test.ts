/**
 * Live end-to-end test: drives the server over a real stdio MCP connection and
 * exercises each tool against the network.
 *
 * This is the check the built-in `WebSearch` cannot pass — every URL returned
 * must be a real, fetchable destination rather than a search-engine redirect or
 * a citation the model invented.
 *
 * Run: node --test test/live.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'src', 'index.ts');

let client: Client;
let transport: StdioClientTransport;

before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  client = new Client({ name: 'ccb-web-mcp-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const parse = (r: CallResult) => JSON.parse(r.content[0]!.text);

test('server advertises exactly the three expected tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['web_fetch', 'web_search', 'web_search_health']);
});

test('web_search returns real, non-redirect citations via the bing backend', async () => {
  const r = (await client.callTool({
    name: 'web_search',
    arguments: { query: 'anthropic claude code', num_results: 5 },
  })) as CallResult;

  assert.ok(!r.isError, `search failed: ${r.content[0]?.text}`);
  const data = parse(r);

  assert.equal(data.backend, 'bing');
  assert.ok(data.results.length > 0, 'expected at least one result');

  for (const item of data.results) {
    assert.match(item.url, /^https?:\/\//);
    assert.ok(!item.url.includes('bing.com/ck/a'), `redirect leaked: ${item.url}`);
    assert.ok(item.title.length > 0);
  }
  assert.ok(typeof data.duration_seconds === 'number');
});

test('cited URLs are actually reachable (not invented)', async () => {
  const r = (await client.callTool({
    name: 'web_search',
    arguments: { query: 'anthropic claude code', num_results: 3 },
  })) as CallResult;
  assert.ok(!r.isError);

  const { results } = parse(r);
  for (const item of results.slice(0, 2)) {
    const head = await fetch(item.url, { method: 'HEAD', redirect: 'follow' });
    assert.ok(
      head.status < 400,
      `cited URL is not fetchable: ${item.url} -> ${head.status}`,
    );
  }
});

test('web_search honours domain filtering', async () => {
  const r = (await client.callTool({
    name: 'web_search',
    arguments: { query: 'anthropic claude code', num_results: 8, allowed_domains: ['wikipedia.org'] },
  })) as CallResult;

  assert.ok(!r.isError);
  const { results } = parse(r);
  for (const item of results) {
    assert.match(new URL(item.url).hostname, /(^|\.)wikipedia\.org$/);
  }
});

test('web_fetch returns page text', async () => {
  const r = (await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://example.com' },
  })) as CallResult;

  assert.ok(!r.isError, `fetch failed: ${r.content[0]?.text}`);
  const data = parse(r);
  assert.equal(data.backend, 'http');
  assert.match(data.text, /Example Domain/);
  assert.ok(data.bytes > 0);
});

test('web_fetch refuses non-http schemes', async () => {
  const r = (await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://example.com' },
  })) as CallResult;
  assert.ok(!r.isError);

  const bad = (await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'file:///etc/passwd' },
  })) as CallResult | { content: Array<{ type: string; text: string }>; isError?: boolean };
  // zod's .url() accepts file:, so the backend guard is what must reject it.
  assert.ok(bad.isError, 'file:// should be rejected');
});

test('a nonsense query surfaces a clear error rather than an empty success', async () => {
  const r = (await client.callTool({
    name: 'web_search',
    arguments: { query: 'zzqxvjkwpn nonexistent gibberish term 9384716' },
  })) as CallResult;

  // Bing may still return loosely-related results; what must never happen is a
  // successful call carrying zero results with no explanation.
  if (!r.isError) {
    assert.ok(parse(r).results.length > 0, 'empty result set returned as a success');
  } else {
    assert.match(r.content[0]!.text, /failed via the "bing" backend/);
  }
});

test('web_search_health probes every backend without throwing', async () => {
  const r = (await client.callTool({ name: 'web_search_health', arguments: {} })) as CallResult;
  assert.ok(!r.isError, 'health check must never fail outright');

  const data = parse(r);
  assert.equal(data.backends.length, 3);
  for (const b of data.backends) {
    assert.ok(['ok', 'error'].includes(b.status), `unexpected status ${b.status}`);
  }
  const bing = data.backends.find((b: { backend: string }) => b.backend === 'bing');
  assert.equal(bing.status, 'ok', `bing should be reachable: ${JSON.stringify(bing)}`);
});

test('errors and results never leak credentials', async () => {
  const r = (await client.callTool({
    name: 'web_search',
    arguments: { query: 'anthropic claude code', backend: 'tavily' },
  })) as CallResult;
  const text = r.content[0]!.text;

  for (const secret of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'Authorization', 'Bearer ']) {
    assert.ok(!text.includes(secret), `output contained ${secret}`);
  }
});
