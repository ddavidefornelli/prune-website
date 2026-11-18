// The owner's daily focus time, as minutes after local midnight.

export const FOCUS_PRESETS: readonly { label: string; minute: number }[] = [
  { label: "Morning", minute: 9 * 60 },
  { label: "Afternoon", minute: 14 * 60 },
  { label: "Evening", minute: 19 * 60 },
];

const pad = (value: number) => String(value).padStart(2, "0");

/** 540 → "09:00". */
export function formatMinute(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** "14:30" (an <input type="time"> value) → 870; anything else → null. */
export function parseMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

const TITLE = "Focus time · prune";

/** The next local date-time (YYYYMMDDTHHMMSS, no zone) at `minute`, from `now`. */
function nextLocal(minute: number, now: Date): string {
  const at = new Date(now);
  at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}T${pad(at.getHours())}${pad(at.getMinutes())}00`;
}

const rule = (weekdaysOnly: boolean) =>
  weekdaysOnly ? "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : "RRULE:FREQ=DAILY";

const plus30 = (local: string) => {
  const date = new Date(
    `${local.slice(0, 4)}-${local.slice(4, 6)}-${local.slice(6, 8)}T${local.slice(9, 11)}:${local.slice(11, 13)}:00`,
  );
  date.setMinutes(date.getMinutes() + 30);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
};

/**
 * Google Calendar "add event" link for a repeating 30-minute focus block.
 * Generic on purpose: no task text in a URL.
 */
export function googleCalendarUrl(
  minute: number,
  weekdaysOnly: boolean,
  siteUrl: string,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const start = nextLocal(minute, now);
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", TITLE);
  url.searchParams.set("dates", `${start}/${plus30(start)}`);
  url.searchParams.set("ctz", timeZone);
  url.searchParams.set("recur", rule(weekdaysOnly));
  url.searchParams.set(
    "details",
    `Open prune and start your timer: ${siteUrl}`,
  );
  return url.toString();
}

/**
 * An .ics file for Apple Calendar and Outlook, made in the browser. Floating
 * local time: the focus time follows you across time zones, like reminders do.
 */
export function calendarFile(
  minute: number,
  weekdaysOnly: boolean,
  siteUrl: string,
  now = new Date(),
): string {
  const start = nextLocal(minute, now);
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//prune//focus time//EN",
    "BEGIN:VEVENT",
    `UID:focus-time-${start}@prune.win`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${plus30(start)}`,
    rule(weekdaysOnly),
    `SUMMARY:${TITLE}`,
    `DESCRIPTION:Open prune and start your timer: ${siteUrl}`,
    `URL:${siteUrl}`,
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${TITLE}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
