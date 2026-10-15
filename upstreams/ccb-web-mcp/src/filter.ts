import type { SearchResult } from './types.ts';

/**
 * Domain allow/block filtering, ported verbatim in behaviour from
 * claude-code-best: a result matches an entry when the hostname equals it or is
 * a subdomain of it. Entries are lower-cased and leading dots tolerated.
 */
export function matchesDomainFilter(
  url: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  const norm = (list?: string[]) =>
    (list ?? []).map((d) => d.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);

  const allowed = norm(allowedDomains);
  if (allowed.length > 0 && !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    return false;
  }

  const blocked = norm(blockedDomains);
  if (blocked.length > 0 && blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    return false;
  }

  return true;
}

export function applyDomainFilter(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  return results.filter((r) => r.url && matchesDomainFilter(r.url, allowedDomains, blockedDomains));
}

/** Drop duplicate URLs, keeping first-seen order. */
export function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}
