const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const reviewDate = (day: string): string =>
  dateFormatter.format(new Date(`${day}T12:00:00Z`));
export const reviewRange = (start: string, end: string): string =>
  start === end
    ? reviewDate(start)
    : `${reviewDate(start)} – ${reviewDate(end)}`;

/** Hide internal citations; structured evidence stays available separately. */
export const reviewText = (text: string): string =>
  text.replace(/\s*\(stop\s+ids?\s*:\s*\d+(?:\s*,\s*\d+)*\s*\)/gi, "");
