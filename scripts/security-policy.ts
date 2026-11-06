import { createHash } from "node:crypto";
import { hasMarketingTracker } from "./tracking-policy.ts";
import { PRODUCTION_ORIGINS } from "../src/shared/site.ts";
import { SUPABASE_ROUTES } from "../src/shared/api-routes.ts";

// Deliberately no origin-wide allowlist: do not permit Storage, arbitrary RPCs,
// other Edge Functions, Realtime or another Supabase tenant.
export const API_PATHS = Object.values(SUPABASE_ROUTES);

// Exceptions for managed (non-SRI-pinned) analytics scripts.
export const ANALYTICS_ORIGINS = PRODUCTION_ORIGINS;
export const ANALYTICS_SCRIPTS = ANALYTICS_ORIGINS.map((origin) => `${origin}/_vercel/insights/script.js`);
export const ANALYTICS_CONNECTIONS = ANALYTICS_ORIGINS.map((origin) => `${origin}/_vercel/insights/`);
export const CONTENTSQUARE_SCRIPTS = ["https://*.contentsquare.net", "https://app.contentsquare.com"];
export const CONTENTSQUARE_CONNECTIONS = ["https://*.contentsquare.net", "https://*.contentsquare.com"];
export const CONTENTSQUARE_IMAGES = ["https://*.contentsquare.net"];
// Session Replay's Static Resource Manager fetch()es the page's own CSS, fonts
// and images to upload them, so replays keep rendering after a deploy removes
// the old hashed assets. Static paths only: not 'self', which includes /api/.
export const CONTENTSQUARE_RESOURCES = PRODUCTION_ORIGINS.flatMap((origin) =>
  ["/assets/", "/fonts/", "/prune-background.png", "/prune-background.webp", "/prune-background-mask.png", "/favicon.png", "/apple-touch-icon.png"].map((path) => `${origin}${path}`));

export function integrity(content: string | Uint8Array): string {
  return `sha384-${createHash("sha384").update(content).digest("base64")}`;
}

export function securityHeaders(apiOrigin: string, scriptHashes: string[]): Record<string, string> {
  const url = new URL(apiOrigin);
  if (url.protocol !== "https:" || url.origin !== apiOrigin) {
    throw new Error("Production CSP requires an exact HTTPS Supabase origin.");
  }
  if (!scriptHashes.length || scriptHashes.some((hash) => !/^sha384-[A-Za-z0-9+/]{64}$/.test(hash))) {
    throw new Error("Production CSP requires SHA-384 hashes for the built scripts.");
  }
  const policy = [
    "default-src 'none'",
    // App scripts remain hash-pinned; managed analytics sources are explicit exceptions.
    `script-src ${[...new Set(scriptHashes)].map((hash) => `'${hash}'`).join(" ")} ${[...ANALYTICS_SCRIPTS, ...CONTENTSQUARE_SCRIPTS].join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    `connect-src ${[...API_PATHS.map((path) => `${apiOrigin}${path}`), ...ANALYTICS_CONNECTIONS, ...CONTENTSQUARE_CONNECTIONS, ...CONTENTSQUARE_RESOURCES].join(" ")}`,
    `img-src 'self' ${CONTENTSQUARE_IMAGES.join(" ")}`,
    "font-src 'self'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  return {
    "Content-Security-Policy": policy,
    "Strict-Transport-Security": "max-age=31536000",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
    "X-Frame-Options": "DENY",
  };
}

// This is a strict contract for generated build tags, not an HTML sanitizer.
// Reject duplicate/unknown attributes instead of guessing how a browser parses
// them (e.g. data-src must never be mistaken for src).
function assetAttributes(tag: string, element: "script" | "link"): Map<string, string> {
  const opening = new RegExp(`^<${element}\\b([^>]*)>`, "i").exec(tag);
  if (!opening) throw new Error("Unexpected HTML asset tag.");
  const raw = opening[1]!.replace(/\s*\/$/, "");
  const attributes = new Map<string, string>();
  const pattern = /\s+([a-z][a-z0-9-]*)(?:="([^"<>]*)")?/gi;
  const allowed = new Set(element === "script" ? ["type", "src", "crossorigin", "integrity"] : ["rel", "href", "crossorigin", "integrity", "type", "sizes"]);
  let end = 0;
  for (const match of raw.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (match.index !== end || !allowed.has(name) || attributes.has(name) || (match[2] === undefined && name !== "crossorigin")) {
      throw new Error("Unexpected or duplicate HTML asset attribute.");
    }
    attributes.set(name, match[2] ?? "");
    end = match.index + match[0].length;
  }
  if (raw.slice(end).trim() || (attributes.has("crossorigin") && !["", "anonymous"].includes(attributes.get("crossorigin")!))) {
    throw new Error("Unexpected HTML asset attributes or credential mode.");
  }
  return attributes;
}

/** Harden Vite's final HTML, or revalidate the exact artifact before packaging. */
export function hardenHtml(html: string, assets: Map<string, string | Uint8Array>, apiOrigin: string, { verify = false } = {}): {
  html: string; headers: Record<string, string>;
} {
  if (hasMarketingTracker(html)) throw new Error("Marketing tracker integration in production HTML.");
  for (const [path, content] of assets) {
    if (/\.(?:[cm]?js|css|html|json)$/i.test(path) && hasMarketingTracker(typeof content === "string" ? content : new TextDecoder().decode(content))) {
      throw new Error(`Marketing tracker integration in built asset: ${path}`);
    }
  }
  const hashes: string[] = [];
  const assetIntegrity = (tag: string, element: "script" | "link"): string => {
    const attributes = assetAttributes(tag, element);
    const script = element === "script";
    const path = attributes.get(script ? "src" : "href");
    const content = path && /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path) && assets.get(path.slice(1));
    if (!content || !path?.endsWith(script ? ".js" : ".css") || attributes.get(script ? "type" : "rel") !== (script ? "module" : "stylesheet")) {
      throw new Error("Cannot integrity-pin an unexpected HTML asset.");
    }
    const hash = integrity(content);
    if (verify ? attributes.get("integrity") !== hash : attributes.has("integrity")) {
      throw new Error("Missing, unexpected or mismatched asset integrity.");
    }
    return hash;
  };
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
    if (!/^<script\b[^>]*\btype="module"[^>]*>\s*<\/script>$/i.test(tag)) {
      throw new Error("Production HTML may contain only external module entry scripts.");
    }
    const hash = assetIntegrity(tag, "script");
    hashes.push(hash);
    return verify ? tag : tag.replace(/^<script\b/i, `<script integrity="${hash}"`);
  });
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const attributes = assetAttributes(tag, "link");
    if (attributes.get("rel") !== "stylesheet") {
      // Only non-executable, same-origin icon metadata is expected alongside
      // styles. Do not silently miss a differently quoted/encoded stylesheet,
      // module preload or a newly introduced resource hint.
      if (!["icon", "apple-touch-icon"].includes(attributes.get("rel") ?? "") || !/^\/(?!\/)[A-Za-z0-9_./-]+$/.test(attributes.get("href") ?? "")) {
        throw new Error("Unexpected production HTML link.");
      }
      return tag;
    }
    const hash = assetIntegrity(tag, "link");
    return verify ? tag : tag.replace(/^<link\b/i, `<link integrity="${hash}"`);
  });
  if ((html.match(/<script\b/gi) ?? []).length !== hashes.length || /<style\b|<base\b|\s(?:style|on\w+)\s*=/i.test(html)) {
    throw new Error("Unexpected inline executable content in production HTML.");
  }
  const headers = securityHeaders(apiOrigin, hashes);
  // frame-ancestors is HTTP-only. The upgrade directive stays in HTTPS response
  // headers, not meta, so the same artifact also works on HTTP loopback preview.
  // Other restrictions provide a meta fallback, not a substitute for headers.
  const metaPolicy = headers["Content-Security-Policy"]!
    .replace("; frame-ancestors 'none'", "")
    .replace("; upgrade-insecure-requests", "");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${metaPolicy}" />`;
  const policies = html.match(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?Content-Security-Policy\b[^>]*>/gi) ?? [];
  if (!html.includes("<head>")) throw new Error("Production HTML has no head.");
  if (verify) {
    if (policies.length !== 1 || policies[0] !== meta || html.indexOf(meta) > html.search(/<script\b/i)) {
      throw new Error("HTML meta policy does not match its HTTP security policy.");
    }
  } else {
    if (policies.length) throw new Error("Production CSP must be generated, not supplied by the source HTML.");
    html = html.replace("<head>", `<head>\n    ${meta}`);
  }
  return { html, headers };
}
