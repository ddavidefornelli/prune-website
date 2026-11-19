import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import { CORS, REMINDERS } from "../constants.ts";
import {
  ReminderMessages,
  UNSUBSCRIBE_KINDS,
  type Reminder,
  type ReminderEmail,
  type ReminderKind,
  type UnsubscribeKind,
} from "./email.ts";
import type { PushPayload, PushResult, PushTarget } from "./web-push.ts";

/**
 * `retry` when the provider may accept the same email later (network, 429, 5xx).
 * `halt` when the provider refuses the whole account (bad key, blocked IP, no
 * credits): nothing else in this run can be delivered either.
 */
export type SendResult = "sent" | "retry" | "rejected" | "halt";

export interface OutgoingEmail extends ReminderEmail {
  to: string;
  kind: ReminderKind;
  /** RFC 8058 one-click endpoint, sent as the List-Unsubscribe header. */
  oneClickUrl: string;
}

export interface ReminderDependencies {
  /** Shared secret the scheduler sends as a bearer token. */
  secret: string;
  siteUrl: string;
  /** Base URL of the email-unsubscribe function. */
  unsubscribeEndpoint: string;
  /** Marks the returned reminders as sent before any email leaves. */
  claim: () => Promise<Reminder[]>;
  release: (userId: string, kind: ReminderKind) => Promise<void>;
  send: (email: OutgoingEmail) => Promise<SendResult>;
  /**
   * Browser push, best effort and optional (absent while VAPID keys are not
   * configured). Sent after the email is settled, never for a claim that is
   * released, so a retried email does not repeat the notification.
   */
  push?: {
    targets: (
      userIds: string[],
    ) => Promise<(PushTarget & { userId: string })[]>;
    send: (target: PushTarget, payload: PushPayload) => Promise<PushResult>;
    record: (endpoint: string, result: PushResult) => Promise<void>;
  };
  concurrency?: number;
}

type Counts = Record<
  "sent" | "retry" | "rejected" | "released" | "pushed",
  number
>;

const BEARER = /^Bearer ([^\s]+)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/**
 * The scheduled job: claim everyone who is due, then send. A claim is
 * released only when the provider might accept a retry, so a permanently
 * rejected address is not retried every run and nobody is emailed twice. An
 * account-level refusal stops the run and releases everything unsent, so a
 * misconfigured provider never uses up anyone's reminder without delivering it.
 */
export class ReminderJob {
  private readonly deps: ReminderDependencies;
  private readonly messages: ReminderMessages;

  constructor(deps: ReminderDependencies) {
    this.deps = deps;
    this.messages = new ReminderMessages(deps.siteUrl);
  }

  /** Length-independent comparison so the secret cannot be guessed byte by byte. */
  static sameSecret(given: string, expected: string): boolean {
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let difference = a.length ^ b.length;
    for (let index = 0; index < b.length; index += 1)
      difference |= (a[index] ?? 0) ^ b[index]!;
    return difference === 0;
  }

  /** For `Deno.serve`, and safe to pass around. */
  readonly handle = async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return json(HTTP_STATUS.methodNotAllowed, {
        error: "method_not_allowed",
      });
    const bearer = BEARER.exec(request.headers.get("Authorization") ?? "");
    if (
      !this.deps.secret ||
      !bearer ||
      !ReminderJob.sameSecret(bearer[1]!, this.deps.secret)
    )
      return json(HTTP_STATUS.unauthorized, { error: "unauthorized" });
    let reminders: Reminder[];
    try {
      reminders = await this.deps.claim();
    } catch {
      return json(HTTP_STATUS.serverError, { error: "claim_failed" });
    }
    const counts: Counts = {
      sent: 0,
      retry: 0,
      rejected: 0,
      released: 0,
      pushed: 0,
    };
    const devices = await this.pushTargets(reminders);
    const queue = [...reminders];
    let halted = false;
    const release = async (reminder: Reminder) => {
      counts.released += 1;
      await this.deps.release(reminder.userId, reminder.kind).catch(() => {});
    };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await this.sendEmail(next);
        if (result === "halt") {
          halted = true;
          // Emptying the queue also stops the other workers after their current send.
          await Promise.all([next, ...queue.splice(0)].map(release));
          return;
        }
        counts[result] += 1;
        if (result === "retry") await release(next);
        else counts.pushed += await this.notify(next, devices);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, this.deps.concurrency ?? REMINDERS.concurrency) },
        worker,
      ),
    );
    // Counts only: never addresses or task text in a response or log.
    return halted
      ? json(HTTP_STATUS.badGateway, { error: "provider_refused", ...counts })
      : json(HTTP_STATUS.ok, counts);
  };

  private async sendEmail(reminder: Reminder): Promise<SendResult> {
    try {
      return await this.deps.send({
        ...this.messages.email(reminder),
        to: reminder.email,
        kind: reminder.kind,
        oneClickUrl: ReminderMessages.oneClickUrl(
          this.deps.unsubscribeEndpoint,
          reminder,
        ),
      });
    } catch {
      return "retry";
    }
  }

  /** Push endpoints for this run, by account. Without them, email still goes out. */
  private async pushTargets(
    reminders: Reminder[],
  ): Promise<Map<string, PushTarget[]>> {
    const devices = new Map<string, PushTarget[]>();
    if (!this.deps.push || !reminders.length) return devices;
    try {
      const targets = await this.deps.push.targets(
        reminders.map((reminder) => reminder.userId),
      );
      for (const target of targets) {
        const list = devices.get(target.userId) ?? [];
        list.push(target);
        devices.set(target.userId, list);
      }
    } catch {
      /* Email only this run. */
    }
    return devices;
  }

  /** Sends the reminder to the account's browsers; returns how many took it. */
  private async notify(
    reminder: Reminder,
    devices: Map<string, PushTarget[]>,
  ): Promise<number> {
    const push = this.deps.push;
    const targets = devices.get(reminder.userId);
    if (!push || !targets) return 0;
    const payload = this.messages.push(reminder);
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

export interface UnsubscribeDependencies {
  unsubscribe: (token: string, kind: UnsubscribeKind) => Promise<void>;
  allowedOrigins: Set<string>;
}

/**
 * Turns one kind of email off. POST only, so a mail scanner that merely opens
 * links cannot unsubscribe anyone. Mail providers call it without an Origin
 * (one-click); the website's confirmation page calls it from an allowed origin.
 * The response never reveals whether a token exists.
 */
export class UnsubscribeEndpoint {
  private readonly deps: UnsubscribeDependencies;

  constructor(deps: UnsubscribeDependencies) {
    this.deps = deps;
  }

  /** For `Deno.serve`, and safe to pass around. */
  readonly handle = async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    if (origin && this.deps.allowedOrigins.has(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    const empty = (status: number) => new Response(null, { status, headers });
    if (origin && !this.deps.allowedOrigins.has(origin))
      return empty(HTTP_STATUS.forbidden);
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", CORS.methods);
      return empty(HTTP_STATUS.noContent);
    }
    if (request.method !== "POST") {
      headers.set("Allow", CORS.methods);
      return empty(HTTP_STATUS.methodNotAllowed);
    }
    const params = new URL(request.url).searchParams;
    const token = params.get("token") ?? "";
    const kind = params.get("kind");
    if (!UUID.test(token) || !kind || !UNSUBSCRIBE_KINDS.includes(kind))
      return empty(HTTP_STATUS.badRequest);
    try {
      await this.deps.unsubscribe(token, kind as UnsubscribeKind);
    } catch {
      return empty(HTTP_STATUS.serverError);
    }
    return empty(HTTP_STATUS.noContent);
  };
}
