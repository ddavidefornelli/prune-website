/**
 * The party for keeping the streak alive today: the plum dances with its
 * maracas, confetti flies and a headline cheers. Each one is drawn at random,
 * so no two days feel the same, while milestones always get their own words.
 */

export const DANCES = ["shimmy", "hop", "spin", "wiggle", "conga"] as const;
export type Dance = (typeof DANCES)[number];

export const BITS = ["plum", "leaf", "note", "spark", "dot"] as const;
export type Bit = (typeof BITS)[number];

export interface ConfettiPiece {
  bit: Bit;
  /** Sideways travel, as a fraction of the screen's width (-0.5 to 0.5). */
  x: number;
  /** How high it is thrown, as a fraction of the screen's height. */
  up: number;
  /** Degrees it turns on the way down. */
  turn: number;
  /** Seconds before it is thrown, and seconds in flight. */
  delay: number;
  duration: number;
  /** Size multiplier, around 1. */
  scale: number;
  hue: number;
}

export interface Party {
  dance: Dance;
  headline: string;
  confetti: ConfettiPiece[];
}

const CHEERS = [
  "Shake it, plum!",
  "Prune-tastic!",
  "Juicy streak!",
  "Plum-believable!",
  "Dried and thriving",
  "Shaken, not stopped",
  "Maracas out!",
  "That's the stuff",
  "Keep it rolling",
  "Sweet as a prune",
];

/** Words for the days worth a bigger cheer. */
export function milestoneHeadline(days: number): string | null {
  if (days === 1) return "Day one. Let's go!";
  if (days === 3) return "Three in a row!";
  if (days === 7) return "A whole week!";
  if (days === 14) return "Two weeks strong!";
  if (days === 30) return "A month of focus!";
  if (days === 50) return "Fifty. Fifty!";
  if (days === 100) return "Triple digits!";
  if (days === 365) return "A year of prune!";
  if (days > 0 && days % 100 === 0) return `${days} days. Legend.`;
  return null;
}

/** A milestone throws more confetti. */
export const isMilestone = (days: number): boolean =>
  milestoneHeadline(days) !== null && days > 1;

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))];

export function pickParty(
  days: number,
  random: () => number = Math.random,
  /** A set dance instead of a random one (the dev preview uses it). */
  dance?: Dance,
): Party {
  const count = isMilestone(days) ? 56 : 36;
  const confetti: ConfettiPiece[] = Array.from({ length: count }, () => ({
    bit: pick(BITS, random),
    x: random() - 0.5,
    up: 0.25 + random() * 0.35,
    turn: (random() - 0.5) * 900,
    delay: random() * 0.5,
    duration: 2.2 + random() * 1.4,
    scale: 0.7 + random() * 0.7,
    hue: Math.floor(random() * 360),
  }));
  return {
    dance: dance ?? pick(DANCES, random),
    headline: milestoneHeadline(days) ?? pick(CHEERS, random),
    confetti,
  };
}
