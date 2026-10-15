import { dedupe } from '../filter.ts';
import { BackendError, type SearchBackend, type SearchOptions, type SearchResult } from '../types.ts';

/**
 * Exa adapter, ported from claude-code-best.
 *
 * Speaks JSON-RPC to Exa's public MCP endpoint. The `Authorization` header is
 * only attached when EXA_API_KEY is set, so the endpoint works keyless at the
 * cost of Exa's anonymous rate limit. Set EXA_API_KEY for a real quota.
 */

const DEFAULT_ENDPOINT = 'https://mcp.exa.ai/mcp';
const TIMEOUT_MS = 25_000;
const SNIPPET_LIMIT = 300;

export function exaEndpoint(): string {
  return process.env.EXA_ENDPOINT_URL?.trim() || DEFAULT_ENDPOINT;
}

/** Pull the first text block out of an MCP `tools/call` result. */
export function parseSse(payload: string): string {
  for (const line of payload.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.substring(6).trim();
    if (!data || data === '[DONE]' || data === 'null') continue;
    try {
      const content = (JSON.parse(data) as any)?.result?.content;
      if (Array.isArray(content) && content[0]?.text) return String(content[0].text);
    } catch {
      // try the next data line
    }
  }
  try {
    const content = (JSON.parse(payload) as any)?.result?.content;
    if (Array.isArray(content) && content[0]?.text) return String(content[0].text);
  } catch {
    // not a bare JSON body either
  }
  return '';
}

/** Exa returns a `Title:/URL:/Content:` document; fall back to looser shapes. */
export function parseResults(text: string): SearchResult[] {
  if (!text) return [];
  const results: SearchResult[] = [];

  for (const block of text.split(/\n---\n/g)) {
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const url = /^URL:\s*(https?:\/\/[^\s]+)$/m.exec(block)?.[1]?.trim();
    const content = /^Content:\s*([\s\S]+?)(?=\n(?:Title:|URL:|---)|$)/m.exec(block)?.[1]?.trim();
    if (url) {
      results.push({ title: title ?? url, url, snippet: (content ?? '').slice(0, SNIPPET_LIMIT) });
    }
  }

  if (results.length === 0) {
    const link = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    for (let m = link.exec(text); m !== null; m = link.exec(text)) {
      results.push({ title: m[1].trim(), url: m[2].trim(), snippet: '' });
    }
  }

  if (results.length === 0) {
    const bare = /^https?:\/\/[^\s<>"\\]]+/gm;
    for (let m = bare.exec(text); m !== null; m = bare.exec(text)) {
      results.push({ title: m[0], url: m[0], snippet: '' });
    }
  }

  return results;
}

export const exaBackend: SearchBackend = {
  key: 'exa',
  label: 'Exa (public MCP endpoint)',
  keyless: true,

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    options.onProgress?.({ type: 'query_update', query });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let body: string;
    try {
      const response = await fetch(exaEndpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query,
              type: 'auto',
              numResults: options.numResults ?? 8,
              livecrawl: 'fallback',
              contextMaxCharacters: 10_000,
            },
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Exa responded ${response.status} ${response.statusText}`);
      }
      body = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new BackendError('exa', 'network', `Exa request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const results = dedupe(parseResults(parseSse(body))).slice(0, options.numResults ?? 8);

    if (results.length === 0) {
      throw new BackendError('exa', 'empty', `Exa returned no usable results for "${query}". The anonymous endpoint is rate-limited — set EXA_API_KEY for reliable access.`);
    }

    options.onProgress?.({ type: 'search_results_received', resultCount: results.length, query });
    return results;
  },
};
