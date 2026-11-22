import { START_LINK } from "../planner-contract.ts";
import { REMINDERS } from "../constants.ts";
import type { PushPayload } from "./web-push.ts";

/**
 * "daily" is the focus-time reminder. "session" and "activation" only come
 * from the claim function before 20261121000100_focus_time.sql and are sent
 * as focus-time reminders too.
 */
export type ReminderKind = "daily" | "comeback" | "session" | "activation";
/** The switches an unsubscribe link can turn off. "session" stays for old links. */
export type UnsubscribeKind = "daily" | "comeback" | "session";
export const UNSUBSCRIBE_KINDS: readonly string[] = [
  "daily",
  "comeback",
  "session",
] satisfies UnsubscribeKind[];

export interface Reminder {
  userId: string;
  email: string;
  kind: ReminderKind;
  /** Today's unfinished tasks; empty when nothing is planned and for a come-back email. */
  tasks: string[];
  unsubscribeToken: string;
}

export interface ReminderEmail {
  subject: string;
  html: string;
  text: string;
}

/** The email's palette: email clients ignore stylesheets, so styles are inline. */
const EMAIL_COLORS = {
  page: "#000000",
  text: "#efeee7",
  muted: "#b6afa2",
  rule: "#393630",
  row: "#1e1e1e",
  button: "#e5202b",
  buttonText: "#ffffff",
} as const;

const PUSH_TAGS = { comeback: "prune-comeback", focus: "prune-focus" } as const;
const FOCUS_FOOTER =
  "You get this at your focus time. Change it in prune under Profile. ";

interface Layout {
  preheader: string;
  heading: string;
  body: string;
  button: string;
  buttonUrl: string;
  unsubscribeUrl: string;
  footer: string;
}

/** Task text is user input: never let it become markup. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Writes reminder emails and notifications for one site. */
export class ReminderMessages {
  private readonly siteUrl: string;

  constructor(siteUrl: string) {
    this.siteUrl = siteUrl;
  }

  static unsubscribeKind(kind: ReminderKind): UnsubscribeKind {
    return kind === "comeback" || kind === "activation" ? "comeback" : "daily";
  }

  /** The RFC 8058 one-click address for `endpoint`, the email-unsubscribe function. */
  static oneClickUrl(endpoint: string, reminder: Reminder): string {
    const url = new URL(endpoint);
    url.searchParams.set("token", reminder.unsubscribeToken);
    url.searchParams.set(
      "kind",
      ReminderMessages.unsubscribeKind(reminder.kind),
    );
    return url.toString();
  }

  email(reminder: Reminder): ReminderEmail {
    const unsubscribeUrl = this.unsubscribePageUrl(reminder);
    if (reminder.kind === "comeback") {
      const line =
        "Pick what matters today, start the first task and get the day moving. A minute to plan, then real work done.";
      return {
        subject: "Ready to get work done?",
        html: ReminderMessages.layout({
          preheader: "One task, one timer, real progress.",
          heading: "Ready to get work done?",
          body: ReminderMessages.paragraph(line),
          button: "GET TO WORK",
          buttonUrl: this.siteUrl,
          unsubscribeUrl,
          footer:
            "You get this at most once a week while you are away from prune. ",
        }),
        text: `Ready to get work done?\n\n${line}\n\nGET TO WORK: ${this.siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
      };
    }
    const tasks = reminder.tasks.map(ReminderMessages.clip);
    if (!tasks.length) {
      const line =
        "It’s your focus time. Write down the one task that would move your work forward, start the timer and end the day knowing you got it done.";
      return {
        subject: "What will you get done today?",
        html: ReminderMessages.layout({
          preheader: "It’s your focus time. Time to make progress.",
          heading: "What will you get done today?",
          body: ReminderMessages.paragraph(line),
          button: "PLAN AND START",
          buttonUrl: this.siteUrl,
          unsubscribeUrl,
          footer: FOCUS_FOOTER,
        }),
        text: `What will you get done today?\n\n${line}\n\nPLAN AND START: ${this.siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
      };
    }
    const start = this.startUrl();
    const line =
      "Your focus time is here. Start the first task and keep the momentum going.";
    return {
      subject: `Get it done: ${tasks[0]}`,
      html: ReminderMessages.layout({
        preheader: tasks.join(" · "),
        heading: "Time to get it done.",
        body: `${ReminderMessages.paragraph(line)}${ReminderMessages.taskRows(tasks)}`,
        button: "START WORKING",
        buttonUrl: start,
        unsubscribeUrl,
        footer: FOCUS_FOOTER,
      }),
      text: `Time to get it done.\n\n${line}\n\n${tasks.map((task) => `- ${task}`).join("\n")}\n\nSTART WORKING: ${start}\n\nStop these emails: ${unsubscribeUrl}\n`,
    };
  }

  /** The same reminder as a browser notification. Task text travels encrypted. */
  push(reminder: Reminder): PushPayload {
    if (reminder.kind === "comeback")
      return {
        title: "Ready to get work done?",
        body: "Pick what matters today, start the timer and feel the progress.",
        url: this.siteUrl,
        tag: PUSH_TAGS.comeback,
      };
    const tasks = reminder.tasks.map(ReminderMessages.clip);
    return tasks.length
      ? {
          title: "Time to get it done",
          body: tasks.join(" · "),
          url: this.startUrl(),
          tag: PUSH_TAGS.focus,
        }
      : {
          title: "What will you get done today?",
          body: "It’s your focus time. Name one task, start the timer, make progress.",
          url: this.siteUrl,
          tag: PUSH_TAGS.focus,
        };
  }

  /** The page that asks for confirmation before turning one kind of email off. */
  private unsubscribePageUrl(reminder: Reminder): string {
    const url = new URL("/", this.siteUrl);
    url.searchParams.set("unsubscribe", reminder.unsubscribeToken);
    url.searchParams.set(
      "kind",
      ReminderMessages.unsubscribeKind(reminder.kind),
    );
    return url.toString();
  }

  /** Opens the planner and starts the next planned task (see src/planner/deep-link.ts). */
  private startUrl(): string {
    const url = new URL("/", this.siteUrl);
    url.searchParams.set(START_LINK.param, START_LINK.value);
    return url.toString();
  }

  private static clip(value: string): string {
    return value.length > REMINDERS.maxTaskChars
      ? `${value.slice(0, REMINDERS.maxTaskChars - 1)}…`
      : value;
  }

  private static paragraph(text: string): string {
    return `<p style="margin:0 0 12px;font-size:16px;line-height:24px;color:${EMAIL_COLORS.text};">${escapeHtml(text)}</p>`;
  }

  private static taskRows(tasks: string[]): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n${tasks
      .map(
        (task) =>
          `<tr><td style="padding:14px 16px;font-size:16px;line-height:22px;color:${EMAIL_COLORS.text};background:${EMAIL_COLORS.row};border-bottom:2px solid ${EMAIL_COLORS.page};">${escapeHtml(task)}</td></tr>`,
      )
      .join("\n")}\n</table>`;
  }

  // Tables and inline styles only: the lowest common denominator that renders
  // the same in Gmail, Outlook and Apple Mail. The button is a link in a red
  // table cell, because email clients do not run scripts or honour most CSS.
  private static layout(parts: Layout): string {
    const c = EMAIL_COLORS;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>prune</title>
</head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;font-family:Arial,Helvetica,sans-serif;color:${c.text};">
<tr><td style="font-size:18px;font-weight:bold;letter-spacing:2px;color:${c.text};padding-bottom:28px;">prune</td></tr>
<tr><td style="font-size:26px;line-height:32px;font-weight:bold;color:${c.text};padding-bottom:20px;">${escapeHtml(parts.heading)}</td></tr>
<tr><td style="padding-bottom:28px;">${parts.body}</td></tr>
<tr><td style="padding-bottom:36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" bgcolor="${c.button}" style="background:${c.button};border-radius:0;">
<a href="${escapeHtml(parts.buttonUrl)}" style="display:block;padding:22px 16px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:28px;font-weight:bold;letter-spacing:2px;color:${c.buttonText};text-decoration:none;">${escapeHtml(parts.button)}</a>
</td></tr>
</table>
</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:${c.muted};border-top:1px solid ${c.rule};padding-top:16px;">
${escapeHtml(parts.footer)}
<a href="${escapeHtml(parts.unsubscribeUrl)}" style="color:${c.muted};text-decoration:underline;">Stop these emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  }
}
