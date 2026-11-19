import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import { BREVO, REMINDERS } from "../constants.ts";
import type { OutgoingEmail, SendResult } from "./handler.ts";

export interface BrevoConfig {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
  fetcher?: typeof fetch;
}

/**
 * The account itself is refused: a wrong key, an IP that Brevo's Authorised
 * IPs setting blocks, or no credits left. No email in this run can succeed.
 */
const ACCOUNT_REFUSED: readonly number[] = [
  HTTP_STATUS.unauthorized,
  HTTP_STATUS.paymentRequired,
  HTTP_STATUS.forbidden,
];

/** Sends transactional email through Brevo's HTTP API. */
export class BrevoMailer {
  private readonly config: BrevoConfig;

  constructor(config: BrevoConfig) {
    this.config = config;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    let response: Response;
    try {
      response = await (this.config.fetcher ?? fetch)(BREVO.sendUrl, {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: {
            name: this.config.fromName ?? REMINDERS.sender,
            email: this.config.fromEmail,
          },
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
        signal: AbortSignal.timeout(BREVO.timeoutMs),
      });
    } catch {
      return "retry";
    }
    await response.body?.cancel().catch(() => {});
    if (response.ok) return "sent";
    if (ACCOUNT_REFUSED.includes(response.status)) return "halt";
    // Rate limits and provider outages may clear; a bad address will not clear
    // by itself within the hour, so do not hammer the API with it.
    return response.status === HTTP_STATUS.tooManyRequests ||
      response.status >= HTTP_STATUS.serverError
      ? "retry"
      : "rejected";
  }
}
