// Supabase Edge Function (Deno): AI reviews, one per 10 completed tasks.
// Secrets: OPENAI_API_KEY, ALLOWED_ORIGINS and optional EXTRA_ALLOWED_ORIGINS
// (added to, never replacing, the shared list); SUPABASE_URL, SUPABASE_ANON_KEY
// and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// This replaces the copy deployed from ../pro. The database decides which tasks
// a review covers (planner_review_input) and enforces one paid call per batch.
import { createClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "../../../server/http.ts";
import {
  createHandler,
  type Reservation,
} from "../../../server/weekly-review/handler.ts";
import {
  generateReview,
  MODEL,
} from "../../../server/weekly-review/provider.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const openAiKey = env("OPENAI_API_KEY");
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origins = new Set(
  [
    env("ALLOWED_ORIGINS") ||
      "tauri://localhost,http://tauri.localhost,https://tauri.localhost,https://www.prune.win",
    env("EXTRA_ALLOWED_ORIGINS"),
  ]
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const unavailable = () =>
  new ApiError(
    503,
    "unavailable",
    "AI reviews are temporarily unavailable. Your planner is unaffected.",
  );

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw unavailable();
  return data as T;
}

Deno.serve(
  createHandler({
    allowedOrigins: origins,
    async authenticate(token) {
      if (!openAiKey) throw unavailable();
      const { data, error } = await db.auth.getUser(token);
      // Never trust a user id from the request body, and never accept guests.
      if (error || !data.user || data.user.is_anonymous || !data.user.email)
        throw new ApiError(401, "unauthorized", "Your session has expired. Please sign in again.");
      return data.user.id;
    },
    loadInput: (userId, timezone, preview = false) =>
      rpc(preview ? "planner_preview_input" : "planner_review_input", {
        p_user_id: userId,
        p_timezone: timezone,
      }),
    reserve(userId, input, hash, preview = false) {
      if (preview)
        return rpc<Reservation>("reserve_review_preview", { p_user_id: userId });
      return rpc<Reservation>("reserve_planner_review", {
        p_user_id: userId,
        p_week_start: input.weekStart,
        p_request_hash: hash,
        p_consent_version: input.consentVersion,
        p_activity: input.activity,
      });
    },
    generate: (input) => generateReview(input, openAiKey!),
    finish: (id, token, analysis, preview = false) =>
      preview
        ? rpc<boolean>("finish_review_preview", { p_id: id, p_lease_token: token })
        : rpc<boolean>("finish_weekly_review", {
            p_id: id,
            p_lease_token: token,
            p_analysis: analysis,
            p_model: MODEL,
          }),
    async fail(id, token, preview = false) {
      await rpc<boolean>(preview ? "fail_review_preview" : "fail_weekly_review", {
        p_id: id,
        p_lease_token: token,
      });
    },
    now: () => new Date(),
  }),
);
