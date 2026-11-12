// The artwork is a 160x80 field of cells. Each frame is computed into a buffer
// of exactly that size (one pixel per cell) and scaled up by the compositor,
// so a full-field animation costs 12,800 table lookups and a 51 KB upload.
export const PIXEL_COLUMNS = 160;
export const PIXEL_ROWS = 80;
export const PIXEL_COUNT = PIXEL_COLUMNS * PIXEL_ROWS;
// Ambient light drifts very slowly, so 10 updates/second is already smooth.
export const PIXEL_FRAME_INTERVAL = 100;
// A completed task sends one wave of light out from the heart of the artwork.
export const PIXEL_WAVE_DURATION = 1400;
export const PIXEL_WAVE_JITTER = 180;
export const PIXEL_RISE_DURATION = 600;
export const PIXEL_FLASH_DURATION = 1000;
export const PIXEL_REVEAL_DURATION =
  PIXEL_WAVE_DURATION + PIXEL_WAVE_JITTER + PIXEL_FLASH_DURATION;
export const PIXEL_SPARK_DURATION = 1600;

export interface PixelField {
  /** Completion level (1-3) at which the cell lights up. */
  tier: Uint8Array;
  /** Per-cell brightness, so neighbours never look identical. */
  intensity: Float32Array;
  /** Distance from the centre of the artwork, 0 (heart) to 1 (corners). */
  radius: Float32Array;
  /** Milliseconds after a completion at which the wave reaches the cell. */
  arrival: Float32Array;
  /** Twinkle cycle in milliseconds; 0 for the cells that never twinkle. */
  sparkPeriod: Float32Array;
  sparkPhase: Float32Array;
}

export interface PixelFrame {
  /** Completed tasks today, 0-3. */
  level: number;
  /** Clock for the ambient light, in milliseconds. */
  time: number;
  /** Milliseconds since each tier was revealed (index = tier). */
  elapsed: ArrayLike<number>;
  /** Milliseconds since the latest completion. */
  pulse: number;
  reducedMotion: boolean;
}

const clusters = [
  { x: 0.34, y: 0.35, radius: 0.15 },
  { x: 0.57, y: 0.61, radius: 0.19 },
  { x: 0.69, y: 0.3, radius: 0.12 },
  { x: 0.42, y: 0.76, radius: 0.13 },
];

function noise(x: number, y: number): number {
  let value = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

// Artwork coordinates with square cells: u spans -1..1, w spans -0.5..0.5.
const columnU = Float32Array.from(
  { length: PIXEL_COLUMNS },
  (_, column) => (column + 0.5) / (PIXEL_COLUMNS / 2) - 1,
);
const rowW = Float32Array.from(
  { length: PIXEL_ROWS },
  (_, row) => (row + 0.5) / (PIXEL_COLUMNS / 2) - 0.5,
);
const MAX_RADIUS = Math.hypot(1, 0.5);

export function createPixelField(): PixelField {
  const field: PixelField = {
    tier: new Uint8Array(PIXEL_COUNT),
    intensity: new Float32Array(PIXEL_COUNT),
    radius: new Float32Array(PIXEL_COUNT),
    arrival: new Float32Array(PIXEL_COUNT),
    sparkPeriod: new Float32Array(PIXEL_COUNT),
    sparkPhase: new Float32Array(PIXEL_COUNT),
  };
  for (let index = 0; index < PIXEL_COUNT; index++) {
    const x = index % PIXEL_COLUMNS;
    const y = Math.floor(index / PIXEL_COLUMNS);
    let strength = 0;
    for (const cluster of clusters) {
      const distance = Math.hypot(
        (x / PIXEL_COLUMNS - cluster.x) * 1.6,
        y / PIXEL_ROWS - cluster.y,
      );
      strength = Math.max(strength, 1 - distance / cluster.radius);
    }
    const chance = noise(x, y);
    // Light a substantial share of the whole artwork at each early level.
    // Clusters bias the reveal, rather than leaving nearly everything dark.
    field.tier[index] =
      chance < 0.32 + strength * 0.3
        ? 1
        : chance < 0.68 + strength * 0.22
          ? 2
          : 3;
    field.intensity[index] = 0.45 + noise(x + 571, y + 23) * 0.55;
    const radius = Math.hypot(columnU[x], rowW[y]) / MAX_RADIUS;
    field.radius[index] = radius;
    // A slightly ragged front reads as fire catching, not a clean circle.
    field.arrival[index] =
      radius * PIXEL_WAVE_DURATION + noise(y + 91, x) * PIXEL_WAVE_JITTER;
    // About one cell in thirty glints, each on its own 15-45 second cycle.
    if (noise(x + 37, y + 811) < 0.033) {
      const period = Math.round(15000 + noise(x + 173, y) * 30000);
      field.sparkPeriod[index] = period;
      field.sparkPhase[index] = Math.round(noise(y + 317, x) * period);
    }
  }
  return field;
}

const SINE_STEPS = 1024;
const SINE = Float32Array.from({ length: SINE_STEPS }, (_, step) =>
  Math.sin((step / SINE_STEPS) * Math.PI * 2),
);
/** Sine of an angle given in turns (any sign), from a table. */
function wave(turns: number): number {
  return SINE[(turns * SINE_STEPS) & (SINE_STEPS - 1)];
}

function ease(value: number): number {
  return value * value * (3 - 2 * value);
}

// Reduced motion shows one composed moment of the same light, never a loop.
const STILL_SECONDS = 4;
const rowBend = new Float32Array(PIXEL_ROWS);
const columnBend = new Float32Array(PIXEL_COLUMNS);
const sparkIndex = new Uint16Array(PIXEL_COUNT);
const sparkGlow = new Float32Array(PIXEL_COUNT);

/**
 * Computes every cell's brightness (0 = unlit, 1-255 = lit) for one frame.
 * Three slow waves of light cross the artwork: rings leaving its heart and two
 * bent drifts. Where they meet, crests turn ivory. A few cells twinkle, and a
 * completion sends a bright front outward that ignites the newly earned cells.
 */
export function paintPixels(
  field: PixelField,
  shades: Uint8Array,
  frame: PixelFrame,
): void {
  const { level, reducedMotion } = frame;
  const seconds = reducedMotion ? STILL_SECONDS : frame.time / 1000;
  for (let row = 0; row < PIXEL_ROWS; row++) {
    rowBend[row] = 0.27 * wave(rowW[row] * 1.1 - seconds * 0.012);
  }
  for (let column = 0; column < PIXEL_COLUMNS; column++) {
    columnBend[column] = 0.2 * wave(columnU[column] * 0.9 + seconds * 0.01);
  }
  // Slow enough to notice only when you look: a crest takes ~40s to cross.
  const ringTime = -seconds * 0.03;
  const driftTime = seconds * 0.014;
  const crossTime = -seconds * 0.019;
  let sparks = 0;
  let index = 0;
  for (let row = 0; row < PIXEL_ROWS; row++) {
    const w = rowW[row];
    for (let column = 0; column < PIXEL_COLUMNS; column++, index++) {
      const tier = field.tier[index];
      if (tier > level) {
        shades[index] = 0;
        continue;
      }
      const arrival = field.arrival[index];
      const since = reducedMotion ? Infinity : frame.elapsed[tier] - arrival;
      if (since <= 0) {
        shades[index] = 0;
        continue;
      }
      const u = columnU[column];
      const radius = field.radius[index];
      // The gain lets crests saturate to ivory where the waves meet.
      const light = Math.min(
        1,
        Math.max(
          0,
          0.5 +
            0.62 *
              (0.45 * wave(radius * 2.4 + ringTime + rowBend[row] * 0.5) +
                0.3 * wave(u * 1.3 + w * 0.9 + driftTime + rowBend[row]) +
                0.25 *
                  wave(w * 1.9 - u * 0.7 + crossTime + columnBend[column])),
        ),
      );
      // Squaring deepens the troughs so the crests read as moving light.
      let value =
        field.intensity[index] *
        (0.08 + 0.92 * light * light) *
        (1 - 0.3 * radius);
      if (!reducedMotion) {
        const period = field.sparkPeriod[index];
        if (period !== 0) {
          const position = (frame.time + field.sparkPhase[index]) % period;
          if (position < PIXEL_SPARK_DURATION) {
            let glow = wave((position / PIXEL_SPARK_DURATION) * 0.5);
            // A soft glint, well short of the white a completion earns.
            glow *= glow * 0.6;
            value += (1 - value) * glow;
            sparkIndex[sparks] = index;
            sparkGlow[sparks++] = glow;
          }
        }
        if (since < PIXEL_RISE_DURATION) {
          value *= ease(since / PIXEL_RISE_DURATION);
        }
        // New cells ignite white-hot; cells already lit swell as the front passes.
        let burst = 0;
        if (since < PIXEL_FLASH_DURATION) {
          const fade = 1 - since / PIXEL_FLASH_DURATION;
          burst = 0.95 * fade * fade;
        }
        const passed = frame.pulse - arrival;
        if (passed > 0 && passed < PIXEL_FLASH_DURATION) {
          const fade = 1 - passed / PIXEL_FLASH_DURATION;
          burst = Math.max(burst, 0.5 * fade * fade);
        }
        value += (1 - value) * burst;
      }
      // Lit cells never drop to 0, so the earned shape stays whole.
      shades[index] = Math.max(1, Math.min(255, Math.round(value * 255)));
    }
  }
  // Each twinkle spills onto its four lit neighbours: a small pixel star.
  for (let spark = 0; spark < sparks; spark++) {
    const centre = sparkIndex[spark];
    const arm = Math.round(sparkGlow[spark] * 0.45 * 255);
    const column = centre % PIXEL_COLUMNS;
    if (column > 0) spill(shades, centre - 1, arm);
    if (column < PIXEL_COLUMNS - 1) spill(shades, centre + 1, arm);
    if (centre >= PIXEL_COLUMNS) spill(shades, centre - PIXEL_COLUMNS, arm);
    if (centre < PIXEL_COUNT - PIXEL_COLUMNS) {
      spill(shades, centre + PIXEL_COLUMNS, arm);
    }
  }
}

function spill(shades: Uint8Array, index: number, arm: number): void {
  if (shades[index] !== 0 && shades[index] < arm) shades[index] = arm;
}

// Brightness to colour: ember, blood red, hot pink, then ivory at the crests.
const stops: [number, number, number, number, number][] = [
  [0, 70, 0, 14, 0],
  [0.1, 96, 2, 22, 0.5],
  [0.34, 190, 10, 42, 0.9],
  [0.56, 255, 18, 59, 1],
  [0.78, 255, 88, 114, 1],
  [1, 255, 238, 226, 1],
];

/** RGBA bytes for each of the 256 brightness values. */
export const PIXEL_PALETTE = new Uint8ClampedArray(256 * 4);
for (let shade = 1; shade < 256; shade++) {
  const value = shade / 255;
  const upper = Math.max(
    1,
    stops.findIndex((stop) => stop[0] >= value),
  );
  const from = stops[upper - 1];
  const to = stops[upper];
  const mix = (value - from[0]) / (to[0] - from[0]);
  for (let channel = 0; channel < 4; channel++) {
    const blended =
      from[channel + 1] + (to[channel + 1] - from[channel + 1]) * mix;
    PIXEL_PALETTE[shade * 4 + channel] =
      channel === 3 ? blended * 255 : blended;
  }
}
