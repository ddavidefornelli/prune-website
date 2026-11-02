import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STARTERS, focusBlockMinutes, startersFor } from "../src/planner/starters.ts";
import { DERAILERS, FOCUS_LENGTHS, GOALS, ROLES } from "../src/survey/answers.ts";

test("no answers keep today's three starters", () => {
  const expected = [
    { outcome: "Clear my inbox", minutes: 20 },
    { outcome: "Deep work on my main project", minutes: 60 },
    { outcome: "Plan the week ahead", minutes: 30 },
  ];
  assert.deepEqual(DEFAULT_STARTERS, expected);
  assert.deepEqual(startersFor(), expected);
  assert.deepEqual(startersFor({}), expected);
  // A name or week outcome alone does not change what to start with.
  assert.deepEqual(startersFor({ name: "Ada", weekGoal: "Launch", focusWindow: "morning", deepWorkHours: 2 }), expected);
  // Callers may not mutate the shared defaults.
  startersFor()[0].outcome = "Changed";
  assert.equal(DEFAULT_STARTERS[0].outcome, "Clear my inbox");
});

test("every combination gives three distinct tasks the planner accepts", () => {
  for (const { value: goal } of GOALS)
    for (const role of [undefined, ...ROLES.map((option) => option.value)])
      for (const focusMinutes of [undefined, ...FOCUS_LENGTHS.map((option) => option.value)])
        for (const derailer of [undefined, ...DERAILERS.map((option) => option.value)]) {
          const tasks = startersFor({ goal, role, focusMinutes, derailer });
          const label = JSON.stringify({ goal, role, focusMinutes, derailer });
          assert.equal(tasks.length, 3, label);
          assert.equal(new Set(tasks.map((task) => task.outcome)).size, 3, label);
          for (const task of tasks) {
            assert.ok(task.outcome.length > 0 && task.outcome.length <= 80, label);
            assert.ok(Number.isInteger(task.minutes) && task.minutes >= 5 && task.minutes <= 60 && task.minutes % 5 === 0, label);
            assert.ok(task.minutes <= focusBlockMinutes(focusMinutes), `${label}: no task outlasts one focus block`);
          }
        }
});

test("the main task fills one focus block, capped at the longest estimate", () => {
  assert.equal(focusBlockMinutes(15), 15);
  assert.equal(focusBlockMinutes(60), 60);
  assert.equal(focusBlockMinutes(90), 60);
  assert.equal(focusBlockMinutes(undefined), 30);
  const main = (focusMinutes) => startersFor({ goal: "ship", role: "engineer", focusMinutes })[0];
  assert.deepEqual(main(15), { outcome: "Build the next feature", minutes: 15 });
  assert.deepEqual(main(90), { outcome: "Build the next feature", minutes: 60 });
  // Lighter tasks shrink with a short attention span.
  assert.deepEqual(startersFor({ goal: "study", focusMinutes: 15 }).map((task) => task.minutes), [15, 15, 15]);
});

test("goal and role choose the work; exploring at 60 minutes matches the defaults", () => {
  assert.equal(startersFor({ goal: "ship", role: "founder" })[0].outcome, "Ship one thing users will notice");
  assert.equal(startersFor({ goal: "ship", role: "other" })[0].outcome, "Move my project to its next milestone");
  assert.equal(startersFor({ goal: "study", role: "student" })[0].outcome, "Study for my next exam");
  assert.equal(startersFor({ goal: "business", role: "creative" })[0].outcome, "Finish one client deliverable");
  assert.deepEqual(startersFor({ goal: "exploring", focusMinutes: 60 }), DEFAULT_STARTERS);
  // Procrastination opens with the ten-minute split, then the avoided task.
  assert.deepEqual(startersFor({ goal: "procrastination", focusMinutes: 30 }), [
    { outcome: "Split my biggest task into small steps", minutes: 10 },
    { outcome: "Start the task I've been avoiding", minutes: 30 },
    { outcome: "Clear one quick task I keep postponing", minutes: 15 },
  ]);
});

test("each derailer changes the plan the way the building checklist says", () => {
  const base = { goal: "ship", role: "engineer", focusMinutes: 60 };
  assert.equal(startersFor({ ...base, derailer: "phone" })[0].outcome, "Build the next feature, phone in another room");
  assert.equal(startersFor({ ...base, derailer: "interruptions" })[0].outcome, "Build the next feature, notifications off");
  assert.deepEqual(startersFor({ ...base, derailer: "starting" }), [
    { outcome: "Write down the very first step", minutes: 10 },
    { outcome: "Build the next feature", minutes: 60 },
    { outcome: "Share progress with one person", minutes: 10 },
  ]);
  assert.deepEqual(startersFor({ ...base, derailer: "overload" })[2], { outcome: "Park everything else on one list", minutes: 10 });
  // Procrastination already starts small; it does not get a second first step.
  assert.equal(startersFor({ goal: "procrastination", derailer: "starting" })[0].outcome, "Split my biggest task into small steps");
});
