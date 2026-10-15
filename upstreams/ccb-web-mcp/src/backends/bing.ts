import { decodeEntities, toText } from '../html.ts';
import { applyDomainFilter, dedupe } from '../filter.ts';
import { BackendError, type SearchBackend, type SearchOptions, type SearchResult } from '../types.ts';

/**
 * Bing HTML adapter — a port of claude-code-best's `bing` backend.
 *
 * No API key, no third-party service: the only network hop is to Bing itself.
 *
 * The thing to get right is result URLs. Bing wraps every organic link in a
 * redirect of the form
 *
 *   https://www.bing.com/ck/a?!&&p=<hash>&...&u=a1<base64url>&ntb=1
 *
 * where the `u` parameter is the real target, base64url-encoded behind a
 * two-character `a1` marker. `u` sorts *after* the long `p` hash, so any code
 * that truncates the href before decoding silently loses every result.
 */

const ENDPOINT = 'https://www.bing.com/search';
const TIMEOUT_MS = 30_000;

/** Chromium-shaped headers; Bing serves a reduced page to obviously scripted clients. */
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** Decode Bing's `u=a1<base64url>` wrapper, or pass a direct URL through. */
export function unwrapBingUrl(href: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return undefined;

  const match = /[?&]u=([a-zA-Z0-9+/_=-]+)/.exec(trimmed);
  if (match?.[1]) {
    const encoded = match[1];
    if (encoded.length >= 3) {
      // Drop the two-character marker (normally "a1") and base64url-decode.
      const body = encoded.slice(2);
      try {
        const decoded = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        if (decoded.startsWith('http')) return decoded;
      } catch {
        // fall through to the direct-URL check below
      }
    }
  }

  // A bing.com URL we could not unwrap is useless to the caller; anything else
  // is already a real destination.
  if (trimmed.includes('bing.com')) return undefined;
  return trimmed;
}

/** Pull the snippet out of a result block, trying the layouts Bing ships. */
function extractSnippet(block: string): string {
  const lineclamp = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (lineclamp) return toText(lineclamp[1]);

  const captionP = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (captionP) return toText(captionP[1]);

  const caption = /<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
  if (caption) return toText(caption[1]);

  return '';
}

/**
 * Parse a Bing results page. Exported so it can be tested against a saved
 * fixture without touching the network.
 */
export function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;

  for (let m = blocks.exec(html); m !== null; m = blocks.exec(html)) {
    const block = m[1] ?? '';
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;

    // The href must be entity-decoded first: raw markup carries `&amp;u=a1…`,
    // not `&u=a1…`, so the redirect parameter is invisible until decoded.
    const url = unwrapBingUrl(decodeEntities(link[1] ?? ''));
    if (!url) continue;

    const title = toText(link[2] ?? '');
    if (!title) continue;

    results.push({ title, url, snippet: extractSnippet(block) });
  }

  return results;
}

async function requestHtml(query: string, signal?: AbortSignal): Promise<string> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&setmkt=en-US`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: HEADERS,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`Bing responded ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const bingBackend: SearchBackend = {
  key: 'bing',
  label: 'Bing (HTML scrape)',
  keyless: true,

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    options.onProgress?.({ type: 'query_update', query });

    let html: string;
    try {
      html = await requestHtml(query, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new BackendError('bing', 'network', `Bing request failed: ${(error as Error).message}`);
    }

    options.onProgress?.({ type: 'search_results_received', resultCount: 0, query });

    const parsed = parseBingHtml(html);
    const filtered = dedupe(applyDomainFilter(parsed, options.allowedDomains, options.blockedDomains));
    const limited = filtered.slice(0, options.numResults ?? 8);

    if (limited.length === 0) {
      // Distinguish "Bing changed its markup" from "genuinely nothing matched",
      // because the two need very different responses.
      const cause = parsed.length === 0 ? 'parser found no <li class="b_algo"> blocks (markup may have changed)' : 'all results were removed by the domain filter';
      throw new BackendError('bing', parsed.length === 0 ? 'markup-drift' : 'filtered', `Bing returned no usable results for "${query}": ${cause}`);
    }

    options.onProgress?.({ type: 'search_results_received', resultCount: limited.length, query });
    return limited;
  },
};
