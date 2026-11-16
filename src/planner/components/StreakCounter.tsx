import { createUniqueId, For, Show, untrack } from "solid-js";
import { type Streak, streakNote } from "../streak";

const STATES = {
  done: "done",
  missed: "missed",
  today: "today, not yet",
  ahead: "to come",
};

/** One flame outline, bottom-heavy, tip up. */
const FLAME =
  "M12 1.5C13.6 7.4 21 10.6 21 19.6A9 9 0 0 1 3 19.6C3 15 5.6 12 8 10C7.9 13 9.3 15 11 15.6C10 11 10.2 6 12 1.5Z";
const CORE =
  "M12.3 13.5C13.4 17.4 17 18.8 17 22.8A5 5 0 0 1 7 22.8C7 20.2 8.6 18.8 10 17.6C10.3 19.4 11.3 20.2 12.3 20.3C11.6 18.3 11.6 15.6 12.3 13.5Z";

/** The count it showed last time, so a new day can make it jump. The panel
 *  remounts on every planner update, so this lives outside the component. */
let shown: number | undefined;

/** Always on Today: days in a row as a lit flame, and this week as embers. */
export function StreakCounter(props: { streak: Streak }) {
  const id = createUniqueId();
  const days = () => props.streak.days;
  const grew = untrack(() => {
    const now = days();
    const up = shown !== undefined && now > shown;
    shown = now;
    return up;
  });
  const lit = () => days() > 0;
  const atRisk = () => lit() && props.streak.open;
  const level = () =>
    days() >= 100
      ? "blaze"
      : days() >= 30
        ? "hot"
        : days() >= 7
          ? "warm"
          : "lit";

  return (
    <section
      class="hud streak"
      classList={{ "is-lit": lit(), "is-open": atRisk(), "is-new": grew }}
      data-level={lit() ? level() : "out"}
      aria-label="Streak"
    >
      <p class="streak-count">
        <span class="streak-flame" aria-hidden="true">
          <svg viewBox="0 0 24 30">
            <defs>
              <linearGradient id={`${id}-o`} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" style={{ "stop-color": "var(--flame-low)" }} />
                <stop
                  offset="0.55"
                  style={{ "stop-color": "var(--flame-mid)" }}
                />
                <stop
                  offset="1"
                  style={{ "stop-color": "var(--flame-high)" }}
                />
              </linearGradient>
              <linearGradient id={`${id}-i`} x1="0" y1="1" x2="0" y2="0">
                <stop
                  offset="0"
                  style={{ "stop-color": "var(--flame-core)" }}
                />
                <stop
                  offset="1"
                  style={{ "stop-color": "var(--flame-high)" }}
                />
              </linearGradient>
            </defs>
            <g class="streak-fire">
              <path d={FLAME} fill={`url(#${id}-o)`} />
              <path class="streak-core" d={CORE} fill={`url(#${id}-i)`} />
            </g>
          </svg>
          <Show when={atRisk()}>
            <span class="streak-hourglass">⏳</span>
          </Show>
          <Show when={days() >= 100}>
            <span class="streak-hundred">💯</span>
          </Show>
        </span>
        <strong>{days()}</strong>
        <span class="streak-words">
          <span class="streak-unit">day streak</span>
          <span class="streak-note">{streakNote(props.streak)}</span>
        </span>
      </p>
      <ol class="streak-week" aria-label="This week">
        <For each={props.streak.week}>
          {(day) => (
            <li data-state={day.state}>
              <span class="streak-dot" aria-hidden="true">
                <Show when={day.state === "done"}>
                  <svg viewBox="0 0 24 30">
                    <path d={FLAME} />
                  </svg>
                </Show>
              </span>
              <span aria-hidden="true">{day.label}</span>
              <span class="visually-hidden">{STATES[day.state]}</span>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
