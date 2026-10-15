/**
 * Shared types for the search backends and the fetch backends.
 *
 * The `SearchBackend` interface mirrors the one used by claude-code-best so the
 * ported parsers stay close to their originals and easy to diff against.
 */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type ProgressEvent =
  | { type: 'query_update'; query: string }
  | { type: 'search_results_received'; resultCount: number; query: string };

export type SearchOptions = {
  signal?: AbortSignal;
  numResults?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  onProgress?: (event: ProgressEvent) => void;
};

export type SearchBackend = {
  key: string;
  label: string;
  /** Whether the backend can work with zero configuration. */
  keyless: boolean;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
};

export type FetchResult = {
  url: string;
  destinationUrl?: string;
  title?: string;
  text: string;
  contentType: string;
  bytes: number;
};

export type FetchOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
};

export type FetchBackend = {
  key: string;
  label: string;
  keyless: boolean;
  fetch(url: string, options: FetchOptions): Promise<FetchResult>;
};

/**
 * Thrown when a backend cannot produce a trustworthy answer.
 *
 * The whole point of this class is that the server must never hand the model an
 * empty-but-successful result set: the built-in `WebSearch` fails exactly that
 * way, and the model then papers over the gap with its own prose. A named
 * backend plus a likely cause is something a caller can act on.
 */
export class BackendError extends Error {
  readonly backend: string;
  readonly cause: string;

  constructor(backend: string, cause: string, message?: string) {
    super(message ?? `${backend} search returned no usable results (${cause})`);
    this.name = 'BackendError';
    this.backend = backend;
    this.cause = cause;
  }
}
