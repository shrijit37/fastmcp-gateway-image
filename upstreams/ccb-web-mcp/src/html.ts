/**
 * Minimal HTML helpers.
 *
 * claude-code-best pulls in the `he` package for entity decoding. We only need
 * the handful of entities that actually show up in search-result titles and
 * snippets, so a small table plus numeric-reference support is enough and keeps
 * the dependency list to the MCP SDK and zod.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  times: '×',
  middot: '·',
  bull: '•',
  dagger: '†',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  micro: 'µ',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ntilde: 'ñ',
};

/** Windows-1252 replacements for the numeric refs browsers emit verbatim. */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function codePointToString(code: number): string {
  const safe = CP1252[code] ?? code;
  if (safe < 0 || safe > 0x10ffff) return '';
  if (safe >= 0xd800 && safe <= 0xdfff) return '';
  try {
    return String.fromCodePoint(safe);
  } catch {
    return '';
  }
}

/** Decode named, decimal and hexadecimal HTML character references. */
export function decodeEntities(input: string): string {
  if (!input) return '';
  return input.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return match;
      return codePointToString(code);
    }
    const named = NAMED[body];
    return named === undefined ? match : named;
  });
}

/** Remove tags, then decode entities and collapse whitespace. */
export function toText(html: string): string {
  if (!html) return '';
  const withoutTags = html.replace(/<[^>]*>/g, '');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** Extract the contents of the first `<title>` element. */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = toText(match[1]);
  return title || undefined;
}
