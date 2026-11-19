import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { AmbientSoundPlayer, type AmbientSoundKind } from "../ambient-sound";

type Choice = AmbientSoundKind | "off";

const CHOICES: { value: Choice; label: string; icon: string }[] = [
  {
    value: "off",
    label: "Off",
    // A speaker with a cross.
    icon: "M2 6h2.5L8 3v10l-3.5-3H2Zm8.5 0 4 4m0-4-4 4",
  },
  {
    value: "rain",
    label: "Rain",
    // A cloud with three falling drops.
    icon: "M5.5 9.5a3 3 0 0 1-.4-6A4 4 0 0 1 12.8 4a2.8 2.8 0 0 1-.3 5.5Zm.5 2-1 2.5m4-2.5-1 2.5m4-2.5-1 2.5",
  },
  {
    value: "white-noise",
    label: "White noise",
    // A soft wave.
    icon: "M1.5 8c1.2 0 1.2-4 2.5-4s1.3 8 2.6 8 1.2-8 2.5-8 1.3 8 2.6 8 1.3-4 2.5-4",
  },
];

/** Off, rain or white noise to focus to. It stops when the focus screen closes. */
export function FocusSounds() {
  const sound = new AmbientSoundPlayer();
  onCleanup(() => sound.dispose());
  const [choice, setChoice] = createSignal<Choice>("off");
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const initialVolume = AmbientSoundPlayer.savedVolume();
  const [volume, setVolume] = createSignal(initialVolume);
  sound.setVolume(initialVolume);
  const name = createUniqueId();

  function choose(next: Choice): void {
    setChoice(next);
    setFailed(false);
    if (next === "off") {
      sound.stop();
      setLoading(false);
      return;
    }
    setLoading(true);
    sound.play(next).then(
      () => {
        if (choice() === next) setLoading(false);
      },
      () => {
        if (choice() !== next) return;
        setLoading(false);
        setFailed(true);
        setChoice("off");
      },
    );
  }

  return (
    <fieldset class="focus-sounds" aria-busy={loading()}>
      <legend class="focus-sounds-label">Sounds</legend>
      <div class="focus-sounds-options">
        <For each={CHOICES}>
          {(option) => (
            <label
              class="focus-sound"
              classList={{
                "is-loading": loading() && choice() === option.value,
              }}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={choice() === option.value}
                onChange={() => choose(option.value)}
              />
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d={option.icon} />
              </svg>
              {option.label}
            </label>
          )}
        </For>
      </div>
      <Show when={failed()}>
        <p class="focus-sounds-error" role="status">
          That sound didn't load. Check your connection and try again.
        </p>
      </Show>
      <Show when={choice() !== "off"}>
        <div class="focus-sounds-volume">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 6h2.5L8 3v10l-3.5-3H2Zm8.5-.5a3.5 3.5 0 0 1 0 5m2-7a6.5 6.5 0 0 1 0 9" />
          </svg>
          <input
            aria-label="Volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume()}
            onInput={(event) => {
              const next = Number(event.currentTarget.value);
              setVolume(next);
              sound.setVolume(next);
              AmbientSoundPlayer.saveVolume(next);
            }}
          />
        </div>
      </Show>
    </fieldset>
  );
}
