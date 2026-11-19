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
import { STORAGE_KEYS } from "../shared/storage-keys.ts";

export type AmbientSoundKind = "rain" | "white-noise";

const SOUND_PATH = "/sounds/";
const SOUNDS: Readonly<
  Record<AmbientSoundKind, { file: string; loopSeconds: number }>
> = {
  rain: { file: "rain.m4a", loopSeconds: 60 },
  "white-noise": { file: "white-noise.m4a", loopSeconds: 30 },
};
const AUDIO = {
  marginSeconds: 1,
  fadeSeconds: 0.8,
  defaultVolume: 0.6,
  /** Time constant of a volume change, in seconds. */
  volumeSmoothing: 0.05,
} as const;

interface Playing {
  output: GainNode;
  source: AudioBufferSourceNode;
}

/** Plays one ambient loop at a time through the Web Audio API. */
export class AmbientSoundPlayer {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private playing: Playing | undefined;
  private request = 0;
  private volume: number = AUDIO.defaultVolume;
  private readonly buffers = new Map<AmbientSoundKind, Promise<AudioBuffer>>();

  /** The volume this device used last, from 0 to 1. */
  static savedVolume(): number {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.focusSoundVolume);
      const value = Number(stored);
      return stored !== null && value >= 0 && value <= 1
        ? value
        : AUDIO.defaultVolume;
    } catch {
      return AUDIO.defaultVolume;
    }
  }

  /** Remembering the volume is a convenience; it can be lost. */
  static saveVolume(volume: number): void {
    try {
      localStorage.setItem(STORAGE_KEYS.focusSoundVolume, String(volume));
    } catch {
      /* Not remembered on this device. */
    }
  }

  /** A slider feels even when its position maps to loudness, not amplitude. */
  private static loudness(volume: number): number {
    return volume * volume;
  }

  /**
   * Fades the sound in, replacing whatever was playing. Call it from a click
   * so the browser allows audio. Resolves once it is audible; rejects if the
   * file could not be loaded. A later play or stop cancels it quietly.
   */
  async play(kind: AmbientSoundKind): Promise<void> {
    const current = ++this.request;
    const { context, master } = this.audio();
    this.fadeOut();
    const buffer = await this.load(context, kind);
    if (current !== this.request || context.state === "closed") return;
    const { loopSeconds } = SOUNDS[kind];
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = AUDIO.marginSeconds;
    source.loopEnd = AUDIO.marginSeconds + loopSeconds;
    const output = context.createGain();
    const now = context.currentTime;
    output.gain.setValueAtTime(0, now);
    output.gain.linearRampToValueAtTime(1, now + AUDIO.fadeSeconds);
    source.connect(output).connect(master);
    // Start somewhere new each time, so it never sounds like a replay.
    source.start(now, AUDIO.marginSeconds + Math.random() * loopSeconds);
    this.playing = { output, source };
  }

  /** Fades out whatever is playing. */
  stop(): void {
    this.request++;
    this.fadeOut();
  }

  /** 0 to 1. */
  setVolume(next: number): void {
    this.volume = Math.min(1, Math.max(0, next));
    if (this.context && this.master)
      this.master.gain.setTargetAtTime(
        AmbientSoundPlayer.loudness(this.volume),
        this.context.currentTime,
        AUDIO.volumeSmoothing,
      );
  }

  /** Stops at once and releases the audio device. */
  dispose(): void {
    this.request++;
    this.playing = undefined;
    void this.context?.close();
    this.context = undefined;
    this.master = undefined;
    this.buffers.clear();
  }

  private audio(): { context: AudioContext; master: GainNode } {
    if (!this.context || !this.master) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = AmbientSoundPlayer.loudness(this.volume);
      this.master.connect(this.context.destination);
    }
    // A browser may start the context suspended until a click resumes it.
    if (this.context.state === "suspended") void this.context.resume();
    return { context: this.context, master: this.master };
  }

  private load(
    context: AudioContext,
    kind: AmbientSoundKind,
  ): Promise<AudioBuffer> {
    let buffer = this.buffers.get(kind);
    if (!buffer) {
      buffer = fetch(`${SOUND_PATH}${SOUNDS[kind].file}`)
        .then((response) => {
          if (!response.ok) throw new Error(`Sound ${response.status}`);
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data));
      // A failed download can be tried again on the next pick.
      buffer.catch(() => this.buffers.delete(kind));
      this.buffers.set(kind, buffer);
    }
    return buffer;
  }

  private fadeOut(): void {
    if (!this.context || !this.playing) return;
    const now = this.context.currentTime;
    const { output, source } = this.playing;
    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(output.gain.value, now);
    output.gain.linearRampToValueAtTime(0, now + AUDIO.fadeSeconds);
    source.stop(now + AUDIO.fadeSeconds);
    this.playing = undefined;
  }
}
