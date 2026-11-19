// A local dashboard of the rates that decide whether to keep going or pivot,
// all as percentages per week so the trend is what you read: activation,
// next-day / first-week / month-4 return, weekly active, task completion,
// focus time, push, reminder emails kept on and signup growth.
//
//   npm run dashboard
//
// Reads the live project with the service-role key (SUPABASE_SERVICE_ROLE_KEY in
// .env.reminders.local, or asked for, hidden), then serves the page on
// 127.0.0.1 only. The browser gets one anonymous row per account (signup time,
// the days it was active, whether it set a focus time, turned on push or kept
// reminder emails on, and the creation/completion day of each task): no ids,
// no emails, no task text.
// Your own account (REMINDER_TO) is flagged so the page can leave it out.
//
// "Active on a day" means the account left a trace that day: a task created,
// started or completed, a planner history event, its last sign-in, or its last
// visit. Before planner_history existed, a visit that changed nothing on a day
// that was not the last visit leaves no trace, so early days can undercount.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";

const PORT = Number(process.env.DASHBOARD_PORT) || 4400;
const DAY = 86_400_000;

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

for (const file of ["../.env.reminders.local", "../.env"]) {
  const path = new URL(file, import.meta.url);
  if (existsSync(path)) process.loadEnvFile(path);
}

const url = process.env.VITE_SUPABASE_URL;
if (!url) {
  console.error("Set VITE_SUPABASE_URL in .env.");
  process.exit(1);
}
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  (await askHidden(
    "Supabase service-role key (hidden, Project Settings → API): ",
  ));
if (!serviceKey) {
  console.error("The service-role key is needed to read the metrics.");
  process.exit(1);
}
const selfEmail = process.env.REMINDER_TO?.toLowerCase();
const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

async function allRows(
  table: string,
  columns: string,
  optional = false,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .range(from, from + 999);
    if (error) {
      if (optional) return rows;
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...(data as unknown as Row[]));
    if (!data || data.length < 1000) return rows;
  }
}

function dayOf(value: unknown): number | undefined {
  // planner_tasks.created_at / started_at are epoch milliseconds (bigint).
  if (typeof value === "number" && value > 0) return Math.floor(value / DAY);
  if (typeof value === "string" && /^\d{11,}$/.test(value))
    return Math.floor(Number(value) / DAY);
  if (typeof value !== "string" || !value) return undefined;
  // Plain dates (completed_on) are already a calendar day; read them as UTC.
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(time) ? Math.floor(time / DAY) : undefined;
}

export interface DashboardAccount {
  signup: string;
  activeDays: number[];
  activated: boolean;
  focusSet: boolean;
  push: boolean;
  emailsOn: boolean;
  /** [created day, completed day or -1], in days since the epoch (UTC). */
  tasks: [number, number][];
  self: boolean;
}

async function load() {
  const users: {
    id: string;
    created_at: string;
    email?: string;
    last_sign_in_at?: string;
    is_anonymous?: boolean;
  }[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw new Error(`users: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  const [accounts, tasks, reminders, history, pushRows] = await Promise.all([
    allRows("planner_accounts", 'user_id,"isDeleted"'),
    allRows("planner_tasks", "user_id,created_at,started_at,completed_on"),
    allRows(
      "planner_email_reminders",
      "user_id,focus_minute,last_seen_at,daily_enabled",
    ),
    // Optional until 20261122000100_planner_history.sql is applied.
    allRows("planner_history", "user_id,at", true),
    allRows("planner_push_subscriptions", "user_id", true),
  ]);

  const deleted = new Set(
    accounts.filter((a) => a.isDeleted).map((a) => a.user_id),
  );
  const days = new Map<string, Set<number>>();
  const startedDays = new Map<string, Set<number>>();
  const mark = (
    map: Map<string, Set<number>>,
    user: unknown,
    value: unknown,
  ) => {
    const day = dayOf(value);
    if (typeof user !== "string" || day === undefined) return;
    if (!map.has(user)) map.set(user, new Set());
    map.get(user)!.add(day);
  };
  const taskDays = new Map<unknown, [number, number][]>();
  for (const t of tasks) {
    const created = dayOf(t.created_at);
    if (created !== undefined) {
      if (!taskDays.has(t.user_id)) taskDays.set(t.user_id, []);
      taskDays.get(t.user_id)!.push([created, dayOf(t.completed_on) ?? -1]);
    }
    mark(days, t.user_id, t.created_at);
    mark(days, t.user_id, t.started_at);
    mark(days, t.user_id, t.completed_on);
    mark(startedDays, t.user_id, t.started_at);
    mark(startedDays, t.user_id, t.completed_on);
  }
  for (const h of history) mark(days, h.user_id, h.at);
  const focus = new Set<unknown>();
  const emailsOff = new Set<unknown>();
  const push = new Set(pushRows.map((p) => p.user_id));
  for (const r of reminders) {
    mark(days, r.user_id, r.last_seen_at);
    if (r.daily_enabled === false) emailsOff.add(r.user_id);
    if (r.focus_minute !== null && r.focus_minute !== undefined)
      focus.add(r.user_id);
  }

  const result: DashboardAccount[] = [];
  for (const u of users) {
    if (u.is_anonymous || deleted.has(u.id)) continue;
    mark(days, u.id, u.last_sign_in_at);
    const signupDay = dayOf(u.created_at)!;
    const active = [...(days.get(u.id) ?? [])]
      .map((d) => d - signupDay)
      .filter((d) => d >= 0);
    // The signup day itself always counts as active.
    active.push(0);
    result.push({
      signup: u.created_at,
      activeDays: [...new Set(active)].sort((a, b) => a - b),
      activated: startedDays.get(u.id)?.has(signupDay) ?? false,
      focusSet: focus.has(u.id),
      push: push.has(u.id),
      emailsOn: !emailsOff.has(u.id),
      tasks: taskDays.get(u.id) ?? [],
      self: !!selfEmail && u.email?.toLowerCase() === selfEmail,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    historyAvailable: history.length > 0,
    accounts: result.sort((a, b) => a.signup.localeCompare(b.signup)),
  };
}

const page = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

createServer(async (req, res) => {
  if (req.url === "/api/data") {
    try {
      const body = JSON.stringify(await load());
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
