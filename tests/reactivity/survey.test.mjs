import assert from "node:assert/strict";
import { test } from "node:test";
import { createSurvey } from "../../src/survey/create-survey.ts";
import { SURVEY_KEY } from "../../src/survey/model.ts";
import { environment, settle } from "../helpers/reactivity.mjs";

const wednesday = new Date(2026, 10, 4, 9);
function survey(t, options) {
  const env = environment(t);
  const reports = [];
  const { state } = env.mount(() =>
    createSurvey({
      fresh: true,
      storage: env.storage,
      report: (usage) => {
        if (Object.keys(usage).length) reports.push(usage);
      },
      now: () => wednesday,
      ...options,
    }),
  );
  return { env, survey: state, reports };
}
const saved = (env) => JSON.parse(env.storage.getItem(SURVEY_KEY));

test("with the flag off nothing renders, is stored or is counted, even on sign-in", async (t) => {
  const { env, survey: flow, reports } = survey(t, { flag: "off" });
  await settle();
  assert.equal(flow.visible(), false);
  flow.signedIn(true, false);
  flow.finishAsGuest();
  assert.equal(env.storage.getItem(SURVEY_KEY), null);
  assert.deepEqual(reports, []);
});

test("answers advance one step per submit, and a stale or repeated submit is ignored", async (t) => {
  const { env, survey: flow, reports } = survey(t, { flag: "on" });
  await settle();
  assert.equal(flow.visible(), true);
  flow.start();
  flow.answer("name", { name: "Ada" });
  flow.answer("name", { name: "Ada" });
  assert.equal(flow.step(), "goal");
  flow.answer("goal", { goal: "ship" });
  flow.answer("goal", { goal: "study" });
  assert.equal(flow.step(), "role");
  assert.equal(flow.answers().goal, "ship");
  flow.back();
  assert.deepEqual([flow.step(), flow.direction()], ["goal", "back"]);
  assert.equal(saved(env).step, "goal");
  assert.deepEqual(reports, [
    { funnel_survey_shown: 1 },
    { funnel_survey_started: 1 },
  ]);
});

test("finishing the questions dates the outcome, and keeping the plan waits for a planner", async (t) => {
  const { env, survey: flow, reports } = survey(t, { flag: "on" });
  await settle();
  flow.start();
  for (const [step, patch] of [
    ["name", {}],
    ["goal", { goal: "ship" }],
    ["role", { role: "engineer" }],
    ["window", { focusWindow: "morning" }],
    ["length", { focusMinutes: 60 }],
    ["fact", {}],
    ["derailer", { derailer: "phone" }],
    ["target", { deepWorkHours: 2 }],
  ])
    flow.answer(step, patch);
  flow.answer("outcome", { weekGoal: "Launch" });
  assert.deepEqual(
    [saved(env).step, saved(env).weekStart],
    ["building", "2026-11-02"],
  );
  flow.showPlan();
  flow.keepPlan();
  assert.deepEqual([saved(env).step, saved(env).plan], ["save", "pending"]);
  assert.deepEqual(flow.importPayload(), {
    goal: "ship",
    role: "engineer",
    focusWindow: "morning",
    focusMinutes: 60,
    derailer: "phone",
    deepWorkHours: 2,
    weekGoal: "Launch",
    weekStart: "2026-11-02",
  });
  assert.deepEqual(reports.slice(-2), [
    { funnel_survey_started: 1 },
    { funnel_survey_finished: 1 },
  ]);
  flow.signedIn(true, true);
  assert.deepEqual(
    {
      status: saved(env).status,
      synced: saved(env).synced,
      plan: saved(env).plan,
    },
    { status: "done", synced: true, plan: "pending" },
  );
  assert.equal(flow.visible(), false);
  assert.equal(flow.importPayload(), undefined, "answers are sent once");
  assert.deepEqual(reports.at(-1), { funnel_survey_signed_up: 1 });
});

test("split keeps a browser's assignment and counts the control group's first visit", async (t) => {
  const {
    env,
    survey: flow,
    reports,
  } = survey(t, { flag: "split", random: () => 0.9 });
  await settle();
  assert.equal(flow.visible(), false);
  assert.equal(saved(env).variant, "control");
  assert.deepEqual(reports, [{ funnel_control_shown: 1 }]);
  flow.signedIn(true, false);
  assert.deepEqual(reports, [
    { funnel_control_shown: 1 },
    { funnel_control_signed_up: 1 },
  ]);
  const again = createSurvey({
    flag: "split",
    fresh: false,
    storage: env.storage,
    random: () => 0.1,
    report: () => {},
  });
  assert.equal(again.state().variant, "control");
});
