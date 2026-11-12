// Supabase Edge Function (Deno), called hourly by pg_cron (see the
// email_reminders_cron migration). Deploy with JWT verification off; it checks
// its own shared secret instead.
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL (a sender verified in Brevo),
// REMINDER_CRON_SECRET, optional SITE_URL and REMINDER_BATCH_LIMIT (emails per
// hourly run, default 100: Brevo's free plan allows 300 a day, shared with
// sign-in codes). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendWithBrevo } from "../../../server/reminders/brevo.ts";
import type { Reminder, ReminderKind } from "../../../server/reminders/email.ts";
import { createReminderHandler } from "../../../server/reminders/handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const limit = Math.min(
  Math.max(Number.parseInt(env("REMINDER_BATCH_LIMIT") ?? "", 10) || 100, 1),
  1000,
);

Deno.serve(
  createReminderHandler({
    secret: env("REMINDER_CRON_SECRET") ?? "",
    siteUrl: env("SITE_URL") || "https://www.prune.win/",
    unsubscribeEndpoint: `${env("SUPABASE_URL")}/functions/v1/email-unsubscribe`,
    async claim() {
      const apiKey = env("BREVO_API_KEY");
      // Claim nothing while sending is not configured, so no reminder is lost.
      if (!apiKey || !env("REMINDER_FROM_EMAIL"))
        throw new Error("Email is not configured");
      const { data, error } = await db.rpc("planner_claim_reminders", {
        p_limit: limit,
      });
      if (error) throw new Error("Claim failed");
      return (
        data as {
          user_id: string;
          email: string;
          kind: ReminderKind;
          tasks: string[];
          unsubscribe_token: string;
        }[]
      ).map(
        (row): Reminder => ({
          userId: row.user_id,
          email: row.email,
          kind: row.kind,
          tasks: row.tasks,
          unsubscribeToken: row.unsubscribe_token,
        }),
      );
    },
    async release(userId, kind) {
      const { error } = await db.rpc("planner_release_reminder", {
        p_user_id: userId,
        p_kind: kind,
      });
      if (error) throw new Error("Release failed");
    },
    send: (email) =>
      sendWithBrevo(email, {
        apiKey: env("BREVO_API_KEY")!,
        fromEmail: env("REMINDER_FROM_EMAIL")!,
      }),
  }),
);
