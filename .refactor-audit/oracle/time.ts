export const DAY_MS = 86_400_000;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Keep timezone-aware day formatting out of the queue's repeated Intl construction path. */
export function localDay(at: number, timezone: string): string {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(at * 1000);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
}

/** Date-key arithmetic is independent of daylight-saving changes. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function formatDuration(seconds: number): string {
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
}
