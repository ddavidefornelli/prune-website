/** Unit conversions shared by the browser, the server and the scripts. */
export const TIME = {
  msPerSecond: 1000,
  secondsPerMinute: 60,
  minutesPerHour: 60,
  secondsPerHour: 3600,
  hoursPerDay: 24,
  secondsPerDay: 86_400,
  dayMs: 86_400_000,
  minuteMs: 60_000,
} as const;

export const CALENDAR = {
  daysPerWeek: 7,
  /** Sunday first, matching `Date.getUTCDay`. */
  weekdayNames: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
  /** Monday first, like every week shown in the app. */
  weekdayInitials: ["M", "T", "W", "T", "F", "S", "S"],
  monthNames: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
} as const;
