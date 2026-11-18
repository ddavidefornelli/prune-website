import {
  For,
  Match,
  Switch,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import type { Streak } from "../streak";
import {
  type ConfettiPiece,
  type Dance,
  isMilestone,
  pickParty,
} from "../streak-party";
import { FLAME } from "./StreakCounter";

const STAY_MS = 7000;
const FLIP_MS = 900;
/** When the horns come in on PARTY_SOUND: the trumpet plums jump out then. */
const BRASS_MS = 3500;

/**
 * The moment today's streak is kept: the plum strums its guitar, confetti
 * flies and the count ticks up; when the horns come in, two trumpet plums
 * jump out from behind it. Different every day; tap anywhere, press
 * Escape or wait a few seconds to carry on.
 */
export function StreakParty(props: {
  streak: Streak;
  onClose: () => void;
  dance?: Dance;
  /** Another sound file to play (the dev preview auditions them). */
  sound?: string;
}) {
  // Drawn once per party: the dance and the confetti never reshuffle.
  const days = untrack(() => props.streak.days);
  const party = pickParty(
    days,
    Math.random,
    untrack(() => props.dance),
  );
  const [count, setCount] = createSignal(Math.max(0, days - 1));
  const [brass, setBrass] = createSignal(false);
  const reduced = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  onMount(() => {
    const opened = performance.now();
    const flip = setTimeout(() => setCount(days), reduced ? 0 : FLIP_MS);
    const leave = setTimeout(() => props.onClose(), STAY_MS);
    // The band comes in with the horns, timed from when the sound really
    // starts (it has to load first); without sound, on the same beat.
    let cue: ReturnType<typeof setTimeout> | undefined;
    const brassIn = (ms: number) => {
      clearTimeout(cue);
      cue = setTimeout(() => setBrass(true), Math.max(0, ms));
    };
    let stopSound: (() => void) | undefined;
    if (reduced) setBrass(true);
    else
      stopSound = playPrize(untrack(() => props.sound) ?? PARTY_SOUND, {
        onStart: (latencyMs) => brassIn(BRASS_MS + latencyMs),
        onFail: () => brassIn(BRASS_MS - (performance.now() - opened)),
      });
    onCleanup(() => {
      clearTimeout(flip);
      clearTimeout(leave);
      clearTimeout(cue);
      stopSound?.();
    });
  });

  return (
    <Dialog
      class="streak-party"
      classList={{ "is-milestone": isMilestone(days), "is-brass": brass() }}
      data-dance={party.dance}
      aria-labelledby="streak-party-title"
      onDismiss={() => props.onClose()}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLButtonElement>(".party-go")?.focus()
      }
      onClick={() => props.onClose()}
    >
      <div class="party-confetti" aria-hidden="true">
        <For each={reduced ? [] : party.confetti}>
          {(piece) => <Confetti piece={piece} />}
        </For>
      </div>
      <div class="party-body">
        <div class="party-stage" aria-hidden="true">
          <TrumpetBand />
          <div class="party-pop">
            <div class="party-dancer">
              <DancingPlum />
            </div>
          </div>
          <span class="party-shadow" />
        </div>
        <p class="party-count">
          <span class="party-flame" aria-hidden="true">
            <svg viewBox="0 0 24 30">
              <path d={FLAME} fill="#ff7a1a" />
            </svg>
          </span>
          {/* Keyed on the number so each change replays the flip. */}
          <For each={[count()]}>{(n) => <strong>{n}</strong>}</For>
        </p>
        <p class="party-unit">day streak</p>
        <h2 id="streak-party-title">{party.headline}</h2>
        <ol class="party-week" aria-hidden="true">
          <For each={props.streak.week}>
            {(day) => (
              <li data-state={day.state}>
                <span class="party-ember">
                  <svg viewBox="0 0 24 30">
                    <path d={FLAME} />
                  </svg>
                </span>
                <span>{day.label}</span>
              </li>
            )}
          </For>
        </ol>
        <button type="button" class="party-go">
          Keep going
        </button>
      </div>
    </Dialog>
  );
}

function Confetti(props: { piece: ConfettiPiece }) {
  const p = untrack(() => props.piece);
  return (
    <span
      class="party-bit"
      data-bit={p.bit}
      style={{
        "--x": p.x,
        "--up": p.up,
        "--turn": `${p.turn}deg`,
        "--delay": `${p.delay}s`,
        "--dur": `${p.duration}s`,
        "--s": p.scale,
        "--hue": p.hue,
      }}
    >
      <Switch fallback={<i />}>
        <Match when={p.bit === "plum"}>
          <svg viewBox="0 0 20 22">
            <circle cx="10" cy="13" r="8" fill="#7d74ec" />
            <path d="M10 5C11 2 14 1 17 2C15 5 12 6 10 5Z" fill="#34c759" />
          </svg>
        </Match>
        <Match when={p.bit === "leaf"}>
          <svg viewBox="0 0 20 12">
            <path d="M1 10C5 1 14 0 19 2C15 9 7 12 1 10Z" fill="#34c759" />
          </svg>
        </Match>
        <Match when={p.bit === "note"}>
          <b>{p.hue % 2 ? "♪" : "♫"}</b>
        </Match>
        <Match when={p.bit === "spark"}>
          <b>✦</b>
        </Match>
      </Switch>
    </span>
  );
}

/** The plum's body, the logo's shape, with its bottom centre at 256,446. */
const PLUM_BODY =
  "M256 168C330 128 424 186 420 290C416 384 344 446 256 446C168 446 96 384 92 290C88 186 182 128 256 168Z";

/** The plum from the logo, off its tile, with feet, arms and a guitar. */
function DancingPlum() {
  return (
    <svg class="party-plum" viewBox="-110 40 732 440">
      {/* Feet, behind the body. */}
      <ellipse
        class="plum-foot plum-foot-left"
        cx="196"
        cy="448"
        rx="40"
        ry="18"
        fill="#3d2f63"
      />
      <ellipse
        class="plum-foot plum-foot-right"
        cx="316"
        cy="448"
        rx="40"
        ry="18"
        fill="#3d2f63"
      />
      <path d={PLUM_BODY} fill="#7d74ec" />
      <path
        d="M150 238C162 206 186 186 214 180"
        fill="none"
        stroke="#fff"
        stroke-width="16"
        stroke-linecap="round"
        opacity="0.35"
      />
      <PlumLeaf />
      <ellipse cx="166" cy="320" rx="28" ry="16" fill="#ff9fc0" opacity="0.9" />
      <ellipse cx="346" cy="320" rx="28" ry="16" fill="#ff9fc0" opacity="0.9" />
      <g class="plum-eyes">
        <circle cx="206" cy="278" r="20" fill="#1b1640" />
        <circle cx="306" cy="278" r="20" fill="#1b1640" />
        <circle cx="213" cy="270" r="7" fill="#fff" />
        <circle cx="313" cy="270" r="7" fill="#fff" />
      </g>
      {/* A wide open grin: it's singing along. */}
      <g class="plum-mouth">
        <path d="M222 314Q256 368 290 314Z" fill="#1b1640" />
        <path d="M238 338Q256 356 274 338Q256 330 238 338Z" fill="#ff7aa8" />
      </g>
      {/* The guitar, slung low across the body, neck up to the left. */}
      <g transform="translate(300 408) rotate(22) scale(0.82)">
        <Guitar />
      </g>
      {/* One hand on the neck, the other strumming over the sound hole. */}
      <path
        d="M104 318Q66 372 150 386"
        fill="none"
        stroke="#5b52d6"
        stroke-width="20"
        stroke-linecap="round"
      />
      <circle cx="154" cy="386" r="19" fill="#7d74ec" />
      <path
        d="M410 322Q452 384 360 420"
        fill="none"
        stroke="#5b52d6"
        stroke-width="20"
        stroke-linecap="round"
      />
      <circle class="plum-strum" cx="356" cy="420" r="19" fill="#7d74ec" />
    </svg>
  );
}

function PlumLeaf() {
  return (
    <g class="plum-leaf">
      <path
        d="M256 170C254 138 262 112 280 94"
        fill="none"
        stroke="#3d2f63"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        d="M268 122C300 74 370 64 410 86C386 138 320 160 268 122Z"
        fill="#34c759"
      />
      <path
        d="M284 117C322 104 358 96 392 90"
        fill="none"
        stroke="#1f9d45"
        stroke-width="7"
        stroke-linecap="round"
      />
    </g>
  );
}

/** An acoustic guitar lying along x, its body at the origin, neck to -x. */
function Guitar() {
  return (
    <>
      <rect x="-300" y="-19" width="58" height="38" rx="9" fill="#5e3a1a" />
      <circle cx="-286" cy="-25" r="7" fill="#ffd23f" />
      <circle cx="-262" cy="-25" r="7" fill="#ffd23f" />
      <circle cx="-286" cy="25" r="7" fill="#ffd23f" />
      <circle cx="-262" cy="25" r="7" fill="#ffd23f" />
      <rect x="-250" y="-12" width="200" height="24" fill="#8a5a2b" />
      <path
        d="M-220 -12V12M-190 -12V12M-162 -12V12M-136 -12V12M-112 -12V12"
        stroke="#d9b48a"
        stroke-width="3"
      />
      {/* The body: dark rims, then the top, so the bouts read as one shape. */}
      <circle cx="-34" cy="0" r="54" fill="#b8641c" />
      <circle cx="42" cy="0" r="68" fill="#b8641c" />
      <circle cx="-34" cy="0" r="47" fill="#ffad42" />
      <circle cx="42" cy="0" r="61" fill="#ffad42" />
      <circle cx="-4" cy="0" r="21" fill="#4a2a12" />
      <circle
        cx="-4"
        cy="0"
        r="27"
        fill="none"
        stroke="#ff5c8a"
        stroke-width="5"
      />
      <rect x="58" y="-20" width="14" height="40" rx="4" fill="#7a4a22" />
      <path
        d="M65 -7H-270M65 0H-270M65 7H-270"
        stroke="#fff"
        stroke-width="2"
        opacity="0.75"
      />
      <ellipse cx="30" cy="-34" rx="20" ry="9" fill="#fff" opacity="0.3" />
    </>
  );
}

/**
 * Two plums with trumpets, hidden behind the guitarist until the horns come
 * in (the dialog gets `is-brass`), then out to either side, either side.
 */
function TrumpetBand() {
  return (
    <svg class="party-band" viewBox="-110 40 732 440">
      <defs>
        <linearGradient id="party-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe58f" />
          <stop offset="0.45" stop-color="#f7bd2e" />
          <stop offset="1" stop-color="#c98a10" />
        </linearGradient>
      </defs>
      <g class="trumpeter trumpeter-left">
        <g transform="translate(14 452) scale(0.72)">
          <TrumpetPlum />
        </g>
      </g>
      <g class="trumpeter trumpeter-right">
        <g transform="translate(498 452) scale(-0.72 0.72)">
          <TrumpetPlum />
        </g>
      </g>
    </svg>
  );
}

/** A plum blowing a trumpet up and out to the left, bottom centre at 0,0. */
function TrumpetPlum() {
  return (
    <g class="trumpeter-bob">
      <ellipse cx="-60" cy="2" rx="40" ry="18" fill="#3d2f63" />
      <ellipse cx="60" cy="2" rx="40" ry="18" fill="#3d2f63" />
      <g transform="translate(-256 -446)">
        <path d={PLUM_BODY} fill="#8f84f2" />
        <path
          d="M150 238C162 206 186 186 214 180"
          fill="none"
          stroke="#fff"
          stroke-width="16"
          stroke-linecap="round"
          opacity="0.35"
        />
        <PlumLeaf />
      </g>
      {/* The face turned out toward its trumpet, clear of the guitarist. */}
      <g transform="translate(-34 0)">
        {/* Eyes squeezed shut, cheeks puffed, lips pursed: blowing hard. */}
        <path
          d="M-74 -170Q-54 -190 -34 -170M30 -170Q50 -190 70 -170"
          fill="none"
          stroke="#1b1640"
          stroke-width="12"
          stroke-linecap="round"
        />
        <circle
          class="trumpeter-cheek"
          cx="-62"
          cy="-112"
          r="32"
          fill="#ff9fc0"
        />
        <circle cx="66" cy="-118" r="24" fill="#ff9fc0" opacity="0.85" />
        <circle cx="-26" cy="-102" r="13" fill="#1b1640" />
        <circle cx="-26" cy="-102" r="6" fill="#ff7aa8" />
        {/* The trumpet at the lips, raised up and out. */}
        <g transform="translate(-30 -100) rotate(28)">
          <g class="trumpet">
            <Trumpet />
          </g>
        </g>
        {/* Both hands on it: one under the valves, one on the lead pipe. */}
        <path
          d="M-150 -60Q-176 -104 -128 -124"
          fill="none"
          stroke="#6a60e0"
          stroke-width="22"
          stroke-linecap="round"
        />
        <circle cx="-124" cy="-126" r="20" fill="#8f84f2" />
        <path
          d="M120 -70Q40 -40 -72 -96"
          fill="none"
          stroke="#6a60e0"
          stroke-width="22"
          stroke-linecap="round"
        />
        <circle cx="-76" cy="-98" r="20" fill="#8f84f2" />
      </g>
    </g>
  );
}

/** A trumpet with its mouthpiece at the origin and its bell out at -x. */
function Trumpet() {
  return (
    <>
      {/* The tubing: a loop back by the mouthpiece and one by the bell. */}
      <path
        d="M-36 0C-8 0 -8 30 -36 30H-142C-166 30 -166 0 -142 0"
        fill="none"
        stroke="#c98a10"
        stroke-width="13"
      />
      <path
        d="M-36 0C-8 0 -8 30 -36 30H-142C-166 30 -166 0 -142 0"
        fill="none"
        stroke="#f7bd2e"
        stroke-width="8"
      />
      <path d="M0 0H-156" stroke="#c98a10" stroke-width="13" />
      <path d="M0 0H-156" stroke="#f7bd2e" stroke-width="8" />
      <path d="M-4 -2H-150" stroke="#fff3c4" stroke-width="2.5" />
      {/* Three valves with their buttons. */}
      <g fill="url(#party-brass)" stroke="#a8730c" stroke-width="2">
        <rect x="-122" y="-16" width="18" height="56" rx="5" />
        <rect x="-98" y="-16" width="18" height="56" rx="5" />
        <rect x="-74" y="-16" width="18" height="56" rx="5" />
      </g>
      <path
        d="M-113 -16V-30M-89 -16V-30M-65 -16V-30"
        stroke="#c98a10"
        stroke-width="5"
      />
      <g fill="#fff3c4" stroke="#c98a10" stroke-width="2">
        <ellipse cx="-113" cy="-32" rx="9" ry="5" />
        <ellipse cx="-89" cy="-32" rx="9" ry="5" />
        <ellipse cx="-65" cy="-32" rx="9" ry="5" />
      </g>
      {/* The flared bell, its rim and the dark inside. */}
      <path
        d="M-150 -7C-192 -9 -222 -26 -240 -56L-240 56C-222 26 -192 9 -150 7Z"
        fill="url(#party-brass)"
        stroke="#a8730c"
        stroke-width="2"
      />
      <ellipse
        cx="-240"
        cy="0"
        rx="12"
        ry="56"
        fill="#ffe58f"
        stroke="#a8730c"
        stroke-width="2"
      />
      <ellipse cx="-238" cy="0" rx="6" ry="42" fill="#b87a08" />
      <path
        d="M-160 -10C-196 -14 -222 -30 -234 -48"
        fill="none"
        stroke="#fff3c4"
        stroke-width="4"
        stroke-linecap="round"
        opacity="0.8"
      />
      {/* Mouthpiece. */}
      <path
        d="M0 -5H12L18 -10V10L12 5H0Z"
        fill="#e0a317"
        stroke="#a8730c"
        stroke-width="2"
      />
    </>
  );
}

/** The prize sound: "Con Carne (7 sec edit)" from Pixabay (see CREDITS.txt). */
export const PARTY_SOUND = "/sounds/streak-party.m4a";

/**
 * Plays the prize sound once. Fetched when the party opens, which follows a
 * click, so browsers allow it; silently skipped if audio or the file is
 * unavailable. Returns a stop for when the party closes early.
 */
function playPrize(
  url: string,
  cues: {
    /** The sound just started; it reaches the ear after `latencyMs`. */
    onStart: (latencyMs: number) => void;
    /** No sound this time. */
    onFail: () => void;
  },
): () => void {
  let audio: AudioContext | undefined;
  let stopped = false;
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Context) {
      const context = new Context();
      audio = context;
      void context.resume().catch(() => undefined);
      void fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`Sound ${response.status}`);
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => {
          if (stopped) return;
          const source = context.createBufferSource();
          source.buffer = buffer;
          const gain = context.createGain();
          gain.gain.value = 0.8;
          source.connect(gain).connect(context.destination);
          source.onended = () => void context.close().catch(() => undefined);
          source.start();
          const latency = context.outputLatency || context.baseLatency || 0;
          cues.onStart(latency * 1000);
        })
        .catch(() => {
          if (!stopped) cues.onFail();
          void context.close().catch(() => undefined);
        });
    } else cues.onFail();
  } catch {
    // No sound, still a party.
    cues.onFail();
  }
  return () => {
    stopped = true;
    void audio?.close().catch(() => undefined);
  };
}
