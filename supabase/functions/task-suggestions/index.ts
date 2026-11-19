// Supabase Edge Function (Deno). Secrets: OPENAI_API_KEY, ALLOWED_ORIGINS and
// optional EXTRA_ALLOWED_ORIGINS (added to, never replacing, the shared list);
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiGenerationObserver } from "../ai-observability.ts";
import { ApiError } from "../../../server/http.ts";
import { createHandler } from "../../../server/task-suggestions/handler.ts";
import {
  generateSuggestions,
  type SuggestionTask,
} from "../../../server/task-suggestions/provider.ts";
import { localDay, nextDay, previousDay } from "../../../src/planner/time.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const aiObserver = createAiGenerationObserver(
  env("VITE_POSTHOG_KEY"),
  env("VITE_POSTHOG_HOST"),
  env("NODE_ENV") === "production",
);
const db = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
const origins = new Set(
  [
    env("ALLOWED_ORIGINS") || "https://www.prune.win",
    env("EXTRA_ALLOWED_ORIGINS"),
  ]
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

Deno.serve(
  createHandler({
    allowedOrigins: origins,
    async authenticate(token) {
      const { data, error } = await db.auth.getUser(token);
      if (error || !data.user)
        throw new ApiError(401, "unauthorized", "Your session has expired.");
      return data.user.id;
    },
    async loadInput(userId, timezone, target) {
      let today: string;
      try {
        today = localDay(Math.floor(Date.now() / 1000), timezone);
      } catch {
        throw new ApiError(400, "invalid_request", "Unknown timezone.");
      }
      const day = target === "tomorrow" ? nextDay(today) : today;
      const sourceDay = previousDay(day);
      const account = await db
        .from("planner_accounts")
        .select('ai_enabled, "isDeleted"')
        .eq("user_id", userId)
        .maybeSingle();
      if (account.error) throw new Error("Account lookup failed");
      if (!account.data?.ai_enabled || account.data.isDeleted)
        return { disabled: true };
      const rows = await db
        .from("planner_tasks")
        .select(
          "outcome, status, estimated_minutes, actual_seconds, planned_for",
        )
        .eq("user_id", userId)
        .in("planned_for", [sourceDay, day])
        .order("slot");
      if (rows.error) throw new Error("Task lookup failed");
      const on = (planned: string): SuggestionTask[] =>
        rows.data
          .filter((row) => row.planned_for === planned)
          .map((row) => ({
            outcome: row.outcome,
            status: row.status,
            estimatedMinutes: row.estimated_minutes,
            actualSeconds: row.actual_seconds,
          }));
      return {
        day,
        sourceDay,
        sourceTasks: on(sourceDay),
        plannedTasks: on(day),
      };
    },
    async reserve(userId, day) {
      const { data, error } = await db.rpc("planner_reserve_suggestion", {
        p_user_id: userId,
        p_day: day,
      });
      if (error) throw new Error("Reservation failed");
      return data === true;
    },
    async generate(input, userId) {
      const key = env("OPENAI_API_KEY");
      if (!key) throw new Error("AI is not configured");
      return generateSuggestions(
        input,
        key,
        undefined,
        aiObserver
          ? {
              observer: aiObserver,
              distinctId: `${new URL(env("SUPABASE_URL")!).origin}:${userId}`,
            }
          : undefined,
      );
    },
  }),
);
