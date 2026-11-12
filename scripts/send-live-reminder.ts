// Sends the REAL daily reminder to your own account, right now, through the
// deployed daily-reminders function: the same path the hourly job uses.
//
//   npm run email:live
//
// It makes your account (REMINDER_TO in .env.reminders.local) look due for a
// moment, by pointing its reminder time zone at a zone where it is 10:00 on the
// same date and clearing today's "already sent" mark, calls the function, then
// puts your time zone back. Only your own row is edited. Because it runs the
// real job, any other account that is due at this moment is emailed too, as it
// would be at five past the hour anyway.
//
// Needs the migrations applied and both functions deployed. Asks, hidden, for
// the service-role key and the cron secret unless SUPABASE_SERVICE_ROLE_KEY and
// REMINDER_CRON_SECRET are set.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
import { localDay } from "../src/planner/time.ts";

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    output._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

for (const file of ["../.env.reminders.local", "../.env"]) {
  const path = new URL(file, import.meta.url);
  if (existsSync(path)) process.loadEnvFile(path);
}

const email = process.env.REMINDER_TO;
const url = process.env.VITE_SUPABASE_URL;
if (!email || !url) stop("Set REMINDER_TO in .env.reminders.local and VITE_SUPABASE_URL in .env.");
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  (await askHidden("Supabase service-role key (hidden, Project Settings → API): "));
const cronSecret =
  process.env.REMINDER_CRON_SECRET ||
  (await askHidden("Cron secret, the REMINDER_CRON_SECRET value (hidden): "));
if (!serviceKey || !cronSecret) stop("Both keys are needed; nothing changed or sent.");

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let userId: string | undefined;
for (let page = 1; !userId; page += 1) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) stop(`Could not list accounts: ${error.message}`);
  userId = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase())?.id;
  if (data.users.length < 1000) break;
}
if (!userId) stop(`No prune account uses ${email}.`);

const row = await db
  .from("planner_email_reminders")
  .select("timezone, daily_enabled")
  .eq("user_id", userId)
  .maybeSingle();
if (row.error)
  stop(`Could not read your reminder settings (${row.error.message}). Is the email_reminders migration applied?`);
if (!row.data)
  stop("Your account has no reminder settings yet. Open prune once while signed in, then run this again.");
if (!row.data.daily_enabled)
  stop("Your daily reminder is switched off. Turn it on in Profile → Emails, then run this again.");

const now = Math.floor(Date.now() / 1000);
const homeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDay(now, homeZone);
const pending = await db
  .from("planner_tasks")
  .select("outcome")
  .eq("user_id", userId)
  .eq("planned_for", today)
  .in("status", ["planned", "active"])
  .order("slot");
if (pending.error) stop(`Could not read tasks: ${pending.error.message}`);
if (!pending.data.length)
  stop(`No unfinished tasks for ${today}, so the job would send you nothing. Add a task to Today in prune and run this again.`);
console.log(`Found ${pending.data.length} unfinished task(s) for ${today}.`);

// A zone where it is 10:00 on your date: inside the job's 09:00-11:59 window.
const hourIn = (zone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(now * 1000));
const dueZone = Intl.supportedValuesOf("timeZone").find(
  (zone) => hourIn(zone) === 10 && localDay(now, zone) === today,
);
if (!dueZone) stop("Could not find a time zone where it is 10:00 on your date. Try again in a few minutes.");

const original = row.data.timezone as string;
const mark = await db
  .from("planner_email_reminders")
  .update({ timezone: dueZone, last_daily_on: null })
  .eq("user_id", userId);
if (mark.error) stop(`Could not prepare your account: ${mark.error.message}`);

let outcome = "";
try {
  const response = await fetch(new URL("/functions/v1/daily-reminders", url), {
    method: "POST",
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(120_000),
  });
  outcome = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
} catch (error) {
  outcome = `The function could not be reached: ${(error as Error).message}`;
} finally {
  const restore = await db
    .from("planner_email_reminders")
    .update({ timezone: original })
    .eq("user_id", userId);
  if (restore.error)
    console.error(`Could not put your time zone back to ${original}; opening prune will fix it.`);
}

console.log(`The job answered: ${outcome}`);
const hints: [RegExp, string][] = [
  [/^HTTP 200.*"sent":[1-9]/, `Sent. Check the inbox and spam folder of ${email}.`],
  [/^HTTP 200/, "The job ran but sent nothing. Check Brevo → Transactional → Logs, and that your task is in Today and unfinished."],
  [/^HTTP 401/, "Wrong cron secret: it does not match REMINDER_CRON_SECRET on Supabase."],
  [/^HTTP 404/, "The daily-reminders function is not deployed on this project."],
  [/claim_failed/, "The function ran but could not start: BREVO_API_KEY or REMINDER_FROM_EMAIL is missing on Supabase, or the migration is not applied."],
  [/provider_refused/, "Brevo refused the account: check the key's Transactional permission, Authorised IPs and credits."],
];
console.log(hints.find(([pattern]) => pattern.test(outcome))?.[1] ?? "Unexpected answer; share this line with Claude (it contains no secrets).");
