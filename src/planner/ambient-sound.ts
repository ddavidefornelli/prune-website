/**
 * Background sounds for a focus session: short recordings that loop without a
 * gap. A file is fetched only the first time someone picks that sound, so the
 * app itself loads no faster or slower for having them.
 *
 * - Rain: "20180616 - Tropical rain Thailand 02" by LG, CC BY 4.0, a 60-second
 *   stretch, widened a little and set to a steady level. The licence's
 *   credit is published beside the file in public/sounds/CREDITS.txt.
 *   https://freesound.org/people/LG/sounds/462774/
 * - White noise: soft pink noise rendered offline at 48 kHz, each ear with
 *   its own noise so it sounds wide rather than inside your head, with the
 *   harsh top gently rolled off.
 *
 * Each file holds one loop with a second of its own wrap-around on either
 * side, so the loop points stay seamless even if a browser trims the
 * encoder's lead-in differently.
 */
export type AmbientSoundKind = "rain" | "white-noise";

export const AMBIENT_SOUND_PATH = "/sounds/";

const SOUNDS: Record<AmbientSoundKind, { file: string; loopSeconds: number }> =
  {
    rain: { file: "rain.m4a", loopSeconds: 60 },
    "white-noise": { file: "white-noise.m4a", loopSeconds: 30 },
  };
const MARGIN_SECONDS = 1;
const FADE_SECONDS = 0.8;

export type AmbientSound = {
  /**
   * Fades the sound in, replacing whatever was playing. Call it from a click
   * so the browser allows audio. Resolves once it is audible; rejects if the
   * file could not be loaded. A later play or stop cancels it quietly.
   */
  play(kind: AmbientSoundKind): Promise<void>;
  /** Fades out whatever is playing. */
  stop(): void;
  /** 0 to 1. */
  setVolume(volume: number): void;
  /** Stops at once and releases the audio device. */
  dispose(): void;
};

type Playing = { output: GainNode; source: AudioBufferSourceNode };

export function createAmbientSound(): AmbientSound {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let playing: Playing | undefined;
  let request = 0;
  let volume = 0.6;
  const buffers = new Map<AmbientSoundKind, Promise<AudioBuffer>>();

  function audio(): { context: AudioContext; master: GainNode } {
    if (!context || !master) {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = loudness(volume);
      master.connect(context.destination);
    }
    // A browser may start the context suspended until a click resumes it.
    if (context.state === "suspended") void context.resume();
    return { context, master };
  }

  function load(context: AudioContext, kind: AmbientSoundKind) {
    let buffer = buffers.get(kind);
    if (!buffer) {
      buffer = fetch(`${AMBIENT_SOUND_PATH}${SOUNDS[kind].file}`)
        .then((response) => {
          if (!response.ok) throw new Error(`Sound ${response.status}`);
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data));
      // A failed download can be tried again on the next pick.
      buffer.catch(() => buffers.delete(kind));
      buffers.set(kind, buffer);
    }
    return buffer;
  }

  function fadeOut(): void {
    if (!context || !playing) return;
    const now = context.currentTime;
    const { output, source } = playing;
    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(output.gain.value, now);
    output.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    source.stop(now + FADE_SECONDS);
    playing = undefined;
  }

  return {
    async play(kind) {
      const current = ++request;
      const { context, master } = audio();
      fadeOut();
      const buffer = await load(context, kind);
      if (current !== request || context.state === "closed") return;
      const { loopSeconds } = SOUNDS[kind];
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = MARGIN_SECONDS;
      source.loopEnd = MARGIN_SECONDS + loopSeconds;
      const output = context.createGain();
      const now = context.currentTime;
      output.gain.setValueAtTime(0, now);
      output.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
      source.connect(output).connect(master);
      // Start somewhere new each time, so it never sounds like a replay.
      source.start(now, MARGIN_SECONDS + Math.random() * loopSeconds);
      playing = { output, source };
    },
    stop() {
      request++;
      fadeOut();
    },
    setVolume(next) {
      volume = Math.min(1, Math.max(0, next));
      if (context && master)
        master.gain.setTargetAtTime(
          loudness(volume),
          context.currentTime,
          0.05,
        );
    },
    dispose() {
      request++;
      playing = undefined;
      void context?.close();
      context = undefined;
      master = undefined;
      buffers.clear();
    },
  };
}

/** A slider feels even when its position maps to loudness, not amplitude. */
function loudness(volume: number): number {
  return volume * volume;
}
