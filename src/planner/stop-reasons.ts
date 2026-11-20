/**
 * One-tap reasons for stopping the timer.
 *
 * Four broad categories, one per kind of distraction, so picking one takes a
 * single tap mid-session. The saved text is just the label ("Social media"),
 * which keeps stops easy to group and count later.
 */
export const STOP_REASONS = [
  { label: "Social media", emoji: "📱" },
  { label: "Environment", emoji: "🔊" },
  { label: "Family", emoji: "👨‍👩‍👧" },
  { label: "Tiredness", emoji: "😴" },
] as const;

export type StopReason = (typeof STOP_REASONS)[number];
