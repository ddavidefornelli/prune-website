import { TIME } from "./time-constants.ts";

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** A span of time in whole seconds, with the ways the app writes it. */
export class Duration {
  readonly seconds: number;

  constructor(seconds: number) {
    this.seconds = seconds;
  }

  static ofMinutes(minutes: number): Duration {
    return new Duration(minutes * TIME.secondsPerMinute);
  }

  /** Whole and fractional minutes. */
  get minutes(): number {
    return this.seconds / TIME.secondsPerMinute;
  }

  private get parts(): { hours: number; minutes: number; seconds: number } {
    return {
      hours: Math.floor(this.seconds / TIME.secondsPerHour),
      minutes:
        Math.floor(this.seconds / TIME.secondsPerMinute) % TIME.minutesPerHour,
      seconds: this.seconds % TIME.secondsPerMinute,
    };
  }

  /** "01:05:09", the timer's face. */
  clock(): string {
    const { hours, minutes, seconds } = this.parts;
    return [hours, minutes, seconds].map(twoDigits).join(":");
  }

  /** "45:00": minutes and seconds, for a countdown under an hour. */
  minuteClock(): string {
    const minutes = Math.floor(this.seconds / TIME.secondsPerMinute);
    return [minutes, this.seconds % TIME.secondsPerMinute]
      .map(twoDigits)
      .join(":");
  }

  /** "1h 5m 9s". Keeps seconds so a short task never reads as zero. */
  precise(): string {
    const { hours, minutes, seconds } = this.parts;
    return [
      hours ? `${hours}h` : "",
      minutes ? `${minutes}m` : "",
      seconds || this.seconds === 0 ? `${seconds}s` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** "1h 5m" or "5m", in whole minutes: profile totals. */
  short(): string {
    const total = Math.floor(this.seconds / TIME.secondsPerMinute);
    return total >= TIME.minutesPerHour
      ? `${Math.floor(total / TIME.minutesPerHour)}h ${total % TIME.minutesPerHour}m`
      : `${total}m`;
  }

  /** "1 h 5 min", rounded to the minute: day loads and estimates. */
  rounded(): string {
    const total = Math.round(this.seconds / TIME.secondsPerMinute);
    const hours = Math.floor(total / TIME.minutesPerHour);
    const minutes = total % TIME.minutesPerHour;
    if (!hours) return `${total} min`;
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }

  /** The local wall-clock time of an instant in epoch seconds, e.g. "4:30 PM". */
  static timeOfDay(epochSeconds: number): string {
    return new Date(epochSeconds * TIME.msPerSecond).toLocaleTimeString(
      undefined,
      { hour: "numeric", minute: "2-digit" },
    );
  }
}
