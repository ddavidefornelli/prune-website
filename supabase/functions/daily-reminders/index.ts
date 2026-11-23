// Supabase Edge Function (Deno), called by pg_cron every hour (see the
// email_reminders_cron and retire_day_planner migrations). Sends the daily
// come-back notification to browsers that allowed them (see daily_push), the
// weekly come-back email, and the same nudge as a notification with it. Called
// every minute with {"job": "starts"} (task_start_alerts_cron), it sends only
// the alerts for planned tasks starting in 5 minutes. Deploy with JWT
// verification off; it checks its own shared secret instead.
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL (a sender verified in Brevo),
// REMINDER_CRON_SECRET, optional SITE_URL and REMINDER_BATCH_LIMIT (emails per
// run, default 100: Brevo's free plan allows 300 a day). Optional
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:you@domain)
// keep push working for existing subscriptions: never replace the key pair, or
// every subscription stops. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SUPABASE_ROUTES } from "../../../src/shared/api-routes.ts";
import { SITE } from "../../../src/shared/site.ts";
import { REMINDERS, START_ALERTS } from "../../../server/constants.ts";
import { BrevoMailer } from "../../../server/reminders/brevo.ts";
import { DailyPushJob, type DailyTarget } from "../../../server/reminders/daily-push.ts";
import type { Reminder } from "../../../server/reminders/email.ts";
import { ReminderJob } from "../../../server/reminders/handler.ts";
import { StartAlertJob, type StartAlert } from "../../../server/reminders/start-alerts.ts";
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

const siteUrl = env("SITE_URL") || SITE.url;

const daily = pushSender
  ? new DailyPushJob({
      siteUrl,
      async claim() {
        const { data, error } = await db.rpc("planner_claim_daily_pushes", {
          p_limit: REMINDERS.maxDailyPushes,
        });
        if (error) throw new Error("Daily claim failed");
        return data as DailyTarget[];
      },
      send: (target, payload) => pushSender.send(target, payload),
      async record(endpoint, result) {
        await db.rpc("planner_push_result", {
          p_endpoint: endpoint,
          p_result: result,
        });
      },
    })
  : undefined;

const unsubscribeEndpoint = `${env("SUPABASE_URL")}${SUPABASE_ROUTES.emailUnsubscribe}`;
const pushDelivery = pushSender
  ? {
      async targets(userIds: string[]) {
        const { data, error } = await db.rpc("planner_push_targets", { p_users: userIds });
        if (error) throw new Error("Push targets failed");
        return (data as { user_id: string; endpoint: string; p256dh: string; auth: string }[]).map((row) => ({
          userId: row.user_id,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
        }));
      },
      send: (target: Parameters<WebPushSender["send"]>[0], payload: Parameters<WebPushSender["send"]>[1]) =>
        pushSender.send(target, payload),
      async record(endpoint: string, result: string) {
        await db.rpc("planner_push_result", { p_endpoint: endpoint, p_result: result });
      },
    }
  : undefined;

const starts = new StartAlertJob({
  siteUrl,
  unsubscribeEndpoint,
  async claim() {
    const { data, error } = await db.rpc("planner_claim_start_alerts", { p_limit: START_ALERTS.maxPerRun });
    if (error) throw new Error("Start alert claim failed");
    return (
      data as {
        user_id: string; task_id: string; title: string; notes: string; start_at: string; minutes: number;
        space_name: string | null; timezone: string; email: string | null; unsubscribe_token: string | null;
      }[]
    ).map(
      (row): StartAlert => ({
        userId: row.user_id,
        taskId: row.task_id,
        title: row.title,
        notes: row.notes,
        startAt: Date.parse(row.start_at),
        minutes: row.minutes,
        spaceName: row.space_name,
        timezone: row.timezone,
        email: row.email,
        unsubscribeToken: row.unsubscribe_token,
      }),
    );
  },
  push: pushDelivery,
  // Without a configured sender, alerts go by notification only.
  send: env("BREVO_API_KEY") && env("REMINDER_FROM_EMAIL") ? (email) => mailer.send(email) : undefined,
});

const job = new ReminderJob({
  starts,
  secret: env("REMINDER_CRON_SECRET") ?? "",
  siteUrl,
  daily,
  unsubscribeEndpoint,
  async claim() {
    // Claim nothing while sending is not configured, so no reminder is lost.
    if (!env("BREVO_API_KEY") || !env("REMINDER_FROM_EMAIL"))
      throw new Error("Email is not configured");
    const { data, error } = await db.rpc("planner_claim_reminders", {
      p_limit: limit,
    });
    if (error) throw new Error("Claim failed");
    // Only the come-back email is sent; any other kind a claim function from
    // before 20261125000100 returns has nothing true to say any more.
    return (
      data as { user_id: string; email: string; kind: string; unsubscribe_token: string }[]
    )
      .filter((row) => row.kind === "comeback")
      .map(
        (row): Reminder => ({
          userId: row.user_id,
          email: row.email,
          kind: "comeback",
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
  push: pushDelivery,
  send: (email) => mailer.send(email),
});

Deno.serve(job.handle);
