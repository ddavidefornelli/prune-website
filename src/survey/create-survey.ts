import { batch, createMemo, createSignal, onMount } from "solid-js";
import { reportGuestUsage, type GuestUsage } from "../planner/guest-usage.ts";
import type { SurveyAnswers } from "./answers.ts";
import {
  answer,
  assignVariant,
  back,
  countEvent,
  finishAsGuest,
  finishSignedIn,
  keepPlan,
  reachedEvent,
  readSurvey,
  skip,
  start,
  surveyImport,
  surveyVisible,
  writeSurvey,
  type FunnelEvent,
  type SurveyFlag,
  type SurveyState,
  type SurveyStep,
} from "./model.ts";

interface SurveyOptions {
  flag: SurveyFlag;
  /** No guest journal and no notice acceptance on this browser yet. */
  fresh: boolean;
  storage?: Pick<Storage, "getItem" | "setItem">;
  report?: (usage: GuestUsage) => void;
  now?: () => Date;
  random?: () => number;
}

/** One survey per session. Every change is stored before it renders. */
export function createSurvey(options: SurveyOptions) {
  const storage = options.storage ?? localStorage;
  const report = options.report ?? reportGuestUsage;
  const now = options.now ?? (() => new Date());
  const [state, setState] = createSignal(load());
  const [direction, setDirection] = createSignal<"forward" | "back">("forward");
  const visible = createMemo(() => surveyVisible(state(), options.fresh));

  function load(): SurveyState {
    const saved = readSurvey(storage);
    const variant = assignVariant(options.flag, saved.variant, options.random);
    // The checklist animation is transient; a reload resumes on its result.
    const step = saved.step === "building" ? "plan" : saved.step;
    return variant === saved.variant && step === saved.step
      ? saved
      : writeSurvey(storage, { ...saved, variant, step });
  }

  /** Re-reads storage first, and never writes when nothing changed. */
  function update(
    change: (current: SurveyState) => SurveyState,
    to: "forward" | "back" = "forward",
  ): void {
    const current = readSurvey(storage);
    const next = change(current);
    if (next === current) return;
    batch(() => {
      setDirection(to);
      setState(writeSurvey(storage, next));
    });
  }

  function track(event: FunnelEvent): void {
    let usage: GuestUsage = {};
    update((current) => {
      const counted = countEvent(current, event);
      usage = counted.usage;
      return counted.state;
    }, direction());
    report(usage);
  }

  onMount(() => {
    // One exposure per browser at its first eligible visit, in either variant.
    const current = state();
    if (
      visible() ||
      (current.variant === "control" &&
        current.status === "new" &&
        options.fresh)
    )
      track("shown");
  });

  return {
    state,
    step: () => state().step,
    answers: () => state().answers,
    direction,
    visible,
    track,
    start() {
      update(start);
      track("started");
    },
    /** Ignored unless `from` is still the current step: no double submits. */
    answer(from: SurveyStep, patch: SurveyAnswers) {
      if (state().step !== from) return;
      update((current) => answer(current, patch, now()));
      if (from === "outcome") track("finished");
      const reached = reachedEvent(state().step);
      if (reached) track(reached);
    },
    back: () => update(back, "back"),
    showPlan: () => update((current) => ({ ...current, step: "plan" })),
    keepPlan: () => update(keepPlan),
    skip() {
      track("skipped");
      update(skip);
    },
    /** "Not now", or leaving the email form opened from the survey. */
    finishAsGuest() {
      if (visible()) update(finishAsGuest);
    },
    importPayload: () => surveyImport(readSurvey(storage), now()),
    signedIn(interactive: boolean, imported: boolean) {
      update((current) => {
        const next = finishSignedIn(current);
        return imported ? { ...next, synced: true } : next;
      });
      if (interactive) track("signed_up");
    },
  };
}

export type SurveyController = ReturnType<typeof createSurvey>;
