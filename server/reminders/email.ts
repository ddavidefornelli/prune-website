export type ReminderKind = "daily" | "comeback";

export interface Reminder {
  userId: string;
  email: string;
  kind: ReminderKind;
  /** Today's unfinished task outcomes; empty for a come-back email. */
  tasks: string[];
  unsubscribeToken: string;
}

export interface ReminderEmail {
  subject: string;
  html: string;
  text: string;
}

const MAX_TASK_CHARS = 200;

/** Task text is user input: never let it become markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const clip = (value: string) =>
  value.length > MAX_TASK_CHARS
    ? `${value.slice(0, MAX_TASK_CHARS - 1)}…`
    : value;

/** The page that asks for confirmation before turning one kind of email off. */
export function unsubscribePageUrl(
  siteUrl: string,
  reminder: Reminder,
): string {
  const url = new URL("/", siteUrl);
  url.searchParams.set("unsubscribe", reminder.unsubscribeToken);
  url.searchParams.set("kind", reminder.kind);
  return url.toString();
}

// Tables and inline styles only: the lowest common denominator that renders the
// same in Gmail, Outlook and Apple Mail. The button is a link in a red table
// cell, because email clients do not run scripts or honour most CSS.
function layout(parts: {
  preheader: string;
  heading: string;
  body: string;
  button: string;
  siteUrl: string;
  unsubscribeUrl: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>prune</title>
</head>
<body style="margin:0;padding:0;background:#000000;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background:#000000;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;font-family:Arial,Helvetica,sans-serif;color:#efeee7;">
<tr><td style="font-size:18px;font-weight:bold;letter-spacing:2px;color:#efeee7;padding-bottom:28px;">prune</td></tr>
<tr><td style="font-size:26px;line-height:32px;font-weight:bold;color:#efeee7;padding-bottom:20px;">${escapeHtml(parts.heading)}</td></tr>
<tr><td style="padding-bottom:28px;">${parts.body}</td></tr>
<tr><td style="padding-bottom:36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" bgcolor="#e5202b" style="background:#e5202b;border-radius:0;">
<a href="${escapeHtml(parts.siteUrl)}" style="display:block;padding:22px 16px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:28px;font-weight:bold;letter-spacing:2px;color:#ffffff;text-decoration:none;">${escapeHtml(parts.button)}</a>
</td></tr>
</table>
</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#b6afa2;border-top:1px solid #393630;padding-top:16px;">
${escapeHtml(parts.footer)}
<a href="${escapeHtml(parts.unsubscribeUrl)}" style="color:#b6afa2;text-decoration:underline;">Stop these emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildReminderEmail(
  reminder: Reminder,
  siteUrl: string,
): ReminderEmail {
  const unsubscribeUrl = unsubscribePageUrl(siteUrl, reminder);
  if (reminder.kind === "comeback") {
    const line =
      "Your plan is empty. Pick up to three tasks for today and start the first one. It takes a minute.";
    return {
      subject: "Hop back in",
      html: layout({
        preheader: "Three tasks. One day. Hop back in.",
        heading: "Hop back in.",
        body: `<p style="margin:0;font-size:16px;line-height:24px;color:#efeee7;">${escapeHtml(line)}</p>`,
        button: "START NOW",
        siteUrl,
        unsubscribeUrl,
        footer:
          "You get this at most once a week while you are away from prune. ",
      }),
      text: `Hop back in.\n\n${line}\n\nSTART NOW: ${siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
    };
  }
  const tasks = reminder.tasks.map(clip);
  const count = tasks.length;
  const heading =
    count === 1
      ? "1 task is waiting today."
      : `${count} tasks are waiting today.`;
  const rows = tasks
    .map(
      (task) =>
        `<tr><td style="padding:14px 16px;font-size:16px;line-height:22px;color:#efeee7;background:#1e1e1e;border-bottom:2px solid #000000;">${escapeHtml(task)}</td></tr>`,
    )
    .join("\n");
  return {
    subject:
      count === 1 ? "1 task waiting today" : `${count} tasks waiting today`,
    html: layout({
      preheader: tasks.join(" · "),
      heading,
      body: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n${rows}\n</table>`,
      button: "START NOW",
      siteUrl,
      unsubscribeUrl,
      footer:
        "You get this on days when tasks you planned are still unfinished. ",
    }),
    text: `${heading}\n\n${tasks.map((task) => `- ${task}`).join("\n")}\n\nSTART NOW: ${siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
  };
}
