import {
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Switch,
  type JSX,
} from "solid-js";

/**
 * The signed-out product tour below the sign-in hero: a framed, auto-playing
 * look at each planner screen, then one row per idea. Every "screenshot" is
 * drawn with HTML so it stays crisp, animates, and needs no network.
 */

const SCREENS = [
  {
    id: "today",
    label: "Today",
    caption:
      "Today: three tasks, the one up next, and when you'll be done if you start now.",
  },
  {
    id: "focus",
    label: "Focus",
    caption: "Focus: one task, one timer you can pause, and a scratchpad.",
  },
  {
    id: "tomorrow",
    label: "Tomorrow",
    caption:
      "Tomorrow: plan the next day tonight. Unfinished work is suggested for the open slot.",
  },
  {
    id: "overview",
    label: "Overview",
    caption:
      "Overview: a completion calendar and a free weekly review of what held you back.",
  },
] as const;
type ScreenId = (typeof SCREENS)[number]["id"];

const FOCUS_TOTAL = 45 * 60;
const FOCUS_START = 42 * 60 + 17;

/** A fixed, believable month: mostly full days, a few misses, a recent streak. */
const CALENDAR = [
  3, 2, 3, 0, 1, 3, 3, 2, 3, 3, 1, 0, 2, 3, 3, 3, 2, 0, 3, 1, 2, 3, 3, 2, 3, 3,
  3, 3, 2, 3, 3, 3, 1, 0, 0,
] as const;

const PRUNE_LIST = [
  { title: "Write the first draft", keep: true },
  { title: "Reorganise every bookmark", keep: false },
  { title: "Answer all 43 emails", keep: false },
  { title: "Call the accountant", keep: true },
  { title: "Research yet another notes app", keep: false },
  { title: "Tweak the colour theme", keep: false },
  { title: "Ship the small update", keep: true },
  { title: "Clean the downloads folder", keep: false },
] as const;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Calls back whenever the element enters or leaves the viewport. */
function watchViewport(
  element: Element,
  onChange: (visible: boolean) => void,
  threshold = 0.2,
): void {
  if (!("IntersectionObserver" in window)) {
    onChange(true);
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => onChange(entry.isIntersecting),
    { threshold },
  );
  observer.observe(element);
  onCleanup(() => observer.disconnect());
}

/** Marks a block while it is on screen, so its loops only run there. */
function markInView(element: HTMLElement): void {
  watchViewport(element, (visible) =>
    element.toggleAttribute("data-in-view", visible),
  );
}

/** Below the fold: also fades the block in the first time it scrolls into view. */
function reveal(element: HTMLElement): void {
  watchViewport(element, (visible) => {
    if (visible) element.classList.add("is-revealed");
    element.toggleAttribute("data-in-view", visible);
  });
}

function clock(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export function ProductPreview(props: { action: JSX.Element }) {
  let section!: HTMLElement;
  const [active, setActive] = createSignal<ScreenId>("today");
  const [autoplay, setAutoplay] = createSignal(!reducedMotion());
  const [remaining, setRemaining] = createSignal(FOCUS_START);
  const tabs: HTMLButtonElement[] = [];

  onMount(() => {
    if (reducedMotion()) return;
    let timer: number | undefined;
    const tick = () =>
      setRemaining((seconds) => (seconds <= 1 ? FOCUS_TOTAL : seconds - 1));
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    // The demo clock only runs while the preview is on screen.
    watchViewport(
      section,
      (visible) => {
        stop();
        if (visible) timer = window.setInterval(tick, 1000);
      },
      0,
    );
    onCleanup(stop);
  });

  const select = (id: ScreenId, focus = false) => {
    setActive(id);
    if (focus) tabs[SCREENS.findIndex((screen) => screen.id === id)]?.focus();
  };

  const advance = () => {
    const index = SCREENS.findIndex((screen) => screen.id === active());
    select(SCREENS[(index + 1) % SCREENS.length].id);
  };

  const onTabKey = (event: KeyboardEvent) => {
    const index = SCREENS.findIndex((screen) => screen.id === active());
    const next = {
      ArrowRight: (index + 1) % SCREENS.length,
      ArrowLeft: (index - 1 + SCREENS.length) % SCREENS.length,
      Home: 0,
      End: SCREENS.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setAutoplay(false);
    select(SCREENS[next].id, true);
  };

  return (
    <section
      ref={(element) => (section = element)}
      id="product-preview"
      class="product-preview"
      aria-labelledby="preview-title"
    >
      <div
        class="showcase"
        ref={markInView}
        classList={{ "is-autoplaying": autoplay() }}
      >
        <div class="showcase-stage">
          <div class="device-browser">
            <div class="device-screen">
              <div class="screen-column">
                {/* The planner's own navigation bar, working as the switcher. */}
                <div
                  class="app-nav"
                  role="tablist"
                  aria-label="App screens"
                  onKeyDown={onTabKey}
                  style={{
                    "--index": SCREENS.findIndex(
                      (screen) => screen.id === active(),
                    ),
                  }}
                >
                  <span class="app-nav-selection" aria-hidden="true" />
                  <Index each={SCREENS}>
                    {(screen, index) => (
                      <button
                        ref={(element) => (tabs[index] = element)}
                        type="button"
                        role="tab"
                        id={`preview-tab-${screen().id}`}
                        aria-controls={`preview-panel-${screen().id}`}
                        aria-selected={active() === screen().id}
                        tabIndex={active() === screen().id ? 0 : -1}
                        onClick={() => {
                          setAutoplay(false);
                          select(screen().id);
                        }}
                      >
                        {screen().label}
                        <span
                          class="autoplay-timer"
                          aria-hidden="true"
                          onAnimationEnd={() => {
                            if (autoplay() && active() === screen().id)
                              advance();
                          }}
                        />
                      </button>
                    )}
                  </Index>
                </div>
                <div class="screen-panels">
                  <For each={SCREENS}>
                    {(screen) => (
                      <div
                        role="tabpanel"
                        id={`preview-panel-${screen.id}`}
                        aria-labelledby={`preview-tab-${screen.id}`}
                        class="screen-panel"
                        classList={{ "is-active": active() === screen.id }}
                        aria-hidden={active() !== screen.id}
                      >
                        <p class="visually-hidden">{screen.caption}</p>
                        <div class="mock-screen" aria-hidden="true">
                          <Switch>
                            <Match when={screen.id === "today"}>
                              <TodayMock />
                            </Match>
                            <Match when={screen.id === "focus"}>
                              <FocusMock remaining={remaining()} />
                            </Match>
                            <Match when={screen.id === "tomorrow"}>
                              <TomorrowMock />
                            </Match>
                            <Match when={screen.id === "overview"}>
                              <OverviewMock />
                            </Match>
                          </Switch>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>

          <div class="device-phone" aria-hidden="true">
            <span class="phone-notch" />
            <p class="phone-title">Write the first draft</p>
            <TimerRing remaining={remaining()} total={FOCUS_TOTAL} />
            <span class="mock-button is-primary">Complete task</span>
          </div>
        </div>
      </div>

      <header class="preview-intro reveal" ref={reveal}>
        <p class="preview-eyebrow">Inside prune</p>
        <h2 id="preview-title">
          ONE DAY.
          <br />
          THREE TASKS.
          <br />
          NOTHING ELSE.
        </h2>
        <p>
          A planner that refuses to let your list grow. Pick three, work them
          one at a time, and let the weekly review tell you what got in the way.
        </p>
      </header>

      <div class="feature-rows">
        <Feature
          index="01"
          eyebrow="Prune"
          title={
            <>
              TWENTY IN,
              <br />
              THREE OUT.
            </>
          }
          body="Every day holds three tasks, never more. Choosing what not to do is the feature: the rest waits for tomorrow, or quietly disappears."
          caption="A long to-do list is cut down to three tasks."
        >
          <div class="prune-visual">
            <p class="prune-heading">
              <span class="prune-count-before">8 things</span>
              <span class="prune-count-after">3 tasks</span>
            </p>
            <ul class="prune-list">
              <Index each={PRUNE_LIST}>
                {(item, index) => (
                  <li
                    classList={{
                      "is-kept": item().keep,
                      "is-cut": !item().keep,
                    }}
                    style={{ "--i": index }}
                  >
                    <span>{item().title}</span>
                  </li>
                )}
              </Index>
            </ul>
          </div>
        </Feature>

        <Feature
          index="02"
          eyebrow="Focus"
          flip
          title={
            <>
              ONE TASK.
              <br />
              ONE TIMER.
            </>
          }
          body="Start any of your three and everything else fades. Pause when life interrupts and say why, so the interruptions add up to something you can fix."
          caption="A focus timer counting down, with a pause reason being recorded."
        >
          <div class="focus-visual">
            <TimerRing remaining={remaining()} total={FOCUS_TOTAL} />
            <div class="pause-reasons">
              <span>Paused because</span>
              <b>Meeting ran over</b>
              <b>Slack</b>
              <b>Lost the thread</b>
            </div>
          </div>
        </Feature>

        <Feature
          index="03"
          eyebrow="Weekly review"
          title={
            <>
              SEE WHAT HOLDS
              <br />
              YOU BACK.
            </>
          }
          body="Every Sunday prune reads your week, finished tasks, estimates and stop reasons, and writes a short, honest review. Free, automatic, yours."
          caption="A completion calendar filling in, next to a weekly review."
        >
          <div class="review-visual">
            <CalendarGrid />
            <div class="review-card">
              <p class="mock-up-next">Week 44 review</p>
              <p class="review-line">
                You finished <b>11 of 15</b> tasks.
              </p>
              <p class="review-line">
                4 of 6 pauses came after 3 PM, all marked{" "}
                <b>“meeting ran over”</b>.
              </p>
              <p class="review-line">
                Try this week: put your hardest task before lunch.
              </p>
            </div>
          </div>
        </Feature>
      </div>

      <div class="preview-cta reveal" ref={reveal}>
        {props.action}
      </div>
    </section>
  );
}

function Feature(props: {
  index: string;
  eyebrow: string;
  title: JSX.Element;
  body: string;
  caption: string;
  flip?: boolean;
  children: JSX.Element;
}) {
  return (
    <article
      class="feature reveal"
      classList={{ "is-flipped": props.flip }}
      ref={reveal}
    >
      <div class="feature-copy">
        <p class="preview-eyebrow">
          <span class="feature-index">{props.index}</span> {props.eyebrow}
        </p>
        <h3>{props.title}</h3>
        <p>{props.body}</p>
      </div>
      <figure class="feature-visual">
        <div aria-hidden="true">{props.children}</div>
        <figcaption class="visually-hidden">{props.caption}</figcaption>
      </figure>
    </article>
  );
}

function Dial(props: { minutes: number; done?: boolean }) {
  const circumference = 2 * Math.PI * 20;
  return (
    <span class="mock-dial" classList={{ "is-done": props.done }}>
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="20" class="dial-track" />
        <circle
          cx="24"
          cy="24"
          r="20"
          class="dial-value"
          stroke-dasharray={`${circumference}`}
          stroke-dashoffset={`${circumference * (1 - Math.min(props.minutes, 60) / 60)}`}
        />
      </svg>
      <span>{props.done ? "✓" : props.minutes}</span>
    </span>
  );
}

function TimerRing(props: { remaining: number; total: number }) {
  const circumference = 2 * Math.PI * 54;
  return (
    <div class="mock-timer">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="54" class="timer-track" />
        <circle
          cx="60"
          cy="60"
          r="54"
          class="timer-value"
          stroke-dasharray={`${circumference}`}
          stroke-dashoffset={`${circumference * (1 - props.remaining / props.total)}`}
        />
      </svg>
      <span class="timer-digits">{clock(props.remaining)}</span>
      <span class="timer-hint">remaining · Tap to pause</span>
    </div>
  );
}

function TodayMock() {
  return (
    <>
      <p class="mock-summary">
        1 of 3 done · 1 h 10 min left · finish around <em>4:40 PM</em>
      </p>
      <ol class="mock-slots">
        <li class="is-done" />
        <li class="is-active" />
        <li class="is-planned" />
      </ol>
      <div class="mock-task is-done">
        <span class="mock-task-title">Call the accountant</span>
        <Dial minutes={20} done />
      </div>
      <div class="mock-task is-next">
        <p class="mock-up-next">Up next</p>
        <div class="mock-task-row">
          <span class="mock-task-title">Write the first draft</span>
          <Dial minutes={45} />
        </div>
        <span class="mock-button is-primary">Start focus</span>
      </div>
      <div class="mock-task">
        <div class="mock-task-row">
          <span class="mock-task-title">Ship the small update</span>
          <Dial minutes={25} />
        </div>
        <span class="mock-button">Start focus</span>
      </div>
    </>
  );
}

function FocusMock(props: { remaining: number }) {
  return (
    <>
      <p class="mock-focus-title">Write the first draft</p>
      <TimerRing remaining={props.remaining} total={FOCUS_TOTAL} />
      <p class="mock-label">Notes</p>
      <div class="mock-notes">
        Intro done. Next: the three examples
        <span class="mock-caret" />
      </div>
      <span class="mock-button is-primary">Complete task</span>
    </>
  );
}

function TomorrowMock() {
  return (
    <>
      <p class="mock-summary">
        Tomorrow · 2 of 3 planned · about <em>1 h 20 min</em>
      </p>
      <ol class="mock-slots">
        <li class="is-planned" />
        <li class="is-planned" />
        <li class="is-filling" />
      </ol>
      <div class="mock-task">
        <div class="mock-task-row">
          <span class="mock-task-title">Outline the talk</span>
          <Dial minutes={60} />
        </div>
      </div>
      <div class="mock-task">
        <div class="mock-task-row">
          <span class="mock-task-title">Book the dentist</span>
          <Dial minutes={10} />
        </div>
      </div>
      <div class="mock-open-slot">
        <span class="mock-open-label">Open slot</span>
        <span class="mock-suggestion">
          <small>Carry over from today</small>
          Ship the small update · 25 min
        </span>
      </div>
    </>
  );
}

function OverviewMock() {
  return (
    <>
      <dl class="mock-stats">
        <div>
          <dd>6</dd>
          <dt>day streak</dt>
        </div>
        <div>
          <dd>82%</dd>
          <dt>tasks finished</dt>
        </div>
        <div>
          <dd>14 h</dd>
          <dt>focused</dt>
        </div>
      </dl>
      <CalendarGrid />
      <div class="mock-review-ready">
        <p class="mock-up-next">Weekly review</p>
        <span>Your review for week 44 is ready</span>
      </div>
    </>
  );
}

function CalendarGrid() {
  return (
    <div class="mock-calendar">
      <For each={["M", "T", "W", "T", "F", "S", "S"]}>
        {(day) => <span class="calendar-day">{day}</span>}
      </For>
      <Index each={CALENDAR}>
        {(level, index) => (
          <span
            class={`calendar-cell level-${level()}`}
            style={{ "--i": index }}
          />
        )}
      </Index>
    </div>
  );
}
