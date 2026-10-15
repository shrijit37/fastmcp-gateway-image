import { extractTitle, toText } from './html.ts';
import type { FetchBackend, FetchOptions, FetchResult } from './types.ts';

/**
 * Direct HTTP fetch — the `http` adapter from claude-code-best, and the
 * counterpart to its Tavily `/extract` option. No API key, no relay.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/** Hard ceiling on the body we will read, to protect the caller's context. */
const MAX_BYTES = 5 * 1024 * 1024;

export function httpTimeoutMs(): number {
  const raw = Number.parseInt(process.env.WEB_FETCH_HTTP_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|javascript|ld\+json))/i;

export const httpFetchBackend: FetchBackend = {
  key: 'http',
  label: 'HTTP direct',
  keyless: true,

  async fetch(url: string, options: FetchOptions): Promise<FetchResult> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to fetch non-http(s) URL: ${parsed.protocol}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(parsed, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Request to ${url} timed out after ${options.timeoutMs}ms`);
      }
      throw new Error(`Request to ${url} failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new Error(`Request to ${url} returned ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const raw = await response.text();
    const bytes = Buffer.byteLength(raw, 'utf8');

    // HTML gets reduced to readable text; everything else is passed through
    // untouched apart from a size cap.
    const isHtml = /text\/html/i.test(contentType);
    let text = raw;
    if (isHtml) {
      text = toText(raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
    } else if (bytes > MAX_BYTES) {
      text = raw.slice(0, MAX_BYTES);
    }

    return {
      url,
      destinationUrl: response.url || url,
      title: isHtml ? extractTitle(raw) : undefined,
      text,
      contentType,
      bytes,
    };
  },
};
