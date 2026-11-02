import {
  batch,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import type { PlanningClient } from "../planner/api";
import { RESUME_VIEW_KEY } from "../planner/constants";
import { errorMessage } from "../planner/errors";
import {
  hasPrivacyAcknowledgement,
  requirePrivacyAcknowledgement,
} from "../planner/privacy-state";
import { formatMinutes } from "../planner/quick-entry";
import { ANSWER_LIMITS, CHOICES, type SurveyAnswers } from "./answers";
import type { SurveyController } from "./create-survey";
import {
  buildPlan,
  CHOICE_STEPS,
  QUESTION_STEPS,
  questionNumber,
  type ChoiceStep,
  type FocusPlan,
  type SurveyStep,
} from "./model";
import "../styles/survey.css";

/** Long enough to see the choice land, short enough to feel instant. */
const ADVANCE_MS = 200;
/** The whole checklist, plus a beat on the last line, stays under 3 s. */
const CHECKLIST_MS = 2400;
const CHECKLIST_HOLD_MS = 300;

interface SurveyProps {
  survey: SurveyController;
  client: PlanningClient;
  initialError: string;
  configurationError: string;
  onEmail: () => void;
}

type StepProps = SurveyProps & {
  /** Moves focus after a step change, never on first load. */
  focus: (element: HTMLElement) => void;
};

const QUESTIONS: Record<ChoiceStep, (name?: string) => string> = {
  goal: (name) =>
    name ? `${name}, what are you here to do?` : "What are you here to do?",
  role: () => "What do you do?",
  window: () => "When do you focus best?",
  length: () => "How long can you focus before you drift?",
  derailer: (name) =>
    name ? `${name}, what derails you most?` : "What derails you most?",
  target: () => "How many hours of deep work do you want each day?",
};

/** Opens the planner on Today with the "Signed in" welcome after sign-in. */
function resumeOnToday(): void {
  try {
    sessionStorage.setItem(RESUME_VIEW_KEY, "today");
  } catch {
    /* Signing in still works without the welcome. */
  }
}

export function Survey(props: SurveyProps) {
  let settled = false;
  const focus = (element: HTMLElement) => {
    if (settled) element.focus({ preventScroll: true });
    settled = true;
  };
  return (
    <div class="survey" data-direction={props.survey.direction()}>
      <Show when={props.survey.step()} keyed>
        {(step) => (
          <Switch>
            <Match when={step === "intro"}>
              <Intro {...props} focus={focus} />
            </Match>
            <Match when={step === "name"}>
              <TextStep
                {...props}
                focus={focus}
                step="name"
                answer="name"
                question="First, what should we call you?"
                placeholder="First name"
                autocomplete="given-name"
                submit="Continue"
              />
            </Match>
            <Match when={step in CHOICE_STEPS && (step as ChoiceStep)}>
              {(choice) => (
                <ChoiceQuestion {...props} focus={focus} step={choice()} />
              )}
            </Match>
            <Match when={step === "fact"}>
              <Fact {...props} focus={focus} />
            </Match>
            <Match when={step === "outcome"}>
              <TextStep
                {...props}
                focus={focus}
                step="outcome"
                answer="weekGoal"
                question="One outcome you want this week?"
                placeholder="For example: launch the new homepage"
                hint="Optional. Once you sign in, your weekly review looks back on it."
                submit="Build my plan"
              />
            </Match>
            <Match when={step === "building"}>
              <Building {...props} focus={focus} />
            </Match>
            <Match when={step === "plan"}>
              <PlanResult {...props} focus={focus} />
            </Match>
            <Match when={step === "save"}>
              <SavePlan {...props} focus={focus} />
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  );
}

function Intro(props: StepProps) {
  let start!: HTMLButtonElement;
  onMount(() => props.focus(start));
  return (
    <section
      class="survey-step auth-panel survey-intro"
      aria-labelledby="survey-intro-title"
    >
      <h1 id="survey-intro-title">
        DO LESS.
        <br />
        ACHIEVE MORE.
      </h1>
      <p class="auth-description">
        A few quick questions, then you’ll get a focus plan built for you. About
        1 minute, no account needed yet.
      </p>
      <button
        ref={(element) => (start = element)}
        type="button"
        class="survey-primary"
        onClick={() => props.survey.start()}
      >
        Start
      </button>
      <button
        type="button"
        class="text-button survey-exit"
        onClick={() => props.survey.skip()}
      >
        Skip, just let me plan
      </button>
    </section>
  );
}

/** Back, progress and the quiet way out that every question screen shares. */
function Frame(props: {
  survey: SurveyController;
  step: SurveyStep;
  titleId: string;
  class?: string;
  exit?: boolean;
  children: JSX.Element;
}) {
  const number = questionNumber(untrack(() => props.step));
  return (
    <section
      class={`survey-step ${props.class ?? ""}`}
      aria-labelledby={props.titleId}
    >
      <div class="survey-bar">
        <button
          type="button"
          class="survey-back"
          aria-label="Back"
          onClick={() => props.survey.back()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <Show when={number}>
          {(current) => (
            <div
              class="survey-progress"
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={QUESTION_STEPS.length}
              aria-valuenow={current()}
              aria-valuetext={`Step ${current()} of ${QUESTION_STEPS.length}`}
            >
              <ol aria-hidden="true">
                <For each={QUESTION_STEPS}>
                  {(_, index) => (
                    <li
                      classList={{
                        "is-done": index() + 1 < current(),
                        "is-current": index() + 1 === current(),
                      }}
                    />
                  )}
                </For>
              </ol>
              <span class="survey-count" aria-hidden="true">
                {current()} / {QUESTION_STEPS.length}
              </span>
            </div>
          )}
        </Show>
      </div>
      <div class="survey-body">{props.children}</div>
      <Show when={props.exit}>
        <button
          type="button"
          class="text-button survey-exit"
          onClick={() => props.survey.skip()}
        >
          Skip, just let me plan
        </button>
      </Show>
    </section>
  );
}

function TextStep(
  props: StepProps & {
    step: "name" | "outcome";
    answer: "name" | "weekGoal";
    question: string;
    placeholder: string;
    autocomplete?: string;
    hint?: string;
    submit: string;
  },
) {
  const titleId = createUniqueId();
  const [value, setValue] = createSignal(
    untrack(() => props.survey.answers()[props.answer] ?? ""),
  );
  let input!: HTMLInputElement;
  onMount(() => props.focus(input));
  return (
    <Frame survey={props.survey} step={props.step} titleId={titleId} exit>
      <form
        class="survey-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.survey.answer({ [props.answer]: value() });
        }}
      >
        <h1 id={titleId} class="survey-question">
          {props.question}
        </h1>
        <input
          ref={(element) => (input = element)}
          aria-labelledby={titleId}
          name={props.answer}
          type="text"
          maxLength={ANSWER_LIMITS[props.answer]}
          placeholder={props.placeholder}
          autocomplete={props.autocomplete ?? "off"}
          autocapitalize={props.answer === "name" ? "words" : "sentences"}
          enterkeyhint="next"
          spellcheck={props.answer !== "name"}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <Show when={props.hint}>
          <p class="survey-hint">{props.hint}</p>
        </Show>
        <button type="submit" class="survey-primary">
          {props.submit}
        </button>
      </form>
    </Frame>
  );
}

function ChoiceQuestion(props: StepProps & { step: ChoiceStep }) {
  const titleId = createUniqueId();
  const key = untrack(() => CHOICE_STEPS[props.step]);
  const options: readonly { value: string | number; label: string }[] =
    CHOICES[key];
  const [picked, setPicked] = createSignal<string | number>();
  const chosen = () => picked() ?? props.survey.answers()[key];
  let heading!: HTMLHeadingElement;
  let timer: number | undefined;

  function choose(value: string | number): void {
    if (picked() !== undefined) return;
    setPicked(value);
    timer = window.setTimeout(
      () => props.survey.answer({ [key]: value } as SurveyAnswers),
      ADVANCE_MS,
    );
  }

  onMount(() => {
    props.focus(heading);
    // Number keys pick an answer on keyboards; touch never shows the hints.
    const keydown = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !Number.isInteger(index) ||
        !options[index]
      )
        return;
      event.preventDefault();
      choose(options[index].value);
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => {
      window.removeEventListener("keydown", keydown);
      clearTimeout(timer);
    });
  });

  return (
    <Frame survey={props.survey} step={props.step} titleId={titleId} exit>
      <h1
        id={titleId}
        ref={(element) => (heading = element)}
        class="survey-question"
        tabIndex={-1}
      >
        {QUESTIONS[props.step](props.survey.answers().name)}
      </h1>
      <div class="survey-options" role="group" aria-labelledby={titleId}>
        <For each={options}>
          {(option, index) => (
            <button
              type="button"
              aria-pressed={chosen() === option.value}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              <kbd aria-hidden="true">{index() + 1}</kbd>
            </button>
          )}
        </For>
      </div>
    </Frame>
  );
}

function Fact(props: StepProps) {
  const titleId = createUniqueId();
  let next!: HTMLButtonElement;
  onMount(() => props.focus(next));
  // A product rule rather than a statistic: there is no external claim to cite.
  return (
    <Frame
      survey={props.survey}
      step="fact"
      titleId={titleId}
      class="survey-fact"
      exit
    >
      <h1 id={titleId}>
        <span class="survey-fact-figure">3</span>{" "}
        <span class="survey-fact-line">
          tasks a day. That’s the whole rule.
        </span>
      </h1>
      <ol class="survey-fact-slots" aria-hidden="true">
        <li />
        <li />
        <li />
      </ol>
      <button
        ref={(element) => (next = element)}
        type="button"
        class="survey-primary"
        onClick={() => props.survey.answer({})}
      >
        Continue
      </button>
    </Frame>
  );
}

/** Each line names something buildPlan actually computed from the answers. */
function Building(props: StepProps) {
  const lines = untrack(() => buildPlan(props.survey.answers()).checklist);
  const [done, setDone] = createSignal(0);
  let heading!: HTMLHeadingElement;
  onMount(() => {
    props.focus(heading);
    const tick = CHECKLIST_MS / lines.length;
    const timers = lines.map((_, index) =>
      window.setTimeout(() => setDone(index + 1), (index + 1) * tick),
    );
    timers.push(
      window.setTimeout(
        () => props.survey.showPlan(),
        CHECKLIST_MS + CHECKLIST_HOLD_MS,
      ),
    );
    onCleanup(() => timers.forEach(clearTimeout));
  });
  return (
    <section
      class="survey-step survey-building"
      aria-labelledby="survey-building-title"
    >
      <div class="survey-body">
        <h1
          id="survey-building-title"
          ref={(element) => (heading = element)}
          class="survey-question"
          tabIndex={-1}
        >
          Building your plan…
        </h1>
        <ol class="survey-checklist" aria-live="polite">
          <For each={lines}>
            {(line, index) => (
              <li
                hidden={index() > done()}
                classList={{ "is-done": index() < done() }}
              >
                {line}
              </li>
            )}
          </For>
        </ol>
      </div>
    </section>
  );
}

function PlanSummary(props: {
  plan: FocusPlan;
  weekGoal?: string;
  total?: boolean;
}) {
  return (
    <div class="survey-plan">
      <ol class="survey-plan-tasks" aria-label="Today’s three tasks">
        <For each={props.plan.tasks}>
          {(task) => (
            <li>
              <span class="survey-plan-outcome">{task.outcome}</span>
              <span class="survey-plan-minutes">{task.minutes} min</span>
            </li>
          )}
        </For>
      </ol>
      <Show when={props.total}>
        <p class="survey-hint">
          {formatMinutes(props.plan.plannedMinutes * 60)} of focus, one task at
          a time.
        </p>
      </Show>
      <dl class="survey-plan-details">
        <div>
          <dt>Best focus window</dt>
          <dd>{props.plan.focus}</dd>
        </div>
        <Show when={props.weekGoal}>
          <div>
            <dt>This week</dt>
            <dd>{props.weekGoal}</dd>
          </div>
        </Show>
      </dl>
    </div>
  );
}

function PlanResult(props: StepProps) {
  const titleId = createUniqueId();
  const plan = createMemo(() => buildPlan(props.survey.answers()));
  const name = () => props.survey.answers().name;
  let heading!: HTMLHeadingElement;
  onMount(() => {
    props.focus(heading);
    props.survey.track("plan_shown");
  });
  return (
    <Frame
      survey={props.survey}
      step="plan"
      titleId={titleId}
      class="survey-result"
    >
      <h1
        id={titleId}
        ref={(element) => (heading = element)}
        class="survey-question"
        tabIndex={-1}
      >
        {name()
          ? `${name()}, here’s your focus plan.`
          : "Here’s your focus plan."}
      </h1>
      <PlanSummary
        plan={plan()}
        weekGoal={props.survey.answers().weekGoal}
        total
      />
      <div class="survey-actions">
        <button
          type="button"
          class="survey-cta"
          onClick={() => props.survey.keepPlan()}
        >
          Save my plan →
        </button>
      </div>
    </Frame>
  );
}

function SavePlan(props: StepProps) {
  const titleId = createUniqueId();
  const plan = createMemo(() => buildPlan(props.survey.answers()));
  const [acknowledged, setAcknowledged] = createSignal(
    hasPrivacyAcknowledgement(localStorage),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(untrack(() => props.initialError));
  let heading!: HTMLHeadingElement;
  onMount(() => props.focus(heading));

  async function continueWithGoogle(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy() || props.configurationError) return;
    batch(() => {
      setBusy(true);
      setError("");
    });
    try {
      requirePrivacyAcknowledgement(localStorage);
      setAcknowledged(true);
      props.survey.track("google_clicked");
      resumeOnToday();
      await props.client.signInWithGoogle();
      // The browser is on its way to Google; stay busy until it leaves.
    } catch (cause) {
      batch(() => {
        setError(errorMessage(cause));
        setBusy(false);
      });
    }
  }

  return (
    <Frame
      survey={props.survey}
      step="save"
      titleId={titleId}
      class="survey-save"
    >
      <h1
        id={titleId}
        ref={(element) => (heading = element)}
        class="survey-hero"
        tabIndex={-1}
      >
        SAVE YOUR PLAN.
      </h1>
      <p class="survey-lede">
        Sign in to sync it across devices, plus a free AI review of your week.
      </p>
      <PlanSummary plan={plan()} weekGoal={props.survey.answers().weekGoal} />
      <form
        class="survey-signin"
        aria-busy={busy()}
        onSubmit={(event) => void continueWithGoogle(event)}
      >
        <label class="privacy-acknowledgement" hidden={acknowledged()}>
          <input
            type="checkbox"
            name="privacy"
            required={!acknowledged()}
            disabled={busy()}
          />
          <span>
            I accept the <PrivacyPolicyButton />.
          </span>
        </label>
        <button
          type="submit"
          class="survey-google"
          disabled={busy() || !!props.configurationError}
        >
          <GoogleMark />
          {busy() ? "Opening Google…" : "Continue with Google"}
        </button>
      </form>
      <p class="error" role="alert">
        {props.configurationError || error()}
      </p>
      <div class="survey-alternatives">
        <button
          type="button"
          class="text-button"
          disabled={busy()}
          onClick={() => {
            resumeOnToday();
            props.onEmail();
          }}
        >
          Use email instead
        </button>
        <button
          type="button"
          class="text-button"
          disabled={busy()}
          onClick={() => props.survey.finishAsGuest()}
        >
          Not now, start planning
        </button>
      </div>
    </Frame>
  );
}

/** Google's multicolour mark, required next to "Continue with Google". */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
