/** Internal stop citations the model may leave in text, e.g. "(stop ids: 3, 7)". */
const STOP_CITATION = /\s*\(stop\s+ids?\s*:\s*\d+(?:\s*,\s*\d+)*\s*\)/gi;

/** How saved check-ins are written on screen. */
export class ReviewFormat {
  /** Noon UTC keeps the calendar date in every zone. */
  private static readonly dates = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  /** "3 Nov 2026". */
  static date(day: string): string {
    return ReviewFormat.dates.format(new Date(`${day}T12:00:00Z`));
  }

  /** "3 Nov 2026 – 9 Nov 2026", or one date when they match. */
  static range(start: string, end: string): string {
    return start === end
      ? ReviewFormat.date(start)
      : `${ReviewFormat.date(start)} – ${ReviewFormat.date(end)}`;
  }

  /** Hides internal citations; structured evidence stays available separately. */
  static text(text: string): string {
    return text.replace(STOP_CITATION, "");
  }
}
