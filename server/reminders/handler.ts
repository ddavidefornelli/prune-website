import {
  buildReminderEmail,
  type Reminder,
  type ReminderEmail,
  type ReminderKind,
} from "./email.ts";

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

export type ReminderDependencies = {
  /** Shared secret the scheduler sends as a bearer token. */
  secret: string;
  siteUrl: string;
  /** Base URL of the email-unsubscribe function. */
  unsubscribeEndpoint: string;
  /** Marks the returned reminders as sent before any email leaves. */
  claim: () => Promise<Reminder[]>;
  release: (userId: string, kind: ReminderKind) => Promise<void>;
  send: (email: OutgoingEmail) => Promise<SendResult>;
  concurrency?: number;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Length-independent comparison so the secret cannot be guessed byte by byte. */
export function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1)
    difference |= (a[index] ?? 0) ^ b[index]!;
  return difference === 0;
}

export function oneClickUrl(endpoint: string, reminder: Reminder): string {
  const url = new URL(endpoint);
  url.searchParams.set("token", reminder.unsubscribeToken);
  url.searchParams.set("kind", reminder.kind);
  return url.toString();
}

/**
 * Hourly job: claim everyone who is due, then send. A claim is released only
 * when the provider might accept a retry, so a permanently rejected address is
 * not retried every hour and nobody is emailed twice. An account-level refusal
 * stops the run and releases everything unsent, so a misconfigured provider
 * never uses up anyone's reminder without delivering it.
 */
export function createReminderHandler(
  deps: ReminderDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const bearer = /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("Authorization") ?? "",
    );
    if (!deps.secret || !bearer || !sameSecret(bearer[1]!, deps.secret))
      return json(401, { error: "unauthorized" });
    let reminders: Reminder[];
    try {
      reminders = await deps.claim();
    } catch {
      return json(500, { error: "claim_failed" });
    }
    const counts = { sent: 0, retry: 0, rejected: 0, released: 0 };
    const queue = [...reminders];
    let halted = false;
    const release = async (reminder: Reminder) => {
      counts.released += 1;
      await deps.release(reminder.userId, reminder.kind).catch(() => {});
    };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        let result: SendResult;
        try {
          result = await deps.send({
            ...buildReminderEmail(next, deps.siteUrl),
            to: next.email,
            kind: next.kind,
            oneClickUrl: oneClickUrl(deps.unsubscribeEndpoint, next),
          });
        } catch {
          result = "retry";
        }
        if (result === "halt") {
          halted = true;
          // Emptying the queue also stops the other workers after their current send.
          await Promise.all([next, ...queue.splice(0)].map(release));
          return;
        }
        counts[result] += 1;
        if (result === "retry") await release(next);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, worker),
    );
    // Counts only: never addresses or task text in a response or log.
    return halted
      ? json(502, { error: "provider_refused", ...counts })
      : json(200, counts);
  };
}

export type UnsubscribeDependencies = {
  unsubscribe: (token: string, kind: ReminderKind) => Promise<void>;
  allowedOrigins: Set<string>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns one kind of email off. POST only, so a mail scanner that merely opens
 * links cannot unsubscribe anyone. Mail providers call it without an Origin
 * (one-click); the website's confirmation page calls it from an allowed origin.
 * The response never reveals whether a token exists.
 */
export function createUnsubscribeHandler(
  deps: UnsubscribeDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    if (origin && deps.allowedOrigins.has(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    const empty = (status: number) => new Response(null, { status, headers });
    if (origin && !deps.allowedOrigins.has(origin)) return empty(403);
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      return empty(204);
    }
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return empty(405);
    }
    const params = new URL(request.url).searchParams;
    const token = params.get("token") ?? "";
    const kind = params.get("kind");
    if (!UUID.test(token) || (kind !== "daily" && kind !== "comeback"))
      return empty(400);
    try {
      await deps.unsubscribe(token, kind);
    } catch {
      return empty(500);
    }
    return empty(204);
  };
}
