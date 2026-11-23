// The daily come-back notification: at most one a day per browser, at 10:00
// in its time zone, on days it has not opened prune yet (see
// planner_claim_daily_pushes). Each day asks about a different mood.
import { REMINDERS } from "../constants.ts";
import type { PushPayload, PushResult, PushTarget } from "./web-push.ts";

export interface DailyTarget extends PushTarget {
  /** The browser's IANA time zone: which day it is there picks the line. */
  timezone: string;
}

/** One line a day, each tied to a mood, the same for everyone that day. */
const NUDGES: readonly { title: string; body: string }[] = [
  {
    title: "Ready to get some stuff done?",
    body: "Your list is one tap away.",
  },
  { title: "Feeling productive?", body: "Tick one thing off while it lasts." },
  { title: "Feeling scattered?", body: "Put it all on the list and pick one." },
  { title: "Low on energy?", body: "One small task still counts." },
  { title: "Feeling behind?", body: "Start with the quickest task." },
  { title: "Head full?", body: "Empty it into prune." },
  { title: "Got some momentum?", body: "Keep it going with one more task." },
  { title: "Feeling stuck?", body: "Write down the very next step." },
  { title: "In a good mood?", body: "Good day to finish something." },
  { title: "Too much on your plate?", body: "Pick the one that matters most." },
];
const TAG = "prune-daily";
const DAY_MS = 86_400_000;

export class DailyNudges {
  /** The line for `now` in `timezone` (UTC when the zone is unknown). */
  static payload(siteUrl: string, now: Date, timezone: string): PushPayload {
    const nudge = NUDGES[DailyNudges.dayIndex(now, timezone) % NUDGES.length]!;
    return { ...nudge, url: siteUrl, tag: TAG };
  }

  static get all(): readonly { title: string; body: string }[] {
    return NUDGES;
  }

  /** Days since 1970-01-01 in that time zone. */
  private static dayIndex(now: Date, timezone: string): number {
    let local: string;
    try {
      local = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      local = now.toISOString().slice(0, 10);
    }
    return Math.floor(Date.parse(`${local}T00:00:00Z`) / DAY_MS);
  }
}

export interface DailyPushDependencies {
  siteUrl: string;
  /** Marks the browsers due now as notified and returns them. */
  claim: () => Promise<DailyTarget[]>;
  send: (target: PushTarget, payload: PushPayload) => Promise<PushResult>;
  record: (endpoint: string, result: PushResult) => Promise<void>;
  now?: () => Date;
  concurrency?: number;
}

/** Sends the day's notification to every browser due; never throws. */
export class DailyPushJob {
  private readonly deps: DailyPushDependencies;

  constructor(deps: DailyPushDependencies) {
    this.deps = deps;
  }

  /** How many browsers took the notification. */
  async run(): Promise<number> {
    let targets: DailyTarget[];
    try {
      targets = await this.deps.claim();
    } catch {
      return 0;
    }
    const now = this.deps.now?.() ?? new Date();
    const queue = [...targets];
    let sent = 0;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await this.deps
          .send(
            next,
            DailyNudges.payload(this.deps.siteUrl, now, next.timezone),
          )
          .catch((): PushResult => "failed");
        await this.deps.record(next.endpoint, result).catch(() => {});
        if (result === "sent") sent += 1;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, this.deps.concurrency ?? REMINDERS.concurrency) },
        worker,
      ),
    );
    return sent;
  }
}
