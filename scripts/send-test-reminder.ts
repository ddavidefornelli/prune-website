// Sends one sample reminder email through Brevo, to check the key, the sender
// and how the email looks in a real inbox. Touches no database and no users.
//
//   npm run email:test              (daily reminder)
//   npm run email:test -- comeback  (weekly "hop back in" email)
//   npm run email:test -- real      (your real unfinished tasks for today)
//
// `real` reads, never writes, the production planner: it looks up the account
// for REMINDER_TO and today's planned/active tasks in this Mac's time zone. It
// needs the project's service-role key (asked for hidden, or
// SUPABASE_SERVICE_ROLE_KEY), because the reminder job reads with it too.
//
// Addresses come from the git-ignored .env.reminders.local (REMINDER_TO,
// REMINDER_FROM_EMAIL), or from the environment. The Brevo API key is asked
// for without echoing, unless BREVO_API_KEY is set in either place.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
import { localDay } from "../src/planner/time.ts";
import { sendWithBrevo } from "../server/reminders/brevo.ts";
import { buildReminderEmail, type ReminderKind } from "../server/reminders/email.ts";
import { oneClickUrl } from "../server/reminders/handler.ts";

const SAMPLE_TOKEN = "00000000-0000-4000-8000-000000000000";

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

const LOCAL_SETTINGS = new URL("../.env.reminders.local", import.meta.url);
if (existsSync(LOCAL_SETTINGS)) process.loadEnvFile(LOCAL_SETTINGS);

const PROJECT_SETTINGS = new URL("../.env", import.meta.url);
if (existsSync(PROJECT_SETTINGS)) process.loadEnvFile(PROJECT_SETTINGS);

const mode = process.argv[2] ?? "daily";
const kind: ReminderKind = mode === "comeback" ? "comeback" : "daily";
const to = process.env.REMINDER_TO;
const from = process.env.REMINDER_FROM_EMAIL;
if (!["daily", "comeback", "real"].includes(mode) || !to || !from) {
  console.error("Usage: npm run email:test [-- daily|comeback|real]. Set REMINDER_TO and REMINDER_FROM_EMAIL in .env.reminders.local.");
  process.exit(2);
}
const apiKey = process.env.BREVO_API_KEY || (await askHidden("Brevo API key (hidden): "));
if (!apiKey) {
  console.error("No API key given; nothing sent.");
  process.exit(2);
}

/** Today's unfinished tasks for REMINDER_TO, exactly as the reminder job selects them. */
async function realTasks(email: string): Promise<string[]> {
  const url = process.env.VITE_SUPABASE_URL;
  if (!url) throw new Error("VITE_SUPABASE_URL is not set in .env.");
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (await askHidden("Supabase service-role key (hidden, Project Settings → API): "));
  if (!serviceKey) throw new Error("No service-role key given; nothing read or sent.");
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let userId: string | undefined;
  for (let page = 1; !userId; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list accounts: ${error.message}`);
    userId = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase())?.id;
    if (data.users.length < 1000) break;
  }
  if (!userId) throw new Error(`No prune account uses ${email}.`);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDay(Math.floor(Date.now() / 1000), timezone);
  const { data, error } = await db
    .from("planner_tasks")
    .select("outcome")
    .eq("user_id", userId)
    .eq("planned_for", today)
    .in("status", ["planned", "active"])
    .order("slot");
  if (error) throw new Error(`Could not read tasks: ${error.message}`);
  console.log(`Found ${data.length} unfinished task(s) for ${today} (${timezone}).`);
  return data.map((row) => String(row.outcome));
}

let tasks: string[] = [];
if (mode === "real") {
  try {
    tasks = await realTasks(to);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  if (!tasks.length) {
    console.log("Nothing pending today, so the real job would send no email. Add a task in prune and run this again.");
    process.exit(0);
  }
} else if (kind === "daily") {
  tasks = ["Finish the landing page copy", "Call the accountant about Q4", "30 min run"];
}

const reminder = {
  userId: "test",
  email: to,
  kind,
  tasks,
  unsubscribeToken: SAMPLE_TOKEN,
};
// Which kind of key this is, without revealing it: API keys start "xkeysib-",
// SMTP keys (the sign-in emails' kind) start "xsmtpsib-" and do not work here.
const keyKind = apiKey.startsWith("xkeysib-")
  ? "an API key (xkeysib-…), the right kind"
  : apiKey.startsWith("xsmtpsib-")
    ? "an SMTP key (xsmtpsib-…): this is the WRONG kind, create an API key under SMTP & API → API Keys"
    : "not a recognised Brevo key format; check you copied the whole key with no spaces";
console.log(`Key looks like ${keyKind}.`);

// Keep Brevo's own error text for this test only; it never contains the key.
let failure = "";
const fetcher: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok)
    failure = `HTTP ${response.status}: ${(await response.clone().text()).slice(0, 500)}`;
  return response;
};
const site = process.env.SITE_URL || "https://www.prune.win/";
const email = buildReminderEmail(reminder, site);
const result = await sendWithBrevo(
  {
    ...email,
    subject: `[TEST] ${email.subject}`,
    to,
    kind,
    oneClickUrl: oneClickUrl("https://example.invalid/email-unsubscribe", reminder),
  },
  { apiKey, fromEmail: from, fetcher },
);
const meaning = {
  sent: "Brevo accepted it. Check the inbox (and spam) of the address you gave.",
  halt: "Brevo refused the account (401/402/403): check the API key, that Authorised IPs is off, and your credits.",
  rejected: "Brevo rejected this email (4xx): check that the sender is verified in Brevo and the address is valid.",
  retry: "Brevo was unreachable or rate-limited (network, 429 or 5xx). Try again in a minute.",
}[result];
console.log(`${result}: ${meaning}`);
if (failure) console.log(`Brevo said: ${failure}`);
process.exit(result === "sent" ? 0 : 1);
