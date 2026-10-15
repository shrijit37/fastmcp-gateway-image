import { applyDomainFilter } from '../filter.ts';
import { BackendError, type FetchBackend, type FetchOptions, type FetchResult, type SearchBackend, type SearchOptions, type SearchResult } from '../types.ts';

/**
 * Tavily adapter, ported from claude-code-best.
 *
 * CCB points this at its own community relay (`tavily.claude-code-best.win`),
 * which fronts the Tavily API without requiring the caller to hold a key. That
 * keeps the backend keyless, at the cost of routing every query through a host
 * we do not control. Set TAVILY_ENDPOINT_URL to use your own relay instead.
 */

const DEFAULT_ENDPOINT = 'https://tavily.claude-code-best.win';
const TIMEOUT_MS = 30_000;

export function tavilyEndpoint(): string {
  const configured = process.env.TAVILY_ENDPOINT_URL?.trim();
  return (configured || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

function joinPath(base: string, path: string): string {
  return base.endsWith(`/${path}`) ? base : `${base}/${path}`;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Tavily relay responded ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

type TavilySearchResponse = {
  results?: Array<{ title?: string; url?: string; content?: string }>;
};

export const tavilySearchBackend: SearchBackend = {
  key: 'tavily',
  label: 'Tavily (via ccb relay)',
  keyless: true,

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    options.onProgress?.({ type: 'query_update', query });

    const url = joinPath(tavilyEndpoint(), 'search');

    let payload: TavilySearchResponse;
    try {
      payload = await postJson<TavilySearchResponse>(
        url,
        {
          query,
          search_depth: 'basic',
          max_results: options.numResults ?? 8,
          include_domains: options.allowedDomains ?? [],
          exclude_domains: options.blockedDomains ?? [],
        },
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new BackendError('tavily', 'network', `Tavily relay request failed: ${(error as Error).message}`);
    }

    const results = (payload.results ?? [])
      .filter((r): r is { title: string; url: string; content: string } => Boolean(r?.url))
      .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? '' }));

    const filtered = applyDomainFilter(results, options.allowedDomains, options.blockedDomains).slice(
      0,
      options.numResults ?? 8,
    );

    if (filtered.length === 0) {
      throw new BackendError('tavily', 'empty', `Tavily relay returned no results for "${query}". The relay may be down or rate-limiting.`);
    }

    options.onProgress?.({ type: 'search_results_received', resultCount: filtered.length, query });
    return filtered;
  },
};

type TavilyExtractResponse = {
  results?: Array<{ url?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
};

export const tavilyExtractBackend: FetchBackend = {
  key: 'tavily',
  label: 'Tavily extract (via ccb relay)',
  keyless: true,

  async fetch(url: string, options: FetchOptions): Promise<FetchResult> {
    const endpoint = joinPath(tavilyEndpoint(), 'extract');

    let payload: TavilyExtractResponse;
    try {
      payload = await postJson<TavilyExtractResponse>(endpoint, { urls: [url] }, options.signal, options.timeoutMs);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(`Tavily extract failed: ${(error as Error).message}`);
    }

    const first = payload.results?.[0];
    const text = first?.raw_content;
    if (!text) {
      const reason = payload.failed_results?.[0]?.error ?? 'no content returned';
      throw new Error(`Tavily extract returned nothing for ${url}: ${reason}`);
    }

    return {
      url,
      destinationUrl: first?.url ?? url,
      text,
      contentType: 'text/plain',
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  },
};
