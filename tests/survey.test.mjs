import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answer, assignVariant, back, buildPlan, countEvent, emptySurvey, finishSignedIn, isFreshVisitor,
  keepPlan, nextStep, parseFlag, parseSurvey, previousStep, questionNumber, readSurvey, start, STEPS,
  SURVEY_KEY, surveyImport, surveyVisible, tasksToAdd, updateSurvey, weekStartOf, writeSurvey,
} from "../src/survey/model.ts";

function memory() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
const wednesday = new Date(2026, 10, 4, 9, 30);
const answers = { name: "Ada", goal: "ship", role: "engineer", focusWindow: "morning", focusMinutes: 60, derailer: "phone", deepWorkHours: 2 };

test("the flag defaults to off; split assigns once and keeps the assignment", () => {
  assert.equal(parseFlag(undefined), "off");
  assert.equal(parseFlag("ON"), "off");
  assert.equal(parseFlag("on"), "on");
  assert.equal(parseFlag("split"), "split");
  assert.equal(assignVariant("off", "survey"), null);
  assert.equal(assignVariant("on", "control"), "survey");
  assert.equal(assignVariant("split", null, () => 0.2), "survey");
  assert.equal(assignVariant("split", null, () => 0.7), "control");
  assert.equal(assignVariant("split", "control", () => 0.2), "control");
});

test("steps run in order, number only the questions, and back skips the building screen", () => {
  assert.deepEqual(STEPS, ["intro", "name", "goal", "role", "window", "length", "fact", "derailer", "target", "outcome", "building", "plan", "save"]);
  assert.equal(nextStep("intro"), "name");
  assert.equal(nextStep("outcome"), "building");
  assert.equal(nextStep("save"), "save");
  assert.equal(previousStep("name"), "intro");
  assert.equal(previousStep("intro"), "intro");
  assert.equal(previousStep("plan"), "outcome");
  assert.equal(previousStep("save"), "plan");
  assert.equal(questionNumber("name"), 1);
  assert.equal(questionNumber("fact"), 6);
  assert.equal(questionNumber("outcome"), 9);
  assert.equal(questionNumber("intro"), null);
  assert.equal(questionNumber("plan"), null);
});

test("answers advance the flow, trim text, and date the week outcome to its local Monday", () => {
  let state = start(emptySurvey());
  assert.deepEqual([state.status, state.step], ["active", "name"]);
  state = answer(state, { name: "  Ada \n Lovelace  " }, wednesday);
  assert.deepEqual([state.step, state.answers.name], ["goal", "Ada Lovelace"]);
  state = answer(state, { goal: "ship" }, wednesday);
  state = back(state);
  assert.deepEqual([state.step, state.answers.goal], ["goal", "ship"], "back keeps the earlier answer");
  state = { ...state, step: "outcome" };
  state = answer(state, { weekGoal: "Launch the new homepage" }, wednesday);
  assert.equal(state.step, "building");
  assert.equal(state.weekStart, "2026-11-02");
  state = answer({ ...state, step: "outcome" }, { weekGoal: "   " }, wednesday);
  assert.equal(state.answers.weekGoal, undefined, "an empty outcome is a skip");
  assert.equal(state.weekStart, null);
  assert.equal(weekStartOf(new Date(2026, 10, 8, 23)), "2026-11-02", "Sunday belongs to the week that started Monday");
  assert.equal(weekStartOf(new Date(2026, 10, 9, 0, 1)), "2026-11-09");
  const long = answer({ ...state, step: "name" }, { name: "x".repeat(80) }, wednesday);
  assert.equal(long.answers.name.length, 40);
});

test("stored state survives a reload and rejects anything it does not recognise", () => {
  const storage = memory();
  const saved = { ...start(emptySurvey()), variant: "survey", answers, weekStart: "2026-11-02", counted: ["funnel_survey_shown"] };
  writeSurvey(storage, saved);
  assert.deepEqual(readSurvey(storage), saved);
  assert.ok(storage.values.has(SURVEY_KEY));
  for (const raw of [null, "", "{", "[]", "null", JSON.stringify({ version: 2, status: "done" })])
    assert.deepEqual(parseSurvey(raw), emptySurvey(), raw);
  const tampered = parseSurvey(JSON.stringify({
    version: 1, variant: "admin", status: "hacked", step: "nowhere", plan: "always", synced: "yes",
    weekStart: "next week", counted: ["funnel_survey_shown", "tasks_created", "<script>"],
    answers: { goal: "world domination", focusMinutes: 45, role: "founder", name: 7, weekGoal: "<b>Ship</b>", extra: true },
  }));
  assert.deepEqual(tampered, {
    ...emptySurvey(), counted: ["funnel_survey_shown"], answers: { role: "founder", weekGoal: "<b>Ship</b>" },
  });
});

test("a refused storage write keeps the flow going for this page", () => {
  const storage = memory();
  storage.setItem = () => { throw new DOMException("Storage denied", "QuotaExceededError"); };
  const next = updateSurvey(storage, start);
  assert.equal(next.step, "name");
  assert.equal(readSurvey(storage).step, "name");
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readSurvey(broken), emptySurvey());
  assert.equal(isFreshVisitor(broken), false, "unknown storage is never treated as a first visit");
});

test("only fresh visitors start the questions, finished flows never return, and an earlier skip no longer counts", () => {
  const storage = memory();
  assert.equal(isFreshVisitor(storage), true);
  storage.setItem("prune:privacy:acknowledgement", JSON.stringify({ version: "privacy-old" }));
  assert.equal(isFreshVisitor(storage), false, "any earlier notice acceptance means a returning visitor");
  const fresh = memory();
  fresh.setItem("prune:guest:v1", "{}");
  assert.equal(isFreshVisitor(fresh), false, "existing guest plans go straight to the planner");
  const state = { ...emptySurvey(), variant: "survey" };
  assert.equal(surveyVisible(state, true), true);
  assert.equal(surveyVisible(state, false), false);
  assert.equal(surveyVisible(start(state), false), true, "a started flow resumes");
  assert.equal(surveyVisible({ ...state, variant: "control" }, true), false);
  assert.equal(surveyVisible({ ...state, variant: null }, true), false);
  assert.equal(surveyVisible(finishSignedIn(start(state)), true), false);
  assert.equal(finishSignedIn(state).status, "new", "signing in elsewhere does not finish an unstarted flow");
  const skipped = parseSurvey(JSON.stringify({ ...start(state), status: "skipped" }));
  assert.equal(skipped.status, "new", "a skip stored by an earlier build reads as not started");
  assert.equal(surveyVisible(skipped, true), true, "so a still-fresh browser gets the questions again");
  assert.equal(surveyVisible(skipped, false), false);
});

test("keeping the plan waits for the next planner and is never re-added", () => {
  const state = start({ ...emptySurvey(), answers });
  assert.deepEqual([keepPlan(state).step, keepPlan(state).plan], ["save", "pending"]);
  assert.equal(keepPlan({ ...state, plan: "applied" }).plan, "applied");
});

test("the plan echoes the answers it was computed from", () => {
  const plan = buildPlan(answers);
  assert.deepEqual(plan.tasks, [
    { outcome: "Build the next feature, phone in another room", minutes: 60 },
    { outcome: "List what's left before it ships", minutes: 15 },
    { outcome: "Share progress with one person", minutes: 10 },
  ]);
  assert.equal(plan.focus, "Mornings, 60-minute blocks");
  assert.equal(plan.plannedMinutes, 85);
  assert.deepEqual(plan.checklist, [
    "Sizing tasks to your 60-minute focus",
    "Matching 60-minute blocks to your mornings",
    "Choosing 3 tasks for shipping your project",
    "Keeping your phone out of the main block",
    "Planning 1 h 25 min of your 2-hour target",
  ]);
  const long = buildPlan({ goal: "study", focusWindow: "varies", focusMinutes: 90, deepWorkHours: 1, derailer: "starting", weekGoal: "Pass the exam" });
  assert.equal(long.focus, "Any time, 60-minute blocks");
  assert.deepEqual(long.checklist, [
    "Capping blocks at 60 minutes, prune’s longest estimate",
    "Keeping 60-minute blocks flexible",
    "Choosing 3 tasks for your studies",
    "Opening with a 10-minute first step",
    "Planning 1 h 30 min, your full 1-hour target",
    "Setting this week’s outcome",
  ]);
  assert.equal(long.tasks[0].outcome, "Write down the very first step");
});

test("plan tasks fill only free slots and skip titles already planned", () => {
  const tasks = buildPlan(answers).tasks;
  assert.deepEqual(tasksToAdd(tasks, []), tasks);
  assert.deepEqual(tasksToAdd(tasks, [{ outcome: " share progress with ONE person " }]), tasks.slice(0, 2));
  assert.deepEqual(tasksToAdd(tasks, [{ outcome: "A" }, { outcome: "B" }]), tasks.slice(0, 1));
  assert.deepEqual(tasksToAdd(tasks, [{ outcome: "A" }, { outcome: "B" }, { outcome: "C" }]), []);
});

test("the import carries answers but never the name, and only a current week's outcome", () => {
  const state = { ...start(emptySurvey()), answers: { ...answers, weekGoal: "Launch" }, weekStart: "2026-11-02" };
  assert.deepEqual(surveyImport(state, wednesday), {
    goal: "ship", role: "engineer", focusWindow: "morning", focusMinutes: 60, derailer: "phone", deepWorkHours: 2,
    weekGoal: "Launch", weekStart: "2026-11-02",
  });
  const nextWeek = surveyImport(state, new Date(2026, 10, 10));
  assert.equal(nextWeek.weekGoal, undefined);
  assert.equal(nextWeek.weekStart, undefined);
  assert.equal(JSON.stringify(surveyImport(state, wednesday)).includes("Ada"), false);
  assert.equal(surveyImport({ ...state, synced: true }, wednesday), undefined);
  assert.equal(surveyImport({ ...emptySurvey(), answers: { name: "Ada" } }, wednesday), undefined);
});

test("funnel events count once per browser and variant, without answers", () => {
  let state = { ...emptySurvey(), variant: "survey", answers };
  let result = countEvent(state, "signed_up");
  assert.deepEqual(result.usage, {}, "sign-ups need an earlier counted exposure");
  result = countEvent(state, "shown");
  assert.deepEqual(result.usage, { funnel_survey_shown: 1 });
  state = result.state;
  assert.deepEqual(countEvent(state, "shown").usage, {});
  for (const event of ["started", "finished", "plan_shown", "google_clicked", "signed_up"]) {
    result = countEvent(state, event);
    assert.deepEqual(result.usage, { [`funnel_survey_${event}`]: 1 });
    state = result.state;
  }
  assert.deepEqual(countEvent(state, "skipped").usage, {}, "there is no skip left to count");
  assert.doesNotMatch(JSON.stringify(state.counted), /Ada|ship|engineer|phone/);
  const control = countEvent({ ...emptySurvey(), variant: "control" }, "shown");
  assert.deepEqual(control.usage, { funnel_control_shown: 1 });
  assert.deepEqual(countEvent(control.state, "started").usage, {}, "the control group has no survey to start");
  assert.deepEqual(countEvent(control.state, "signed_up").usage, { funnel_control_signed_up: 1 });
  assert.deepEqual(countEvent(emptySurvey(), "shown").usage, {}, "nothing is counted while the flow is off");
});
