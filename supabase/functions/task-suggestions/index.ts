// Supabase Edge Function (Deno). Secrets: OPENAI_API_KEY, ALLOWED_ORIGINS and
// optional EXTRA_ALLOWED_ORIGINS (added to, never replacing, the shared list);
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { PostHogAiObserver } from "../ai-observability.ts";
import { HTTP_STATUS } from "../../../src/shared/api-routes.ts";
import { CalendarDay } from "../../../src/shared/calendar-day.ts";
import { TIME } from "../../../src/shared/time-constants.ts";
import { AllowedOrigins, ApiError } from "../../../server/http.ts";
import { OpenAiChat } from "../../../server/openai.ts";
import { TaskSuggestionEndpoint } from "../../../server/task-suggestions/handler.ts";
import {
  SuggestionProvider,
  type SuggestionTask,
} from "../../../server/task-suggestions/provider.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const aiObserver = PostHogAiObserver.create(
  env("VITE_POSTHOG_KEY"),
  env("VITE_POSTHOG_HOST"),
  env("NODE_ENV") === "production",
);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const endpoint = new TaskSuggestionEndpoint({
  allowedOrigins: AllowedOrigins.fromEnvironment(
    env("ALLOWED_ORIGINS"),
    env("EXTRA_ALLOWED_ORIGINS"),
  ),
  async authenticate(token) {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user)
      throw new ApiError(
        HTTP_STATUS.unauthorized,
        "unauthorized",
        "Your session has expired.",
      );
    return data.user.id;
  },
  async loadInput(userId, timezone, target) {
    let today: CalendarDay;
    try {
      today = CalendarDay.local(Math.floor(Date.now() / TIME.msPerSecond), timezone);
    } catch {
      throw new ApiError(HTTP_STATUS.badRequest, "invalid_request", "Unknown timezone.");
    }
    const day = target === "tomorrow" ? today.next() : today;
    const sourceDay = day.previous();
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
      .select("outcome, status, estimated_minutes, actual_seconds, planned_for")
      .eq("user_id", userId)
      .in("planned_for", [sourceDay.key, day.key])
      .order("slot");
    if (rows.error) throw new Error("Task lookup failed");
    const on = (planned: CalendarDay): SuggestionTask[] =>
      rows.data
        .filter((row) => row.planned_for === planned.key)
        .map((row) => ({
          outcome: row.outcome,
          status: row.status,
          estimatedMinutes: row.estimated_minutes,
          actualSeconds: row.actual_seconds,
        }));
    return {
      day: day.key,
      sourceDay: sourceDay.key,
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
  generate(input, userId) {
    const key = env("OPENAI_API_KEY");
    if (!key) throw new Error("AI is not configured");
    const chat = new OpenAiChat(
      key,
      undefined,
      aiObserver
        ? {
            observer: aiObserver,
            distinctId: `${new URL(env("SUPABASE_URL")!).origin}:${userId}`,
          }
        : undefined,
    );
    return new SuggestionProvider(chat).generate(input);
  },
});

Deno.serve(endpoint.handle);
