#!/usr/bin/env node
/**
 * ccb-web-mcp — keyless web search and fetch for Claude Code.
 *
 * The official CLI's built-in `WebSearch` depends on the model provider's
 * server-side `web_search_20250305` tool, so it silently degrades to the model's
 * own prose on providers that do not implement it. This server moves web search
 * fully client-side over MCP, where it is independent of which provider is
 * behind ANTHROPIC_BASE_URL.
 *
 * Backends and their parsers are ported from claude-code-best (v2.8.4).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { bingBackend } from './backends/bing.ts';
import { exaBackend } from './backends/exa.ts';
import { tavilyExtractBackend, tavilySearchBackend } from './backends/tavily.ts';
import { httpFetchBackend, httpTimeoutMs } from './fetch.ts';
import { BackendError, type FetchBackend, type SearchBackend } from './types.ts';

const SEARCH_BACKENDS: SearchBackend[] = [bingBackend, tavilySearchBackend, exaBackend];
const FETCH_BACKENDS: FetchBackend[] = [httpFetchBackend, tavilyExtractBackend];

const SEARCH_KEYS = SEARCH_BACKENDS.map((b) => b.key);
const FETCH_KEYS = FETCH_BACKENDS.map((b) => b.key);

/** `WEB_SEARCH_ADAPTER` keeps the name claude-code-best already uses. */
function defaultSearchBackend(): string {
  const configured = process.env.WEB_SEARCH_ADAPTER?.trim();
  return configured && SEARCH_KEYS.includes(configured) ? configured : 'bing';
}

function findSearch(key: string): SearchBackend {
  const backend = SEARCH_BACKENDS.find((b) => b.key === key);
  if (!backend) throw new Error(`Unknown search backend "${key}". Available: ${SEARCH_KEYS.join(', ')}`);
  return backend;
}

function findFetch(key: string): FetchBackend {
  const backend = FETCH_BACKENDS.find((b) => b.key === key);
  if (!backend) throw new Error(`Unknown fetch backend "${key}". Available: ${FETCH_KEYS.join(', ')}`);
  return backend;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const server = new McpServer(
  { name: 'ccb-web-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'web_search',
  {
    title: 'Web search',
    description:
      'Search the web and return real results with citations. Unlike the built-in WebSearch, this runs entirely client-side and does not depend on the model provider implementing a server-side search tool. Backends: bing (default, self-contained), tavily (third-party relay), exa (public MCP endpoint). All are keyless.',
    inputSchema: {
      query: z.string().min(2).describe('The search query'),
      backend: z
        .enum(SEARCH_KEYS as [string, ...string[]])
        .optional()
        .describe('Search backend. Defaults to WEB_SEARCH_ADAPTER, else "bing".'),
      num_results: z.number().int().min(1).max(20).optional().describe('Max results to return (default 8)'),
      allowed_domains: z.array(z.string()).optional().describe('Only include results from these domains'),
      blocked_domains: z.array(z.string()).optional().describe('Never include results from these domains'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, backend, num_results, allowed_domains, blocked_domains }): Promise<ToolResult> => {
    const key = backend ?? defaultSearchBackend();
    const engine = findSearch(key);
    const startedAt = Date.now();

    try {
      const results = await engine.search(query, {
        numResults: num_results,
        allowedDomains: allowed_domains,
        blockedDomains: blocked_domains,
      });

      return ok({
        backend: key,
        query,
        result_count: results.length,
        duration_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
        results,
      });
    } catch (error) {
      // Never let a failure look like an empty-but-successful search.
      if (error instanceof BackendError) {
        return fail(
          `web_search failed via the "${error.backend}" backend (${error.cause}). ${error.message}\n` +
            `Do not answer from memory — report that web search is unavailable, or retry with a different backend.`,
        );
      }
      return fail(`web_search failed via the "${key}" backend: ${(error as Error).message}`);
    }
  },
);

server.registerTool(
  'web_fetch',
  {
    title: 'Fetch a URL',
    description:
      'Fetch a URL and return its readable text content. Backends: http (default, direct, no key), tavily (third-party relay, extracts page content).',
    inputSchema: {
      url: z.string().url().describe('The absolute http(s) URL to fetch'),
      backend: z.enum(FETCH_KEYS as [string, ...string[]]).optional().describe('Fetch backend (default "http")'),
      timeout_ms: z.number().int().min(1000).max(300_000).optional().describe('Timeout in ms (default from WEB_FETCH_HTTP_TIMEOUT_MS, else 60000)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, backend, timeout_ms }): Promise<ToolResult> => {
    const key = backend ?? 'http';
    const engine = findFetch(key);
    const startedAt = Date.now();

    try {
      const result = await engine.fetch(url, { timeoutMs: timeout_ms ?? httpTimeoutMs() });
      return ok({
        backend: key,
        url: result.url,
        destination_url: result.destinationUrl,
        title: result.title,
        content_type: result.contentType,
        bytes: result.bytes,
        duration_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
        text: result.text,
      });
    } catch (error) {
      return fail(`web_fetch failed via the "${key}" backend: ${(error as Error).message}`);
    }
  },
);

server.registerTool(
  'web_search_health',
  {
    title: 'Check search backends',
    description:
      'Probe each search backend with a fixed query and report which are reachable. Use this when web search seems to be returning nothing, or to pick a working backend.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (): Promise<ToolResult> => {
    const probe = 'anthropic claude code';
    const checks = [];

    for (const engine of SEARCH_BACKENDS) {
      const startedAt = Date.now();
      try {
        const results = await engine.search(probe, { numResults: 3 });
        checks.push({
          backend: engine.key,
          label: engine.label,
          keyless: engine.keyless,
          status: 'ok',
          result_count: results.length,
          sample_url: results[0]?.url,
          duration_ms: Date.now() - startedAt,
        });
      } catch (error) {
        checks.push({
          backend: engine.key,
          label: engine.label,
          keyless: engine.keyless,
          status: 'error',
          error: error instanceof BackendError ? `${error.cause}: ${error.message}` : (error as Error).message,
          duration_ms: Date.now() - startedAt,
        });
      }
    }

    return ok({
      default_backend: defaultSearchBackend(),
      probe_query: probe,
      note: 'A backend reporting "error" here should not be used until it recovers. "markup-drift" means the page structure changed and the parser needs updating.',
      backends: checks,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP transport; anything else we print would corrupt the stream.
console.error('ccb-web-mcp ready (stdio)');
