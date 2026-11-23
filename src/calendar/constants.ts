/** The calendar above the list. */
export const CALENDAR = {
  days: 7,
  dayMs: 24 * 60 * 60 * 1000,
  hourMs: 60 * 60 * 1000,
  /** A planned task fills its hour. */
  taskMinutes: 60,
  /** Laptops see the whole week; phones one day under the week strip. */
  wideQuery: "(min-width: 640px)",
  /** Where the hours open when the week is not this one. */
  firstHour: 8,
  /** Mouse: a press becomes a drag once it moves this far (px). */
  dragDistance: 6,
  /** Touch: hold this long to pick a task up, without moving more than `touchSlop`. */
  holdMs: 280,
  touchSlop: 10,
  /** Hovering a day in the strip while dragging opens that day (phones). */
  dayHoverMs: 350,
  /** How close to the hours' top or bottom edge scrolls them, and how fast (px a frame). */
  edgePx: 36,
  edgeSpeed: 9,
  /** Other spaces' plans are read again this long after the list changes… */
  reloadAfterChangeMs: 1500,
  /** …and this often while the page is in sight. */
  reloadMs: 2 * 60 * 1000,
  /** The dragged task keeps this far from the screen's sides (px). */
  ghostMargin: 8,
  /** After a drop, the calendar stays open this long so the task is seen landing. */
  landedMs: 700,
} as const;
