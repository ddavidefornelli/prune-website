import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { StreakParty } from "../planner/components/StreakParty";
import { streakFor } from "../planner/streak";
import { DANCES, type Dance } from "../planner/streak-party";
import "../styles/app.css";

/** Candidate prize sounds (Pixabay, free licence), to audition side by side. */
const SOUNDS = [
  "con-carne-7s",
  "success-fanfare-trumpets",
  "victory-fanfare",
  "victory-bell-fanfare",
  "triumph-jingle",
  "tadaa",
  "awards-fanfare-8",
  "brass-fanfare",
  "ritmo-sabroso",
  "reggaeton-logo",
];
const soundUrl = (name: string) =>
  new URL(`./sounds/${name}.m4a`, import.meta.url).href;

/**
 * Dev-only preview of the streak party (`npm run party`), with no sign-in.
 * Try /party.html?days=30&dance=spin to open straight on one.
 */
const DAY_MS = 86_400_000;
const params = new URLSearchParams(location.search);
const today = new Date().toISOString().slice(0, 10);

function streakOf(days: number) {
  const start = Date.parse(`${today}T00:00:00Z`);
  const completions = Array.from({ length: Math.max(1, days) }, (_, i) => ({
    day: new Date(start - i * DAY_MS).toISOString().slice(0, 10),
    count: 1,
  }));
  return streakFor({ today, completions });
}

function Preview() {
  const [days, setDays] = createSignal(Number(params.get("days")) || 5);
  const initial = params.get("dance");
  const [dance, setDance] = createSignal<Dance | "random">(
    DANCES.includes(initial as Dance) ? (initial as Dance) : "random",
  );
  const [sound, setSound] = createSignal(
    SOUNDS.includes(params.get("sound") ?? "") ? params.get("sound")! : "app",
  );
  // Bumped on every play so the party remounts with a fresh draw.
  const [play, setPlay] = createSignal<number | null>(1);
  const go = () => setPlay((n) => (n ?? 0) + 1);

  return (
    <main
      style={{
        display: "grid",
        gap: "14px",
        "max-width": "360px",
        margin: "0 auto",
        padding: "32px 16px",
      }}
    >
      <h1 style={{ margin: 0 }}>Streak party</h1>
      <label style={{ display: "grid", gap: "4px" }}>
        Day streak
        <input
          type="number"
          min="1"
          value={days()}
          onInput={(e) =>
            setDays(Math.max(1, e.currentTarget.valueAsNumber || 1))
          }
        />
      </label>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <For each={[1, 3, 7, 12, 30, 100, 365]}>
          {(n) => (
            <button
              type="button"
              onClick={() => {
                setDays(n);
                go();
              }}
            >
              {n}
            </button>
          )}
        </For>
      </div>
      <label style={{ display: "grid", gap: "4px" }}>
        Dance
        <select
          value={dance()}
          onChange={(e) => setDance(e.currentTarget.value as Dance | "random")}
        >
          <option value="random">Random</option>
          <For each={DANCES}>{(d) => <option value={d}>{d}</option>}</For>
        </select>
      </label>
      <label style={{ display: "grid", gap: "4px" }}>
        Sound
        <select
          value={sound()}
          onChange={(e) => {
            setSound(e.currentTarget.value);
            go();
          }}
        >
          <option value="app">In the app now</option>
          <For each={SOUNDS}>{(s) => <option value={s}>{s}</option>}</For>
        </select>
      </label>
      <button type="button" class="party-go" onClick={go}>
        Play
      </button>
      <Show when={play()} keyed>
        <StreakParty
          streak={streakOf(days())}
          dance={dance() === "random" ? undefined : (dance() as Dance)}
          sound={sound() === "app" ? undefined : soundUrl(sound())}
          onClose={() => setPlay(null)}
        />
      </Show>
    </main>
  );
}

const root = document.getElementById("root")!;
render(() => <Preview />, root);
