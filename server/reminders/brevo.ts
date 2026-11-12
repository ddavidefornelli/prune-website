import type { OutgoingEmail, SendResult } from "./handler.ts";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 15_000;

export interface BrevoConfig {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
  fetcher?: typeof fetch;
}

/** One transactional email through Brevo's HTTP API. */
export async function sendWithBrevo(
  email: OutgoingEmail,
  config: BrevoConfig,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await (config.fetcher ?? fetch)(BREVO_SEND_URL, {
      method: "POST",
      headers: {
        "api-key": config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: config.fromName ?? "prune", email: config.fromEmail },
        to: [{ email: email.to }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
        headers: {
          "List-Unsubscribe": `<${email.oneClickUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [`reminder-${email.kind}`],
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return "retry";
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return "sent";
  // The account itself is refused: a wrong key, an IP that Brevo's Authorised
  // IPs setting blocks, or no credits left. No email in this run can succeed.
  if ([401, 402, 403].includes(response.status)) return "halt";
  // Rate limits and provider outages may clear; a bad address will not clear
  // by itself within the hour, so do not hammer the API with it.
  return response.status === 429 || response.status >= 500
    ? "retry"
    : "rejected";
}
