// Supabase Edge Function (Deno). Turns one kind of reminder email off for the
// holder of an unsubscribe token. Deploy with JWT verification off: mail
// providers call it directly for one-click unsubscribe.
// Secrets: ALLOWED_ORIGINS and optional EXTRA_ALLOWED_ORIGINS, as for
// task-suggestions; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createUnsubscribeHandler } from "../../../server/reminders/handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origins = new Set(
  [env("ALLOWED_ORIGINS") || "https://www.prune.win", env("EXTRA_ALLOWED_ORIGINS")]
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

Deno.serve(
  createUnsubscribeHandler({
    allowedOrigins: origins,
    async unsubscribe(token, kind) {
      const { error } = await db.rpc("planner_unsubscribe", {
        p_token: token,
        p_kind: kind,
      });
      if (error) throw new Error("Unsubscribe failed");
    },
  }),
);
