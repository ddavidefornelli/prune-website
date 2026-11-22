// Supabase Edge Function (Deno). Turns one kind of reminder email off for the
// holder of an unsubscribe token. Deploy with JWT verification off: mail
// providers call it directly for one-click unsubscribe.
// Secrets: optional ALLOWED_ORIGINS (default https://www.prune.win) and
// EXTRA_ALLOWED_ORIGINS, the website origins whose confirmation page may call
// it; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AllowedOrigins,
  UnsubscribeEndpoint,
} from "../../../server/reminders/handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const endpoint = new UnsubscribeEndpoint({
  allowedOrigins: AllowedOrigins.fromEnvironment(
    env("ALLOWED_ORIGINS"),
    env("EXTRA_ALLOWED_ORIGINS"),
  ),
  async unsubscribe(token, kind) {
    const { error } = await db.rpc("planner_unsubscribe", {
      p_token: token,
      p_kind: kind,
    });
    if (error) throw new Error("Unsubscribe failed");
  },
});

Deno.serve(endpoint.handle);
