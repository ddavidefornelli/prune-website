import { handleErrorLog } from "./error-log.ts";

// Replaced at bundle time with the same public values the website is built with.
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLIC_KEY__: string;

/** Vercel Edge Function entry for /api/error-log. */
export default function handler(request: Request): Promise<Response> {
  return handleErrorLog(request, {
    url: __SUPABASE_URL__,
    publicKey: __SUPABASE_PUBLIC_KEY__,
  });
}
