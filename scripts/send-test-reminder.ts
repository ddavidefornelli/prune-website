// Sends one sample come-back email through Brevo, to check the key, the sender
// and how the email looks in a real inbox. Touches no database and no users.
//
//   npm run email:test
//
// Addresses come from the git-ignored .env.reminders.local (REMINDER_TO,
// REMINDER_FROM_EMAIL), or from the environment. The Brevo API key is asked
// for without echoing, unless BREVO_API_KEY is set in either place.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { SITE } from "../src/shared/site.ts";
import { BrevoMailer } from "../server/reminders/brevo.ts";
import { ReminderMessages, type Reminder } from "../server/reminders/email.ts";
import type { SendResult } from "../server/reminders/handler.ts";

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

for (const file of ["../.env.reminders.local", "../.env"]) {
  const path = new URL(file, import.meta.url);
  if (existsSync(path)) process.loadEnvFile(path);
}

const to = process.env.REMINDER_TO;
const from = process.env.REMINDER_FROM_EMAIL;
if (!to || !from) {
  console.error("Usage: npm run email:test. Set REMINDER_TO and REMINDER_FROM_EMAIL in .env.reminders.local.");
  process.exit(2);
}
const apiKey = process.env.BREVO_API_KEY || (await askHidden("Brevo API key (hidden): "));
if (!apiKey) {
  console.error("No API key given; nothing sent.");
  process.exit(2);
}

const reminder: Reminder = { userId: "test", email: to, kind: "comeback", unsubscribeToken: SAMPLE_TOKEN };
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
const email = new ReminderMessages(process.env.SITE_URL || SITE.url).email(reminder);
const result = await new BrevoMailer({ apiKey, fromEmail: from, fetcher }).send({
  ...email,
  subject: `[TEST] ${email.subject}`,
  to,
  kind: reminder.kind,
  oneClickUrl: ReminderMessages.oneClickUrl("https://example.invalid/email-unsubscribe", reminder),
});
const meanings: Record<SendResult, string> = {
  sent: "Brevo accepted it. Check the inbox (and spam) of the address you gave.",
  halt: "Brevo refused the account (401/402/403): check the API key, that Authorised IPs is off, and your credits.",
  rejected: "Brevo rejected this email (4xx): check that the sender is verified in Brevo and the address is valid.",
  retry: "Brevo was unreachable or rate-limited (network, 429 or 5xx). Try again in a minute.",
};
console.log(`${result}: ${meanings[result]}`);
if (failure) console.log(`Brevo said: ${failure}`);
process.exit(result === "sent" ? 0 : 1);
