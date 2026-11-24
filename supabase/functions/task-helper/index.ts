// Supabase Edge Function (Deno). "Do it for me": sorts tasks, asks
// this-or-that questions and writes answers with a language model in the background
// (see server/helper/endpoint.ts). Deploy with JWT verification off: it
// checks each caller's access token itself, and browsers' CORS preflights
// carry no token.
// Secrets: HELPER_API_KEY (an OpenRouter key by default); optional
// HELPER_API_URL and HELPER_MODEL (any OpenAI-compatible chat completions
// host and model; default OpenRouter and DeepSeek V4.1 Flash); optional ALLOWED_ORIGINS (default
// https://www.prune.win) and EXTRA_ALLOWED_ORIGINS, the website origins that
// may call it. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { HelperEndpoint, type StoredRun } from "../../../server/helper/endpoint.ts";
import { HELPER } from "../../../server/constants.ts";
import { HelperModel } from "../../../server/helper/model.ts";
import { AllowedOrigins } from "../../../server/reminders/handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };

const env = (name: string) => Deno.env.get(name);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUNS = "planner_helper_runs";
const modelUrl = env("HELPER_API_URL") || HELPER.defaultUrl;

interface RunRow {
  task_id: string;
  title: string;
  kind: StoredRun["kind"];
  context: string[];
  picks: StoredRun["picks"];
  locale: StoredRun["locale"];
  status: StoredRun["status"];
  first_answer: string | null;
  answer: string | null;
  sources: StoredRun["sources"];
  turns: StoredRun["turns"];
  error: string | null;
  updated_at: string;
}

const fromRow = (row: RunRow): StoredRun => ({
  taskId: row.task_id,
  title: row.title,
  kind: row.kind,
  context: row.context,
  picks: row.picks,
  locale: row.locale,
  status: row.status,
  first: row.first_answer,
  answer: row.answer,
  sources: row.sources,
  turns: row.turns,
  error: row.error,
  updatedAt: Date.parse(row.updated_at),
});

const endpoint = new HelperEndpoint({
  allowedOrigins: AllowedOrigins.fromEnvironment(env("ALLOWED_ORIGINS"), env("EXTRA_ALLOWED_ORIGINS")),
  brain: new HelperModel({
    url: modelUrl,
    apiKey: env("HELPER_API_KEY") ?? "",
    model: env("HELPER_MODEL") || HELPER.defaultModel,
    extra: new URL(modelUrl).hostname === "openrouter.ai" ? { provider: HELPER.openRouterProvider } : undefined,
  }),
  background: (work) => EdgeRuntime.waitUntil(work),
  async authenticate(token) {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, guest: Boolean(data.user.is_anonymous) };
  },
  store: {
    async claim(user, kind) {
      const { data, error } = await db.rpc("planner_helper_claim", {
        p_user: user.id,
        p_guest: user.guest,
        p_kind: kind,
      });
      if (error) throw new Error("Claim failed");
      return data as "ok" | "daily_limit";
    },
    async runs(userId, taskIds) {
      if (!taskIds.length) return [];
      const { data, error } = await db.from(RUNS).select("*").eq("user_id", userId).in("task_id", taskIds);
      if (error) throw new Error("Read failed");
      return (data as RunRow[]).map(fromRow);
    },
    async save(userId, run) {
      const { error } = await db.from(RUNS).upsert({
        user_id: userId,
        task_id: run.taskId,
        title: run.title,
        kind: run.kind,
        context: run.context,
        picks: run.picks,
        locale: run.locale,
        status: run.status,
        first_answer: run.first,
        answer: run.answer,
        sources: run.sources,
        turns: run.turns,
        error: run.error,
        updated_at: new Date(run.updatedAt).toISOString(),
      });
      if (error) throw new Error("Save failed");
    },
    async remove(userId, taskId) {
      const { error } = await db.from(RUNS).delete().eq("user_id", userId).eq("task_id", taskId);
      if (error) throw new Error("Delete failed");
    },
    async erase(userId) {
      const { error } = await db.from(RUNS).delete().eq("user_id", userId);
      if (error) throw new Error("Erase failed");
    },
  },
});

Deno.serve(endpoint.handle);
