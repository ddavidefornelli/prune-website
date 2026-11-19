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
] as const;

/** Streak lengths that always get their own words. */
const MILESTONES: ReadonlyMap<number, string> = new Map([
  [1, "Day one. Let's go!"],
  [3, "Three in a row!"],
  [7, "A whole week!"],
  [14, "Two weeks strong!"],
  [30, "A month of focus!"],
  [50, "Fifty. Fifty!"],
  [100, "Triple digits!"],
  [365, "A year of prune!"],
]);
/** Past the named milestones, every hundredth day is one too. */
const CENTURY = 100;

/** Ranges for each piece of confetti, drawn uniformly. */
const CONFETTI = {
  pieces: 36,
  milestonePieces: 56,
  up: { min: 0.25, spread: 0.35 },
  turnDegrees: 900,
  maxDelay: 0.5,
  duration: { min: 2.2, spread: 1.4 },
  scale: { min: 0.7, spread: 0.7 },
  hues: 360,
} as const;

/** Chooses each party's dance, headline and confetti. */
export class PartyPlanner {
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  /** Words for the days worth a bigger cheer. */
  static milestoneHeadline(days: number): string | null {
    const named = MILESTONES.get(days);
    if (named) return named;
    if (days > 0 && days % CENTURY === 0) return `${days} days. Legend.`;
    return null;
  }

  /** A milestone throws more confetti. */
  static isMilestone(days: number): boolean {
    return PartyPlanner.milestoneHeadline(days) !== null && days > 1;
  }

  /** `dance` sets the dance instead of drawing one (the dev preview uses it). */
  plan(days: number, dance?: Dance): Party {
    const count = PartyPlanner.isMilestone(days)
      ? CONFETTI.milestonePieces
      : CONFETTI.pieces;
    const confetti = Array.from({ length: count }, () => this.piece());
    return {
      dance: dance ?? this.pick(DANCES),
      headline: PartyPlanner.milestoneHeadline(days) ?? this.pick(CHEERS),
      confetti,
    };
  }

  private piece(): ConfettiPiece {
    const random = this.random;
    return {
      bit: this.pick(BITS),
      x: random() - 0.5,
      up: CONFETTI.up.min + random() * CONFETTI.up.spread,
      turn: (random() - 0.5) * CONFETTI.turnDegrees,
      delay: random() * CONFETTI.maxDelay,
      duration: CONFETTI.duration.min + random() * CONFETTI.duration.spread,
      scale: CONFETTI.scale.min + random() * CONFETTI.scale.spread,
      hue: Math.floor(random() * CONFETTI.hues),
    };
  }

  private pick<T>(list: readonly T[]): T {
    return list[
      Math.min(list.length - 1, Math.floor(this.random() * list.length))
    ];
  }
}
