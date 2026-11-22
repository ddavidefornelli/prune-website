import assert from "node:assert/strict";
import { test } from "node:test";
import { HelperEndpoint } from "../server/helper/endpoint.ts";
import { HelperModelError } from "../server/helper/model.ts";

const ORIGIN = "https://www.prune.win";
const TASK = "00000000-0000-4000-8000-000000000001";
const locale = { timeZone: "Europe/Rome", language: "it-IT" };
const users = { "token-guest": { id: "guest", guest: true }, "token-member": { id: "member", guest: false } };

function fixture({ brain = {}, claims = {}, now = () => 1_000_000 } = {}) {
  const runs = new Map();
  const jobs = [];
  const asked = [];
  // Answers wait until the test lets them finish, as a real one takes a while.
  let release;
  let hold = new Promise((resolve) => (release = resolve));
  const endpoint = new HelperEndpoint({
    allowedOrigins: new Set([ORIGIN]),
    now: () => now(),
    background: (work) => jobs.push(work),
    async authenticate(token) {
      return users[token] ?? null;
    },
    brain: {
      async classify(tasks) {
        return new Map(tasks.map((task) => [task.id, /milk/.test(task.title) ? null : "draft"]));
      },
      async choices() {
        return [{ question: "Tone?", options: ["Warm", "Formal"] }];
      },
      async answer(brief, first, turns) {
        asked.push({ brief, first, turns });
        await hold;
        return { answer: first ? `${first} (shorter)` : `Draft for ${brief.title}`, sources: [] };
      },
      ...brain,
    },
    store: {
      async claim(user, kind) {
        return claims[`${user.id}:${kind}`] ?? "ok";
      },
      async runs(userId, ids) {
        return ids.map((id) => runs.get(`${userId}:${id}`)).filter(Boolean).map((run) => structuredClone(run));
      },
      async save(userId, run) {
        runs.set(`${userId}:${run.taskId}`, structuredClone(run));
      },
      async remove(userId, id) {
        runs.delete(`${userId}:${id}`);
      },
      async erase(userId) {
        for (const key of runs.keys()) if (key.startsWith(`${userId}:`)) runs.delete(key);
      },
    },
  });
  const call = async (body, token = "token-member", init = {}) => {
    const response = await endpoint.handle(
      new Request("https://project.supabase.co/functions/v1/task-helper", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...init,
      }),
    );
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  const settle = async () => {
    release();
    await Promise.all(jobs.splice(0));
    hold = new Promise((resolve) => (release = resolve));
  };
  return { endpoint, call, settle, runs, asked };
}

const start = (picks = []) => ({ action: "start", taskId: TASK, title: "Email Marco", kind: "draft", context: ["Buy milk"], picks, locale });

test("a run starts at once, is written in the background, and only its owner sees it", async () => {
  const f = fixture();
  const started = await f.call(start([{ question: "Tone?", answer: "Warm" }]));
  assert.equal(started.status, 200);
  assert.equal(started.body.run.status, "working");
  assert.equal(started.body.run.answer, null);
  assert.equal(started.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  // Asked again while working: refused, never a second run.
  assert.equal((await f.call(start())).body.code, "busy");
  await f.settle();
  assert.deepEqual(f.asked[0].brief, { title: "Email Marco", kind: "draft", context: ["Buy milk"], picks: [{ question: "Tone?", answer: "Warm" }], locale });
  const read = await f.call({ action: "get", taskIds: [TASK] });
  assert.equal(read.body.runs[0].status, "done");
  assert.equal(read.body.runs[0].answer, "Draft for Email Marco");
  assert.equal("picks" in read.body.runs[0], false, "the browser gets only what it shows");
  assert.deepEqual((await f.call({ action: "get", taskIds: [TASK] }, "token-guest")).body.runs, []);
});

test("a refine continues the conversation and keeps its turns", async () => {
  const f = fixture();
  await f.call(start());
  await f.settle();
  const refined = await f.call({ action: "refine", taskId: TASK, message: "  Shorter  ", locale });
  assert.equal(refined.body.run.status, "working");
  await f.settle();
  assert.equal(f.asked[1].first, "Draft for Email Marco");
  assert.deepEqual(f.asked[1].turns, [{ role: "user", text: "Shorter" }]);
  const [run] = (await f.call({ action: "get", taskIds: [TASK] })).body.runs;
  assert.equal(run.answer, "Draft for Email Marco (shorter)");
  assert.deepEqual(run.turns, [
    { role: "user", text: "Shorter" },
    { role: "assistant", text: "Draft for Email Marco (shorter)" },
  ]);
});

test("limits: a guest out of free answers is asked to sign in; a full day is refused", async () => {
  const guest = fixture({ claims: { "guest:start": "sign_in" } });
  const refused = await guest.call(start(), "token-guest");
  assert.deepEqual([refused.status, refused.body.code], [402, "sign_in"]);
  assert.equal(guest.runs.size, 0);
  const full = fixture({ claims: { "member:call": "daily_limit" } });
  const choices = await full.call({ action: "choices", taskId: TASK, title: "Email Marco", context: [], locale });
  assert.deepEqual([choices.status, choices.body.code], [429, "daily_limit"]);
});

test("a refusal or failure is saved as a failed run with a plain reason", async () => {
  const refused = fixture({
    brain: {
      answer: async () => {
        throw new HelperModelError("refused");
      },
    },
  });
  await refused.call(start());
  await refused.settle();
  const [run] = (await refused.call({ action: "get", taskIds: [TASK] })).body.runs;
  assert.equal(run.status, "failed");
  assert.match(run.error, /isn't something the helper can do/);
});

test("a run whose worker died is shown as failed and can be started again", async () => {
  let clock = 1_000_000;
  const f = fixture({ now: () => clock });
  await f.call(start());
  clock += 11 * 60 * 1000;
  const [run] = (await f.call({ action: "get", taskIds: [TASK] })).body.runs;
  assert.equal(run.status, "failed");
  assert.equal((await f.call(start())).status, 200);
});

test("classify sorts a batch; choices ask this-or-that questions", async () => {
  const f = fixture();
  const sorted = await f.call({ action: "classify", tasks: [{ id: TASK, title: "Email Marco" }, { id: TASK.replace(/1$/, "2"), title: "Buy milk" }] });
  assert.deepEqual(sorted.body.kinds, { [TASK]: "draft", [TASK.replace(/1$/, "2")]: null });
  const asked = await f.call({ action: "choices", taskId: TASK, title: "Email Marco", context: [], locale });
  assert.deepEqual(asked.body.choices, [{ question: "Tone?", options: ["Warm", "Formal"] }]);
});

test("discard and erase remove runs", async () => {
  const f = fixture();
  await f.call(start());
  await f.settle();
  await f.call({ action: "discard", taskId: TASK });
  assert.equal(f.runs.size, 0);
  await f.call(start());
  await f.settle();
  await f.call({ action: "erase" });
  assert.equal(f.runs.size, 0);
});

test("without a valid token, or with a malformed request, nothing happens", async () => {
  const f = fixture();
  assert.equal((await f.call(start(), "nobody")).status, 401);
  for (const body of [null, [], { action: "start" }, { ...start(), taskId: "not-a-uuid" }, { ...start(), kind: "anything" }, { ...start(), picks: [{}, {}, {}, {}] }, { action: "classify", tasks: Array(21).fill({ id: TASK, title: "x" }) }, { action: "everything" }])
    assert.equal((await f.call(body)).status, 400, JSON.stringify(body));
  assert.equal(f.runs.size, 0);
  const preflight = await f.endpoint.handle(new Request("https://x.test/", { method: "OPTIONS", headers: { Origin: "https://evil.test" } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);
});
