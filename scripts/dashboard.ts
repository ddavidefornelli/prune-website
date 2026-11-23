// A local dashboard of the few numbers that say how the list is doing. Every
// number is a share of visitors, per week: new visitors who added a task on
// their first day or came back in their first week, and visitors who used the
// list, finished a task, used "Do it for me", opened Share or are signed in.
//
//   npm run dashboard
//
// Reads PostHog with a personal API key (POSTHOG_PERSONAL_API_KEY in
// .env.reminders.local, or asked for, hidden; scope: query read) and the
// project id (POSTHOG_PROJECT_ID), then serves the page on 127.0.0.1 only. The
// browser gets weekly totals only: no ids, emails or events.
//
// PostHog only sees visitors who accepted optional analytics, so every share is
// of those visitors. A "visitor" is a PostHog person with a page view or a list
// event that week; one person on two browsers counts twice until they sign in.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const PORT = Number(process.env.DASHBOARD_PORT) || 4400;
const DEFAULT_API_HOST = "https://eu.posthog.com";
const DAY_MS = 86_400_000;
const WEEKS = 13;

/** Events that mean the visitor used the list. */
const LIST_EVENTS = [
  "task_created",
  "task_renamed",
  "task_completed",
  "task_deleted",
  "done_cleared",
  "helper_started",
  "helper_refined",
];
const SHARE_EVENTS = ["share_opened", "space_created"];
const VISIT_EVENTS = ["$pageview", ...LIST_EVENTS, ...SHARE_EVENTS];
const quoted = (events: string[]) => events.map((e) => `'${e}'`).join(", ");

// Week starts are Mondays in UTC, like the page.
const EVENTS = `
  SELECT person_id, toTimeZone(timestamp, 'UTC') AS t, event
  FROM events WHERE event IN (${quoted(VISIT_EVENTS)})`;

/** One row per week: visitors, and how many of them did each thing. */
const WEEKLY_QUERY = `
  WITH per AS (
    SELECT e.person_id AS pid, toStartOfWeek(e.t, 1) AS week,
      countIf(e.event IN (${quoted(LIST_EVENTS)})) > 0 AS used,
      countIf(e.event = 'task_completed') > 0 AS finished,
      countIf(e.event = 'helper_started') > 0 AS helper,
      countIf(e.event IN (${quoted(SHARE_EVENTS)})) > 0 AS shared
    FROM (${EVENTS}) e
    WHERE e.t >= now() - INTERVAL ${WEEKS} WEEK
    GROUP BY pid, week
  )
  SELECT toString(per.week) AS week, count() AS visitors,
    countIf(per.used) AS used, countIf(per.finished) AS finished,
    countIf(per.helper) AS helper, countIf(per.shared) AS shared,
    countIf(notEmpty(toString(p.properties.email))) AS signed
  FROM per LEFT JOIN persons p ON p.id = per.pid
  GROUP BY week ORDER BY week`;

/**
 * One row per week of first visits: new visitors, how many added a task on
 * their first day and how many came back on days 1–7. "Ready" counts only
 * visitors old enough to measure (1 and 8 days).
 */
const COHORT_QUERY = `
  WITH firsts AS (
    SELECT person_id, min(t) AS first FROM (${EVENTS}) GROUP BY person_id
  ),
  per AS (
    SELECT f.person_id AS pid, f.first AS first,
      countIf(e.event = 'task_created' AND toDate(e.t) = toDate(f.first)) > 0 AS added,
      countIf(toDate(e.t) > toDate(f.first) AND toDate(e.t) <= toDate(f.first) + 7) > 0 AS returned
    FROM firsts f JOIN (${EVENTS}) e ON e.person_id = f.person_id
    WHERE f.first >= now() - INTERVAL ${WEEKS} WEEK
    GROUP BY pid, first
  )
  SELECT toString(toStartOfWeek(first, 1)) AS week, count() AS new,
    countIf(toDate(first) <= today() - 1) AS ready1,
    countIf(added AND toDate(first) <= today() - 1) AS added,
    countIf(toDate(first) <= today() - 8) AS ready8,
    countIf(returned AND toDate(first) <= today() - 8) AS returned
  FROM per GROUP BY week ORDER BY week`;

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
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

/** PostHog's query API with a personal key. */
class PostHogClient {
  readonly #url: string;
  readonly #key: string;

  constructor(host: string, project: string, key: string) {
    this.#url = `${host.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(project)}/query/`;
    this.#key = key;
  }

  /** The rows as objects keyed by column name. */
  async rows(query: string): Promise<Record<string, unknown>[]> {
    const res = await fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (!res.ok) throw new Error(`PostHog: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      columns: string[];
      results: unknown[][];
    };
    return body.results.map((row) =>
      Object.fromEntries(body.columns.map((c, i) => [c, row[i]])),
    );
  }
}

/** A PostHog date ("2026-11-16") as days since the epoch. */
const dayOf = (value: unknown) =>
  Math.floor(Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / DAY_MS);

class Metrics {
  readonly #posthog: PostHogClient;

  constructor(posthog: PostHogClient) {
    this.#posthog = posthog;
  }

  async load() {
    const [weekly, cohorts] = await Promise.all([
      this.#posthog.rows(WEEKLY_QUERY),
      this.#posthog.rows(COHORT_QUERY),
    ]);
    const numbers = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          k === "week" ? dayOf(v) : Number(v),
        ]),
      );
    return {
      generatedAt: new Date().toISOString(),
      weekly: weekly.map(numbers),
      cohorts: cohorts.map(numbers),
    };
  }
}

for (const file of ["../.env.reminders.local", "../.env"]) {
  const path = new URL(file, import.meta.url);
  if (existsSync(path)) process.loadEnvFile(path);
}

const project =
  process.env.POSTHOG_PROJECT_ID ||
  (await askHidden("PostHog project id (Settings → Project): "));
const key =
  process.env.POSTHOG_PERSONAL_API_KEY ||
  (await askHidden(
    "PostHog personal API key (hidden, Settings → Personal API keys, scope query read): ",
  ));
if (!project || !key) {
  console.error(
    "The PostHog project id and a personal API key are needed to read the metrics.",
  );
  process.exit(1);
}
const metrics = new Metrics(
  new PostHogClient(
    process.env.POSTHOG_API_HOST || DEFAULT_API_HOST,
    project,
    key,
  ),
);
const page = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

createServer(async (req, res) => {
  if (req.url === "/api/data") {
    try {
      const body = JSON.stringify(await metrics.load());
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (error) {
      console.error(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return;
  }
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}/`;
  console.log(`Dashboard on ${link} (Ctrl+C to stop)`);
  if (!process.env.DASHBOARD_NO_OPEN) execFile("open", [link], () => {});
});
