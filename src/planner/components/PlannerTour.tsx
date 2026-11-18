import {
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import { PruneMark } from "../../components/Logo";
import { FLAME } from "./StreakCounter";

interface Scene {
  eyebrow: string;
  title: string;
  text: string;
  /** The button: each one a little more convinced than the last. */
  next: string;
}

/**
 * A new, empty planner opens on a short pitch, not a feature list:
 * full-screen scenes that show what a day with prune feels like. Onboarding
 * then continues on screens drawn the same way (OnboardingScreen): the first
 * task (FirstTaskDialog), the focus time and its reminders (FocusTimeDialog).
 */
const SCENES: readonly Scene[] = [
  {
    eyebrow: "Welcome to prune",
    title: "Busy isn’t done.",
    text: "Long lists feel productive and finish nothing. prune cuts yours down to the few things that actually move you forward.",
    next: "Show me how",
  },
  {
    eyebrow: "Then",
    title: "Lock in.",
    text: "One task. One timer. Everything else waits. This is where the real work gets done.",
    next: "I want that",
  },
  {
    eyebrow: "Every week",
    title: "Get sharper.",
    text: "prune studies how you really work, then hands you a smarter plan for next week. Better results without trying harder.",
    next: "What else?",
  },
  {
    eyebrow: "Every day",
    title: "Light it up.",
    text: "Finish what you planned and your streak catches fire. Day after day, you become someone who finishes.",
    next: "Let’s go",
  },
];

/** Onboarding's step numbers: the pitch, then the first task and the focus time's two screens. */
export const ONBOARDING = {
  task: SCENES.length + 1,
  focus: SCENES.length + 2,
  total: SCENES.length + 3,
} as const;

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** A scene's animation as numbered phases, each starting after its delay. */
function usePhases(delays: readonly number[]) {
  const [phase, setPhase] = createSignal(reducedMotion() ? delays.length : 0);
  onMount(() => {
    if (reducedMotion()) return;
    const timers = delays.map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    onCleanup(() => timers.forEach(clearTimeout));
  });
  return phase;
}

/** Onboarding's progress, one segment per step, across every screen. */
export function OnboardingProgress(props: { step: number }) {
  return (
    <ol
      class="tour-progress"
      style={{ "--steps": ONBOARDING.total }}
      aria-label={`Step ${props.step} of ${ONBOARDING.total}`}
    >
      <For each={Array.from({ length: ONBOARDING.total }, (_, i) => i + 1)}>
        {(step) => (
          <li
            classList={{
              "is-done": step < props.step,
              "is-current": step === props.step,
            }}
          />
        )}
      </For>
    </ol>
  );
}

/**
 * An onboarding screen after the pitch, drawn like its scenes: the glow, the
 * progress, a picture, big words, then the controls and the actions.
 */
export function OnboardingScreen(props: {
  step: number;
  headingId: string;
  eyebrow: string;
  title: JSX.Element;
  text: JSX.Element;
  /** A colour token for the wash behind the screen. */
  glow?: string;
  visual?: JSX.Element;
  children?: JSX.Element;
  actions: JSX.Element;
}) {
  return (
    <div
      class="tour onboarding-screen"
      style={props.glow ? { "--glow": props.glow } : undefined}
    >
      <div class="tour-glow" aria-hidden="true" />
      <div class="tour-bar">
        <span />
        <OnboardingProgress step={props.step} />
        <span />
      </div>
      <div class="tour-body">
        <Show when={props.visual}>
          <div class="tour-stage" aria-hidden="true">
            {props.visual}
          </div>
        </Show>
        <div class="tour-copy">
          <div class="tour-caption is-current">
            <span class="tour-eyebrow">{props.eyebrow}</span>
            <h2 id={props.headingId} tabIndex={-1}>
              {props.title}
            </h2>
            <p>{props.text}</p>
          </div>
        </div>
        {props.children}
      </div>
      <div class="tour-actions">{props.actions}</div>
    </div>
  );
}

interface PlannerTourProps {
  /** The last scene's button: on to the first task. */
  onFinish: () => void;
}

export function PlannerTour(props: PlannerTourProps) {
  const [index, setIndex] = createSignal(0);
  const [direction, setDirection] = createSignal(1);
  const headingId = createUniqueId();
  const scene = () => SCENES[index()]!;
  const last = () => index() === SCENES.length - 1;
  let heading!: HTMLHeadingElement;

  const go = (to: number) => {
    if (to < 0) return;
    if (to >= SCENES.length) return props.onFinish();
    setDirection(to > index() ? 1 : -1);
    setIndex(to);
    heading.focus({ preventScroll: true });
  };

  // Swipe sideways to move between scenes, like any phone story.
  let startX: number | null = null;
  let startY = 0;

  return (
    <Dialog
      class="planner-tour-dialog"
      aria-labelledby={headingId}
      onDismiss={() => {}}
      preventCancel
      initialFocus={() => heading.focus({ preventScroll: true })}
    >
      <div
        class="tour"
        data-scene={index()}
        data-last={last() ? "" : undefined}
        style={{ "--direction": direction() }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") go(index() + 1);
          if (event.key === "ArrowLeft") go(index() - 1);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          startX = event.clientX;
          startY = event.clientY;
        }}
        onPointerUp={(event) => {
          if (startX === null) return;
          const dx = event.clientX - startX;
          const dy = event.clientY - startY;
          startX = null;
          if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
          // Never finish by swiping: the last step is a choice.
          if (dx < 0 && !last()) go(index() + 1);
          if (dx > 0) go(index() - 1);
        }}
      >
        <div class="tour-glow" aria-hidden="true" />
        <div class="tour-bar">
          <button
            type="button"
            onClick={() => go(index() - 1)}
            style={{ visibility: index() > 0 ? "visible" : "hidden" }}
          >
            Back
          </button>
          <OnboardingProgress step={index() + 1} />
          <span />
        </div>
        <div class="tour-body">
          <div class="tour-stage" aria-hidden="true">
            <Switch>
              <Match when={index() === 0}>
                <PruneScene />
              </Match>
              <Match when={index() === 1}>
                <FocusScene />
              </Match>
              <Match when={index() === 2}>
                <CheckInScene />
              </Match>
              <Match when={index() === 3}>
                <StreakScene />
              </Match>
            </Switch>
          </div>
          <div class="tour-copy">
            <For each={SCENES}>
              {(item, i) => (
                <div
                  class="tour-caption"
                  classList={{ "is-current": i() === index() }}
                  aria-hidden={i() !== index()}
                >
                  <span class="tour-eyebrow">{item.eyebrow}</span>
                  {i() === index() ? (
                    <h2
                      ref={(element) => (heading = element)}
                      id={headingId}
                      tabIndex={-1}
                    >
                      {scene().title}
                    </h2>
                  ) : (
                    <p class="tour-title">{item.title}</p>
                  )}
                  <p>{item.text}</p>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="tour-actions">
          <button
            type="button"
            class="tour-primary"
            onClick={() => go(index() + 1)}
          >
            {scene().next}
            <span aria-hidden="true" class="tour-arrow">
              →
            </span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- 1 · The cut: a long list pruned to the three that matter ---------- */

const LIST = [
  { title: "Reply to 43 emails", cut: true, tilt: -8 },
  { title: "Finish the pitch deck", minutes: 45 },
  { title: "Reorganise the desktop", cut: true, tilt: 6 },
  { title: "Research productivity apps", cut: true, tilt: -5 },
  { title: "Call the landlord", minutes: 15 },
  { title: "Plan the plan", cut: true, tilt: 9 },
  { title: "Watch one more tutorial", cut: true, tilt: -7 },
  { title: "Run 5k", minutes: 30 },
  { title: "Clean the inbox (again)", cut: true, tilt: 4 },
] as const;

function PruneScene() {
  const phase = usePhases([900, 2000]);
  let cut = 0;
  return (
    <div class="prune-scene" data-phase={phase()}>
      <ul class="prune-scene-list">
        <For each={LIST}>
          {(item, i) => {
            const k = "cut" in item ? cut++ : 0;
            return (
              <li
                class={"cut" in item ? "is-cut" : "is-kept"}
                style={{
                  "--i": i(),
                  "--k": k,
                  "--tilt": `${"tilt" in item ? item.tilt : 0}deg`,
                }}
              >
                <span class="scene-task-title">{item.title}</span>
                {"minutes" in item && (
                  <span class="prune-scene-minutes">{item.minutes}m</span>
                )}
              </li>
            );
          }}
        </For>
      </ul>
    </div>
  );
}

/* ---------- 2 · Lock in: a focus timer running down to done ---------- */

const FOCUS_SECONDS = 45 * 60;
const RING = 2 * Math.PI * 46;

function FocusScene() {
  const reduced = reducedMotion();
  const [left, setLeft] = createSignal(reduced ? 0 : FOCUS_SECONDS);
  const done = () => left() === 0;
  onMount(() => {
    if (reduced) return;
    let frame = 0;
    const delay = 500;
    const duration = 2600;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - started - delay) / duration));
      // Slow, then flying, then landing: time disappears when you're in it.
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      setLeft(Math.round(FOCUS_SECONDS * (1 - eased)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const digits = () => {
    const s = left();
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <div class="focus-scene" classList={{ "is-done": done() }}>
      <p class="focus-scene-title">Finish the pitch deck</p>
      <div class="focus-scene-timer">
        <svg viewBox="0 0 100 100">
          <circle class="focus-scene-track" cx="50" cy="50" r="46" />
          <circle
            class="focus-scene-progress"
            cx="50"
            cy="50"
            r="46"
            stroke-dasharray={String(RING)}
            stroke-dashoffset={String(RING * (left() / FOCUS_SECONDS))}
          />
        </svg>
        <span class="focus-scene-digits">{done() ? "Done" : digits()}</span>
        <span class="focus-scene-check">✓</span>
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
          {(i) => <span class="focus-scene-spark" style={{ "--a": i }} />}
        </For>
      </div>
      <p class="focus-scene-hint">
        {done() ? "Task complete" : "Focus mode · no distractions"}
      </p>
    </div>
  );
}

/** A number that counts up from zero once its scene is on screen. */
function useCountUp(target: number, delay: number, duration: number) {
  const reduced = reducedMotion();
  const [value, setValue] = createSignal(reduced ? target : 0);
  onMount(() => {
    if (reduced) return;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - started - delay) / duration));
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return value;
}

/* ---------- 3 · Get sharper: the weekly check-in ---------- */

const DAYS = [
  { day: "M", done: 3 },
  { day: "T", done: 4, best: true },
  { day: "W", done: 2 },
  { day: "T", done: 3 },
  { day: "F", done: 4, best: true },
  { day: "S", done: 1 },
  { day: "S", done: 1 },
] as const;

function CheckInScene() {
  const phase = usePhases([250, 1500]);
  const done = useCountUp(18, 300, 1100);
  const onTarget = useCountUp(87, 500, 1100);
  return (
    <div class="checkin-scene" data-phase={phase()}>
      <div class="checkin-card">
        <span class="checkin-label">Your week</span>
        <div class="checkin-stats">
          <div>
            <b>{done()}</b>
            <span>tasks done</span>
          </div>
          <div>
            <b>{onTarget()}%</b>
            <span>estimates on target</span>
          </div>
        </div>
        <ol class="checkin-bars">
          <For each={DAYS}>
            {(item, i) => (
              <li
                classList={{ "is-best": "best" in item }}
                style={{ "--h": item.done / 4, "--i": i() }}
              >
                <span class="checkin-bar" />
                {item.day}
              </li>
            )}
          </For>
        </ol>
        <p class="checkin-tip" classList={{ "is-thinking": phase() < 2 }}>
          <span>✦ {phase() < 2 ? "Studying your week…" : "Next week"}</span>
          {phase() < 2
            ? "Finding your best days"
            : "Tuesdays and Fridays are your power days. Save the hard stuff for them."}
        </p>
      </div>
    </div>
  );
}

/* ---------- The focus-time nudge, on a phone's lock screen ---------- */

const clock = (minute: number) =>
  `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`;

/** The reminder arriving at the chosen time; with a task, a tap starts it. */
export function NudgeScene(props: {
  minute: number;
  task?: { outcome: string; minutes: number };
}) {
  const phase = usePhases([700, 1100, 2300, 2700]);
  const day = () => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() < props.minute
      ? "Today"
      : "Tomorrow";
  };
  const started = () => phase() >= 4 && props.task;
  return (
    <div class="nudge-scene" data-phase={phase()}>
      <div class="nudge-phone">
        <span class="nudge-date">{day()}</span>
        <span class="nudge-clock">
          {clock(phase() >= 1 ? props.minute : (props.minute + 1439) % 1440)}
        </span>
        <div class="nudge-note" classList={{ "is-started": !!started() }}>
          <PruneMark size={30} />
          <div class="nudge-text">
            <span class="nudge-head">
              <b>prune</b>
              <span>now</span>
            </span>
            <span class="nudge-body">
              {started()
                ? `▶ Focus started · ${props.task!.minutes}:00`
                : props.task
                  ? `Time to focus. “${props.task.outcome}” is up first.`
                  : "Time to focus. What’s today’s win?"}
            </span>
          </div>
          <span class="nudge-tap" />
        </div>
      </div>
    </div>
  );
}

/* ---------- 4 · Light it up: a week of embers and a growing flame ---------- */

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

function StreakScene() {
  const phase = usePhases(WEEK.map((_, i) => 450 + i * 260));
  const blazing = () => phase() === WEEK.length;
  return (
    <div
      class="streak-scene"
      classList={{ "is-blazing": blazing() }}
      style={{ "--days": phase() }}
    >
      <div class="streak-scene-flame">
        <svg viewBox="0 0 24 26">
          <defs>
            <linearGradient id="tour-flame" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stop-color="var(--flame-low)" />
              <stop offset="0.55" stop-color="var(--flame-mid)" />
              <stop offset="1" stop-color="var(--flame-high)" />
            </linearGradient>
          </defs>
          <path d={FLAME} fill="url(#tour-flame)" />
        </svg>
        <span class="streak-scene-count">{phase()}</span>
      </div>
      <p class="streak-scene-label">
        {phase() === 1 ? "day" : "days"} in a row
      </p>
      <ol class="streak-scene-week">
        <For each={WEEK}>
          {(day, i) => (
            <li classList={{ "is-lit": i() < phase() }}>
              <span class="streak-scene-ember" />
              {day}
            </li>
          )}
        </For>
      </ol>
      <PruneMark class="streak-scene-plum" size={44} />
    </div>
  );
}
