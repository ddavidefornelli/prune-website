// Supabase Edge Function (Deno), called every ten minutes by pg_cron (see the
// email_reminders_cron and reminders_every_ten_minutes migrations). Deploy with
// JWT verification off; it checks its own shared secret instead.
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL (a sender verified in Brevo),
// REMINDER_CRON_SECRET, optional SITE_URL and REMINDER_BATCH_LIMIT (emails per
// run, default 100: Brevo's free plan allows 300 a day, shared with sign-in
// codes). Optional VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT
// (mailto:you@domain) turn on browser push; generate them with
// `npm run push:keys`, and give the website the same public key as
// VITE_VAPID_PUBLIC_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SUPABASE_ROUTES } from "../../../src/shared/api-routes.ts";
import { SITE } from "../../../src/shared/site.ts";
import { REMINDERS } from "../../../server/constants.ts";
import { BrevoMailer } from "../../../server/reminders/brevo.ts";
import type { Reminder, ReminderKind } from "../../../server/reminders/email.ts";
import { ReminderJob } from "../../../server/reminders/handler.ts";
import { WebPushSender } from "../../../server/reminders/web-push.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const env = (name: string) => Deno.env.get(name);
const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const limit = Math.min(
  Math.max(
    Number.parseInt(env("REMINDER_BATCH_LIMIT") ?? "", 10) || REMINDERS.defaultBatch,
    1,
  ),
  REMINDERS.maxBatch,
);
const pushSender =
  env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY") && env("VAPID_SUBJECT")
    ? new WebPushSender({
        publicKey: env("VAPID_PUBLIC_KEY")!,
        privateKey: env("VAPID_PRIVATE_KEY")!,
        subject: env("VAPID_SUBJECT")!,
      })
    : null;
const mailer = new BrevoMailer({
  apiKey: env("BREVO_API_KEY") ?? "",
  fromEmail: env("REMINDER_FROM_EMAIL") ?? "",
});

const job = new ReminderJob({
  secret: env("REMINDER_CRON_SECRET") ?? "",
  siteUrl: env("SITE_URL") || SITE.url,
  unsubscribeEndpoint: `${env("SUPABASE_URL")}${SUPABASE_ROUTES.emailUnsubscribe}`,
  async claim() {
    // Claim nothing while sending is not configured, so no reminder is lost.
    if (!env("BREVO_API_KEY") || !env("REMINDER_FROM_EMAIL"))
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
  push: pushSender
    ? {
        async targets(userIds) {
          const { data, error } = await db.rpc("planner_push_targets", {
            p_users: userIds,
          });
          if (error) throw new Error("Push targets failed");
          return (
            data as { user_id: string; endpoint: string; p256dh: string; auth: string }[]
          ).map((row) => ({
            userId: row.user_id,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
          }));
        },
        send: (target, payload) => pushSender.send(target, payload),
        async record(endpoint, result) {
          await db.rpc("planner_push_result", {
            p_endpoint: endpoint,
            p_result: result,
          });
        },
      }
    : undefined,
  send: (email) => mailer.send(email),
});

Deno.serve(job.handle);
