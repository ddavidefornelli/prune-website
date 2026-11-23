import { REMINDERS } from "../constants.ts";
import type { PushPayload } from "./web-push.ts";

/**
 * The emails sent: a weekly nudge after 7 days away, and an alert 5 minutes
 * before a planned task starts (see start-alerts.ts).
 */
export type ReminderKind = "comeback" | "starts";
/**
 * The switches an unsubscribe link can turn off. "daily" and "session" stay
 * for links in emails the day planner sent.
 */
export type UnsubscribeKind = "daily" | "comeback" | "session" | "starts";
export const UNSUBSCRIBE_KINDS: readonly string[] = [
  "daily",
  "comeback",
  "session",
  "starts",
] satisfies UnsubscribeKind[];

export interface Reminder {
  userId: string;
  email: string;
  kind: ReminderKind;
  unsubscribeToken: string;
}

export interface ReminderEmail {
  subject: string;
  html: string;
  text: string;
}

/** The email's palette: email clients ignore stylesheets, so styles are inline. */
const EMAIL_COLORS = {
  page: "#ffffff",
  text: "#0b0b0b",
  muted: "#6b6b6b",
  rule: "#e6e6e6",
  button: "#0b0b0b",
  buttonText: "#ffffff",
} as const;

const COMEBACK = {
  subject: "Your list is waiting",
  line: "Open prune to add a task or tick one off.",
  button: "Open prune",
  footer: "You get this at most once a week while you are away from prune. ",
  pushTag: "prune-comeback",
} as const;

/** What one email says; `body` is already safe HTML. */
export interface EmailPage {
  title: string;
  /** The preview line inbox lists show. */
  preheader: string;
  body: string;
  button: string;
  footer: string;
  unsubscribeUrl: string;
}

/** Text is never markup. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Writes the come-back email and notification for one site. */
export class ReminderMessages {
  private readonly siteUrl: string;

  constructor(siteUrl: string) {
    this.siteUrl = siteUrl;
  }

  /** The RFC 8058 one-click address for `endpoint`, the email-unsubscribe function. */
  static oneClickUrl(endpoint: string, reminder: Reminder): string {
    const url = new URL(endpoint);
    url.searchParams.set("token", reminder.unsubscribeToken);
    url.searchParams.set("kind", reminder.kind);
    return url.toString();
  }

  email(reminder: Reminder): ReminderEmail {
    const unsubscribeUrl = this.unsubscribePageUrl(reminder);
    return {
      subject: COMEBACK.subject,
      html: this.page({
        title: COMEBACK.subject,
        preheader: COMEBACK.line,
        body: escapeHtml(COMEBACK.line),
        button: COMEBACK.button,
        footer: COMEBACK.footer,
        unsubscribeUrl,
      }),
      text: `${COMEBACK.subject}\n\n${COMEBACK.line}\n\n${COMEBACK.button}: ${this.siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
    };
  }

  /** The same reminder as a browser notification. */
  push(): PushPayload {
    return {
      title: COMEBACK.subject,
      body: COMEBACK.line,
      url: this.siteUrl,
      tag: COMEBACK.pushTag,
    };
  }

  /** The page that asks for confirmation before turning the email off. */
  unsubscribePageUrl(
    reminder: Pick<Reminder, "unsubscribeToken" | "kind">,
  ): string {
    const url = new URL("/", this.siteUrl);
    url.searchParams.set("unsubscribe", reminder.unsubscribeToken);
    url.searchParams.set("kind", reminder.kind);
    return url.toString();
  }

  // Tables and inline styles only: the lowest common denominator that renders
  // the same in Gmail, Outlook and Apple Mail. The button is a link in a table
  // cell, because email clients do not run scripts or honour most CSS.
  page(content: EmailPage): string {
    const c = EMAIL_COLORS;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${REMINDERS.sender}</title>
</head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${c.text};">
<tr><td style="font-size:17px;font-weight:600;color:${c.text};padding-bottom:28px;">${REMINDERS.sender}</td></tr>
<tr><td style="font-size:26px;line-height:32px;font-weight:600;color:${c.text};padding-bottom:12px;">${escapeHtml(content.title)}</td></tr>
<tr><td style="font-size:16px;line-height:24px;color:${c.text};padding-bottom:28px;">${content.body}</td></tr>
<tr><td style="padding-bottom:36px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" bgcolor="${c.button}" style="background:${c.button};border-radius:999px;">
<a href="${escapeHtml(this.siteUrl)}" style="display:block;padding:14px 28px;font-size:16px;line-height:20px;font-weight:600;color:${c.buttonText};text-decoration:none;">${escapeHtml(content.button)}</a>
</td></tr>
</table>
</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:${c.muted};border-top:1px solid ${c.rule};padding-top:16px;">
${escapeHtml(content.footer)}
<a href="${escapeHtml(content.unsubscribeUrl)}" style="color:${c.muted};text-decoration:underline;">Stop these emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  }
}
