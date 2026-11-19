import { SITE } from "../shared/site.ts";
import { TIME } from "../shared/time-constants.ts";

const pad = (value: number) => String(value).padStart(2, "0");

const MINUTES_PER_DAY = TIME.hoursPerDay * TIME.minutesPerHour;

/** Long enough for the browser to start the download. */
const OBJECT_URL_LIFETIME_MS = 1000;

/** An `<input type="time">` value. */
const TIME_INPUT = /^(\d{2}):(\d{2})$/;

const CALENDAR_ENTRY = {
  title: "Focus time · prune",
  fileName: "prune-focus-time.ics",
  mimeType: "text/calendar",
  minutes: 30,
  googleUrl: "https://calendar.google.com/calendar/render",
  productId: "-//prune//focus time//EN",
  daily: "RRULE:FREQ=DAILY",
  weekdays: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
} as const;

/** The owner's daily focus time, as minutes after local midnight. */
export class FocusTime {
  readonly minute: number;

  constructor(minute: number) {
    this.minute = minute;
  }

  static readonly PRESETS: readonly {
    id: string;
    label: string;
    time: FocusTime;
  }[] = [
    { id: "morning", label: "Morning", time: FocusTime.at(9) },
    { id: "afternoon", label: "Afternoon", time: FocusTime.at(14) },
    { id: "evening", label: "Evening", time: FocusTime.at(19) },
  ];

  /** Prefilled when the owner picks "Other" without a time yet. */
  static readonly SUGGESTED_OTHER = FocusTime.at(8, 30);

  /** Every quarter hour from 05:00 to 23:00, for a picker. */
  static readonly CHOICES: readonly FocusTime[] = FocusTime.every(
    FocusTime.at(5),
    FocusTime.at(23),
    15,
  );

  private static every(
    first: FocusTime,
    last: FocusTime,
    stepMinutes: number,
  ): FocusTime[] {
    return Array.from(
      { length: (last.minute - first.minute) / stepMinutes + 1 },
      (_, index) => new FocusTime(first.minute + index * stepMinutes),
    );
  }

  static at(hours: number, minutes = 0): FocusTime {
    return new FocusTime(hours * TIME.minutesPerHour + minutes);
  }

  /** "14:30" → 870 minutes; anything else → null. */
  static parse(value: string): FocusTime | null {
    const match = TIME_INPUT.exec(value);
    if (!match) return null;
    const [hours, minutes] = [Number(match[1]), Number(match[2])];
    return hours < TIME.hoursPerDay && minutes < TIME.minutesPerHour
      ? FocusTime.at(hours, minutes)
      : null;
  }

  /** The time of day of `date`, to the minute. */
  static of(date: Date): FocusTime {
    return FocusTime.at(date.getHours(), date.getMinutes());
  }

  /** The minute before, wrapping past midnight. */
  minuteBefore(): FocusTime {
    return new FocusTime((this.minute + MINUTES_PER_DAY - 1) % MINUTES_PER_DAY);
  }

  /** "9:00", as a lock screen shows it. */
  clockFace(): string {
    return `${Math.floor(this.minute / TIME.minutesPerHour)}:${pad(this.minute % TIME.minutesPerHour)}`;
  }

  /** "09:00". */
  label(): string {
    return `${pad(Math.floor(this.minute / TIME.minutesPerHour))}:${pad(this.minute % TIME.minutesPerHour)}`;
  }

  /**
   * Google Calendar "add event" link for a repeating focus block. Generic on
   * purpose: no task text in a URL.
   */
  googleCalendarUrl(
    weekdaysOnly: boolean,
    siteUrl: string,
    now = new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ): string {
    const start = this.nextStart(now);
    const url = new URL(CALENDAR_ENTRY.googleUrl);
    url.searchParams.set("action", "TEMPLATE");
    url.searchParams.set("text", CALENDAR_ENTRY.title);
    url.searchParams.set(
      "dates",
      `${FocusTime.stamp(start)}/${FocusTime.stamp(FocusTime.end(start))}`,
    );
    url.searchParams.set("ctz", timeZone);
    url.searchParams.set("recur", FocusTime.rule(weekdaysOnly));
    url.searchParams.set("details", FocusTime.details(siteUrl));
    return url.toString();
  }

  /**
   * An .ics file for Apple Calendar and Outlook, made in the browser. Floating
   * local time: the focus time follows you across time zones, like reminders do.
   */
  calendarFile(
    weekdaysOnly: boolean,
    siteUrl: string,
    now = new Date(),
  ): string {
    const start = FocusTime.stamp(this.nextStart(now));
    const end = FocusTime.stamp(FocusTime.end(this.nextStart(now)));
    const created = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${CALENDAR_ENTRY.productId}`,
      "BEGIN:VEVENT",
      `UID:focus-time-${start}@${SITE.domain}`,
      `DTSTAMP:${created}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      FocusTime.rule(weekdaysOnly),
      `SUMMARY:${CALENDAR_ENTRY.title}`,
      `DESCRIPTION:${FocusTime.details(siteUrl)}`,
      `URL:${siteUrl}`,
      "BEGIN:VALARM",
      "TRIGGER:PT0M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${CALENDAR_ENTRY.title}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  }

  /** Offers the .ics file as a download, made entirely in the browser. */
  downloadCalendarFile(weekdaysOnly: boolean, siteUrl: string): void {
    const blob = new Blob([this.calendarFile(weekdaysOnly, siteUrl)], {
      type: CALENDAR_ENTRY.mimeType,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = CALENDAR_ENTRY.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  }

  /** The next local date-time at this focus time, from `now`. */
  private nextStart(now: Date): Date {
    const at = new Date(now);
    at.setHours(
      Math.floor(this.minute / TIME.minutesPerHour),
      this.minute % TIME.minutesPerHour,
      0,
      0,
    );
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }

  private static end(start: Date): Date {
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + CALENDAR_ENTRY.minutes);
    return end;
  }

  /** YYYYMMDDTHHMMSS in local time, with no zone. */
  private static stamp(at: Date): string {
    return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}T${pad(at.getHours())}${pad(at.getMinutes())}00`;
  }

  private static rule(weekdaysOnly: boolean): string {
    return weekdaysOnly ? CALENDAR_ENTRY.weekdays : CALENDAR_ENTRY.daily;
  }

  private static details(siteUrl: string): string {
    return `Open prune and start your timer: ${siteUrl}`;
  }
}
