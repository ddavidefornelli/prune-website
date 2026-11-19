import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiChat } from "../server/openai.ts";
import { TaskSuggestionEndpoint } from "../server/task-suggestions/handler.ts";
import {
  SuggestionPlan,
  SuggestionProvider,
} from "../server/task-suggestions/provider.ts";

const createHandler = (deps) => new TaskSuggestionEndpoint(deps).handle;
const providerBody = (input) => new SuggestionPlan(input).requestBody();
const validateSuggestions = (value, input) => new SuggestionPlan(input).validate(value);
const generateSuggestions = (input, key, fetcher, observability) =>
  new SuggestionProvider(new OpenAiChat(key, fetcher, observability)).generate(input);

const task = (outcome, status = "planned", estimatedMinutes = 30) => ({
  outcome,
  status,
  estimatedMinutes,
  actualSeconds: 0,
});
const input = (overrides = {}) => ({
  day: "2026-10-30",
  sourceDay: "2026-10-29",
  sourceTasks: [task("Draft the proposal"), task("Ship invoices", "completed")],
  plannedTasks: [],
  ...overrides,
});

function handler(overrides = {}) {
  const calls = { reserve: 0, generate: 0 };
  const deps = {
    authenticate: async (token) => {
      if (token !== "good") throw new Error("bad token");
      return "user-1";
    },
    loadInput: async () => input(),
    reserve: async () => (calls.reserve++, true),
    generate: async () => (calls.generate++, [
      { outcome: "Draft the proposal", estimatedMinutes: 30, basis: "carry_over" },
    ]),
    allowedOrigins: new Set(["https://www.prune.win"]),
    ...overrides,
  };
  return { handle: createHandler(deps), calls };
}
const post = (body = { timezone: "UTC" }, headers = {}) =>
  new Request("https://fn.test/task-suggestions", {
    method: "POST",
    headers: {
      Authorization: "Bearer good",
      "Content-Type": "application/json",
      Origin: "https://www.prune.win",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("suggestions are generated from server-loaded yesterday tasks", async () => {
  const { handle, calls } = handler();
  const response = await handle(post());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.prune.win");
  assert.deepEqual(await response.json(), {
    day: "2026-10-30",
    suggestions: [{ outcome: "Draft the proposal", estimatedMinutes: 30, basis: "carry_over" }],
  });
  assert.deepEqual(calls, { reserve: 1, generate: 1 });
});

test("the target day is passed to the loader and defaults to today", async () => {
  const targets = [];
  const { handle } = handler({
    loadInput: async (_user, _timezone, target) => {
      targets.push(target);
      return input({ day: "2026-10-31", sourceDay: "2026-10-30" });
    },
  });
  assert.equal((await (await handle(post({ timezone: "UTC", target: "tomorrow" }))).json()).day, "2026-10-31");
  await handle(post({ timezone: "UTC" }));
  assert.deepEqual(targets, ["tomorrow", "today"]);
});

test("an empty yesterday or a full today never calls or charges the provider", async () => {
  for (const loaded of [
    input({ sourceTasks: [] }),
    input({ plannedTasks: [task("a"), task("b"), task("c"), task("d"), task("e")] }),
  ]) {
    const { handle, calls } = handler({ loadInput: async () => loaded });
    const response = await handle(post());
    assert.deepEqual((await response.json()).suggestions, []);
    assert.deepEqual(calls, { reserve: 0, generate: 0 });
  }
});

test("caller-supplied tasks, missing sessions, disabled AI and spent allowances are rejected", async () => {
  const { handle, calls } = handler();
  assert.equal((await handle(post({ timezone: "UTC", tasks: [] }))).status, 400);
  assert.equal((await handle(post({ timezone: "UTC", target: "next week" }))).status, 400);
  assert.equal((await handle(post(undefined, { Authorization: "" }))).status, 401);
  assert.equal((await handle(post(undefined, { Origin: "https://evil.test" }))).status, 403);
  assert.equal(calls.generate, 0);

  const disabled = handler({ loadInput: async () => ({ disabled: true }) });
  assert.equal((await disabled.handle(post())).status, 403);
  assert.equal(disabled.calls.generate, 0);

  const spent = handler({ reserve: async () => false });
  const response = await spent.handle(post());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.equal(spent.calls.generate, 0);
});

test("unexpected failures never leak internal details", async () => {
  const { handle } = handler({
    generate: async () => {
      throw new Error("sk-secret provider body");
    },
  });
  const response = await handle(post());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("sk-secret"));
});

test("model output is clamped, deduplicated and limited to open slots", () => {
  const result = validateSuggestions(
    {
      suggestions: [
        { outcome: "  Already   planned ", estimatedMinutes: 20, basis: "carry_over" },
        { outcome: "Finish the draft", estimatedMinutes: 2, basis: "carry_over" },
        { outcome: "finish the  draft", estimatedMinutes: 30, basis: "follow_up" },
        { outcome: "Send invoices", estimatedMinutes: 93, basis: "follow_up" },
        { outcome: "Ignored", estimatedMinutes: 30, basis: "invented" },
        { outcome: "Over the limit", estimatedMinutes: 30, basis: "follow_up" },
      ],
    },
    input({ plannedTasks: [task("Already planned"), task("Two"), task("Three")] }),
  );
  assert.deepEqual(result, [
    { outcome: "Finish the draft", estimatedMinutes: 5, basis: "carry_over" },
    { outcome: "Send invoices", estimatedMinutes: 60, basis: "follow_up" },
  ]);
  assert.throws(() => validateSuggestions({}, input()));
});

test("provider requests send only titles, statuses and timings, without storing", async () => {
  const body = providerBody(input());
  assert.equal(body.store, false);
  const payload = JSON.parse(body.messages[1].content);
  assert.equal(payload.maxSuggestions, 5);
  assert.deepEqual(Object.keys(payload.previousDay[0]).sort(), [
    "actualSeconds",
    "estimatedMinutes",
    "outcome",
    "status",
  ]);

  const ok = await generateSuggestions(input(), "key", async () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              suggestions: [{ outcome: "Draft the proposal", estimatedMinutes: 25, basis: "carry_over" }],
            }),
          },
        },
      ],
    }),
  );
  assert.equal(ok[0].estimatedMinutes, 25);
  await assert.rejects(
    generateSuggestions(input(), "key", async () => new Response("secret upstream", { status: 500 })),
    (error) => error.code === "ai_unavailable" && !error.message.includes("secret"),
  );
});
