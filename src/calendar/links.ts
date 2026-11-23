/** A link found in a description. */
export interface Link {
  href: string;
  /** The address without its scheme, for showing. */
  label: string;
}

const URL_LIKE = /\bhttps?:\/\/[^\s<>"']+/gi;
/** Punctuation that ends a sentence rather than an address. */
const TRAILING = /[.,;:!?)\]}]+$/;
const MOST = 10;

/** The web addresses in a description: http and https only, each once. */
export function findLinks(text: string): Link[] {
  const found = new Map<string, Link>();
  for (const match of text.matchAll(URL_LIKE)) {
    const raw = match[0].replace(TRAILING, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const label = `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    if (!found.has(url.href)) found.set(url.href, { href: url.href, label });
    if (found.size >= MOST) break;
  }
  return [...found.values()];
}
