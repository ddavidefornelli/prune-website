import { PRODUCTION_ORIGINS } from "../src/shared/site.ts";

const MAX_BODY_BYTES = 512;
const NAME = /^[a-z_]{1,32}$/;

export interface ErrorLogConfig {
  url: string;
  publicKey: string;
  origins?: readonly string[];
  fetcher?: typeof fetch;
}

/** Coarse browser family only; the raw user agent is never stored or forwarded. */
export function browserFamily(userAgent: string): string {
  if (/Edg(?:A|iOS)?\//.test(userAgent)) return "edge";
  if (/OPR\/|Opera/.test(userAgent)) return "opera";
  if (/SamsungBrowser\//.test(userAgent)) return "samsung";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent)) return "safari";
  return "other";
}

export function deviceType(userAgent: string): string {
  return /Mobi|Android|iPhone|iPad/.test(userAgent) ? "mobile" : "desktop";
}

const empty = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Same-domain relay for client error reports. Runs on the website's host so it
 * still works when a visitor's network blocks Supabase. Adds country (from the
 * host's geo header) and browser family, then forwards to an anon-only RPC.
 */
export async function handleErrorLog(
  request: Request,
  config: ErrorLogConfig,
): Promise<Response> {
  if (request.method !== "POST") return empty(405);
  const origins = config.origins ?? PRODUCTION_ORIGINS;
  if (!origins.includes(request.headers.get("Origin") ?? "")) return empty(403);
  let body: { event?: unknown; context?: unknown; detail?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return empty(413);
    body = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const { event, context, detail } = body ?? {};
  if (
    ![event, context, detail].every(
      (v) => typeof v === "string" && NAME.test(v),
    )
  )
    return empty(400);
  const country = request.headers.get("x-vercel-ip-country") ?? "";
  const userAgent = request.headers.get("User-Agent") ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: config.publicKey,
  };
  // Legacy anon keys are JWTs; publishable keys go in the apikey header only.
  if (!config.publicKey.startsWith("sb_publishable_"))
    headers.Authorization = `Bearer ${config.publicKey}`;
  try {
    const response = await (config.fetcher ?? fetch)(
      `${config.url}/rest/v1/rpc/log_client_error`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_event: event,
          p_context: context,
          p_detail: detail,
          p_country: /^[A-Z]{2}$/.test(country) ? country : "",
          p_browser: browserFamily(userAgent),
          p_device: deviceType(userAgent),
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    return empty(response.ok ? 204 : response.status === 400 ? 400 : 502);
  } catch {
    return empty(502);
  }
}
