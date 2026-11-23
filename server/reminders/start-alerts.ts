// Alerts when a planned task starts: 5 minutes before, a notification on
// every browser that allowed them and an email when the account has an
// address (see planner_claim_start_alerts). Each alert is claimed once, before
// anything is sent: a late alert is useless, so nothing is retried.
import { REMINDERS, START_ALERTS } from "../constants.ts";
import { escapeHtml, ReminderMessages, type ReminderEmail } from "./email.ts";
import type { OutgoingEmail, SendResult } from "./handler.ts";
import type { PushPayload, PushResult, PushTarget } from "./web-push.ts";

/** One person to alert about one task. Times are epoch milliseconds. */
export interface StartAlert {
  userId: string;
  taskId: string;
  title: string;
  notes: string;
  startAt: number;
  minutes: number;
  /** A group space's name; null for Personal. */
  spaceName: string | null;
  /** The person's IANA time zone, for the time in the email and notification. */
  timezone: string;
  /** Null when there is no address or these emails are off. */
  email: string | null;
  unsubscribeToken: string | null;
}

const LINK = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

/** What an alert says, by notification and by email. */
export class StartAlertMessages {
  private readonly messages: ReminderMessages;
  private readonly siteUrl: string;

  constructor(siteUrl: string) {
    this.siteUrl = siteUrl;
    this.messages = new ReminderMessages(siteUrl);
  }

  /** "In 5 min", "In 1 min", "Now". */
  static soon(startAt: number, now: number): string {
    const minutes = Math.round((startAt - now) / 60_000);
    return minutes <= 0 ? "Now" : `In ${minutes} min`;
  }

  /** "2:00 – 2:30 PM" in the person's zone (UTC when the zone is unknown). */
  static hours(
    alert: Pick<StartAlert, "startAt" | "minutes" | "timezone">,
  ): string {
    const options: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
    };
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en", {
        ...options,
        timeZone: alert.timezone,
      });
    } catch {
      format = new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
    }
    // Plain spaces: Intl's thin and narrow ones show oddly in some mail apps.
    return format
      .formatRange(alert.startAt, alert.startAt + alert.minutes * 60_000)
      .replace(/[\u2009\u202f]/g, " ");
  }

  /** The line under the title: when, and the group it belongs to. */
  static when(alert: StartAlert, now: number): string {
    return [
      StartAlertMessages.soon(alert.startAt, now),
      StartAlertMessages.hours(alert),
      alert.spaceName,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  push(alert: StartAlert, now: number): PushPayload {
    return {
      title: alert.title,
      body: StartAlertMessages.when(alert, now),
      url: this.siteUrl,
      // One per task: a repeat replaces the earlier one.
      tag: `${START_ALERTS.pushTag}-${alert.taskId}`,
    };
  }

  email(
    alert: StartAlert & { unsubscribeToken: string },
    now: number,
  ): ReminderEmail {
    const when = StartAlertMessages.when(alert, now);
    const unsubscribeUrl = this.messages.unsubscribePageUrl({
      unsubscribeToken: alert.unsubscribeToken,
      kind: "starts",
    });
    const notes = alert.notes
      ? `<br><br><span style="color:#3b3b3b;">${StartAlertMessages.notesHtml(alert.notes)}</span>`
      : "";
    return {
      subject: `${StartAlertMessages.soon(alert.startAt, now)}: ${alert.title}`,
      html: this.messages.page({
        title: alert.title,
        preheader: when,
        body: `${escapeHtml(when)}${notes}`,
        button: START_ALERTS.button,
        footer: START_ALERTS.footer,
        unsubscribeUrl,
      }),
      text: `${alert.title}\n${when}\n${alert.notes ? `\n${alert.notes}\n` : ""}\n${START_ALERTS.button}: ${this.siteUrl}\n\nStop these emails: ${unsubscribeUrl}\n`,
    };
  }

  /** The description as HTML: escaped, its lines kept, its web addresses linked. */
  static notesHtml(notes: string): string {
    let html = "";
    let last = 0;
    for (const match of notes.matchAll(LINK)) {
      const href = match[0].replace(TRAILING, "");
      html += escapeHtml(notes.slice(last, match.index));
      html += `<a href="${escapeHtml(href)}" style="color:inherit;">${escapeHtml(href)}</a>`;
      last = match.index! + href.length;
    }
    html += escapeHtml(notes.slice(last));
    return html.replace(/\n/g, "<br>");
  }
}

export interface StartAlertDependencies {
  siteUrl: string;
  unsubscribeEndpoint: string;
  /** Records the alerts due now and returns them. */
  claim: () => Promise<StartAlert[]>;
  push?: {
    targets: (
      userIds: string[],
    ) => Promise<(PushTarget & { userId: string })[]>;
    send: (target: PushTarget, payload: PushPayload) => Promise<PushResult>;
    record: (endpoint: string, result: PushResult) => Promise<void>;
  };
  /** Absent while email is not configured: notifications still go. */
  send?: (email: OutgoingEmail) => Promise<SendResult>;
  now?: () => number;
  concurrency?: number;
}

export interface StartAlertCounts {
  alerts: number;
  pushed: number;
  emailed: number;
}

/** Sends every alert due now; never throws. */
export class StartAlertJob {
  private readonly deps: StartAlertDependencies;
  private readonly messages: StartAlertMessages;

  constructor(deps: StartAlertDependencies) {
    this.deps = deps;
    this.messages = new StartAlertMessages(deps.siteUrl);
  }

  async run(): Promise<StartAlertCounts> {
    const counts: StartAlertCounts = { alerts: 0, pushed: 0, emailed: 0 };
    let alerts: StartAlert[];
    try {
      alerts = await this.deps.claim();
    } catch {
      return counts;
    }
    counts.alerts = alerts.length;
    if (!alerts.length) return counts;
    const now = this.deps.now?.() ?? Date.now();
    const devices = await this.devices(alerts);
    const queue = [...alerts];
    // The provider refused the whole account: no more emails this run.
    let mailHalted = false;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        // Awaited first: `+= await` would add to a count read before the wait.
        const pushed = await this.notify(
          next,
          devices.get(next.userId) ?? [],
          now,
        );
        counts.pushed += pushed;
        if (
          !next.email ||
          !next.unsubscribeToken ||
          !this.deps.send ||
          mailHalted
        )
          continue;
        const result = await this.deps
          .send({
            ...this.messages.email(
              { ...next, unsubscribeToken: next.unsubscribeToken },
              now,
            ),
            to: next.email,
            kind: "starts",
            oneClickUrl: ReminderMessages.oneClickUrl(
              this.deps.unsubscribeEndpoint,
              {
                userId: next.userId,
                email: next.email,
                kind: "starts",
                unsubscribeToken: next.unsubscribeToken,
              },
            ),
          })
          .catch((): SendResult => "retry");
        if (result === "sent") counts.emailed += 1;
        if (result === "halt") mailHalted = true;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, this.deps.concurrency ?? REMINDERS.concurrency) },
        worker,
      ),
    );
    return counts;
  }

  private async devices(
    alerts: StartAlert[],
  ): Promise<Map<string, PushTarget[]>> {
    const devices = new Map<string, PushTarget[]>();
    if (!this.deps.push) return devices;
    try {
      const targets = await this.deps.push.targets([
        ...new Set(alerts.map((alert) => alert.userId)),
      ]);
      for (const { userId, ...target } of targets) {
        const list = devices.get(userId) ?? [];
        list.push(target);
        devices.set(userId, list);
      }
    } catch {
      /* Email only this run. */
    }
    return devices;
  }

  private async notify(
    alert: StartAlert,
    targets: PushTarget[],
    now: number,
  ): Promise<number> {
    const push = this.deps.push;
    if (!push || !targets.length) return 0;
    const payload = this.messages.push(alert, now);
    const results = await Promise.all(
      targets.map(async (target) => {
        const result = await push
          .send(target, payload)
          .catch((): PushResult => "failed");
        await push.record(target.endpoint, result).catch(() => {});
        return result;
      }),
    );
    return results.filter((result) => result === "sent").length;
  }
}
