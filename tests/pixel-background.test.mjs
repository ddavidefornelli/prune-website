import test from "node:test";
import assert from "node:assert/strict";
import {
  createPixelField, paintPixels, PIXEL_COLUMNS, PIXEL_ROWS, PIXEL_COUNT, PIXEL_PALETTE,
  PIXEL_FRAME_INTERVAL, PIXEL_WAVE_DURATION, PIXEL_WAVE_JITTER, PIXEL_FLASH_DURATION,
  PIXEL_REVEAL_DURATION, PIXEL_SPARK_DURATION,
} from "../src/shared/pixel-background.ts";

const field = createPixelField();
const centre = (PIXEL_ROWS / 2) * PIXEL_COLUMNS + PIXEL_COLUMNS / 2;
const settled = 1e7;

function paint(overrides = {}) {
  const shades = new Uint8Array(PIXEL_COUNT);
  paintPixels(field, shades, {
    level: 3, time: settled, elapsed: [0, settled, settled, settled], pulse: settled,
    reducedMotion: false, ...overrides,
  });
  return shades;
}
const lit = (shades) => shades.reduce((count, shade) => count + (shade > 0), 0);
const tierCount = (level) => field.tier.reduce((count, tier) => count + (tier <= level), 0);

test("one buffer pixel per cell, with deterministic cumulative tiers", () => {
  assert.equal(PIXEL_COUNT, 12800);
  assert.equal(PIXEL_COLUMNS / PIXEL_ROWS, 2);
  assert.deepEqual(createPixelField(), field);
  for (const values of Object.values(field)) assert.equal(values.length, PIXEL_COUNT);
  assert.ok(field.tier.every((tier) => tier >= 1 && tier <= 3));
  assert.ok(tierCount(1) > 0 && tierCount(1) < tierCount(2) && tierCount(2) < tierCount(3));
  assert.equal(tierCount(3), PIXEL_COUNT);
  for (const level of [0, 1, 2, 3]) {
    const shades = paint({ level });
    assert.equal(lit(shades), tierCount(level));
    assert.ok(shades.every((shade, index) => (shade > 0) === (field.tier[index] <= level)));
  }
});

test("early levels light roughly one-third and two-thirds of the grid, including outside clusters", () => {
  const coverage = [1, 2].map((level) => tierCount(level) / PIXEL_COUNT);
  assert.ok(coverage[0] >= 0.30 && coverage[0] <= 0.40);
  assert.ok(coverage[1] >= 0.65 && coverage[1] <= 0.75);
  // Every region should participate, not just the central clusters. This also
  // keeps the cropped artwork on narrow phones from looking nearly empty.
  for (let row = 0; row < PIXEL_ROWS; row += 20) {
    for (let column = 0; column < PIXEL_COLUMNS; column += 20) {
      let first = 0;
      let second = 0;
      for (let y = row; y < row + 20; y++) {
        for (let x = column; x < column + 20; x++) {
          const tier = field.tier[y * PIXEL_COLUMNS + x];
          if (tier === 1) first++;
          if (tier <= 2) second++;
        }
      }
      assert.ok(first / 400 >= 0.25);
      assert.ok(second / 400 >= 0.60);
    }
  }
});

test("a completion sends a wave out from the centre that ignites cells white-hot", () => {
  assert.ok(field.radius[centre] < 0.02);
  assert.ok(field.radius[0] > 0.98 && field.radius[PIXEL_COUNT - 1] > 0.98);
  for (let index = 0; index < PIXEL_COUNT; index++) {
    const earliest = field.radius[index] * PIXEL_WAVE_DURATION;
    assert.ok(field.arrival[index] >= earliest - 0.01);
    assert.ok(field.arrival[index] <= earliest + PIXEL_WAVE_JITTER + 0.01);
  }
  const at = (ms) => paint({ elapsed: [0, ms, ms, ms], pulse: ms });
  assert.equal(lit(at(0)), 0);
  let previous = 0;
  for (let ms = 100; ms <= PIXEL_REVEAL_DURATION; ms += 100) {
    const shades = at(ms);
    for (let index = 0; index < PIXEL_COUNT; index++) {
      assert.equal(shades[index] > 0, field.arrival[index] < ms);
    }
    assert.ok(lit(shades) >= previous);
    previous = lit(shades);
  }
  assert.equal(previous, PIXEL_COUNT);
  // Just behind the front a cell is near white; it then cools into the ambient light.
  const index = centre + 20;
  const hot = at(field.arrival[index] + 30)[index];
  const cooled = at(field.arrival[index] + PIXEL_REVEAL_DURATION)[index];
  assert.ok(hot >= 225);
  assert.ok(cooled < hot);
});

test("cells that were already lit swell as a later wave passes", () => {
  const index = centre + 30;
  assert.ok(field.sparkPeriod[index] === 0 || field.sparkPeriod[index + 1] === 0);
  const quiet = field.sparkPeriod[index] === 0 ? index : index + 1;
  const calm = paint()[quiet];
  const swollen = paint({ pulse: field.arrival[quiet] + 30 })[quiet];
  assert.ok(swollen > calm + 60 && swollen < 225);
  assert.equal(paint({ pulse: field.arrival[quiet] + PIXEL_FLASH_DURATION })[quiet], calm);
});

test("ambient light keeps every earned cell lit and moves without flashes", () => {
  const range = new Uint8Array(PIXEL_COUNT);
  const low = new Uint8Array(PIXEL_COUNT).fill(255);
  for (let second = 0; second < 120; second += 6) {
    const time = settled + second * 1000;
    const now = paint({ time });
    const next = paint({ time: time + PIXEL_FRAME_INTERVAL });
    assert.equal(lit(now), PIXEL_COUNT);
    let unchanged = 0;
    for (let index = 0; index < PIXEL_COUNT; index++) {
      range[index] = Math.max(range[index], now[index]);
      low[index] = Math.min(low[index], now[index]);
      if (now[index] === next[index]) unchanged++;
      // Twinkles (and their arms) are the only fast change, and even they ease.
      const twinkling = [0, -1, 1, -PIXEL_COLUMNS, PIXEL_COLUMNS]
        .some((offset) => field.sparkPeriod[index + offset] > 0);
      assert.ok(Math.abs(next[index] - now[index]) <= (twinkling ? 36 : 8));
    }
    assert.ok(unchanged > PIXEL_COUNT / 5, "many cells skip repainting on each update");
  }
  // The light really travels: most cells swing widely between trough and crest.
  let moving = 0;
  for (let index = 0; index < PIXEL_COUNT; index++) if (range[index] - low[index] > 40) moving++;
  assert.ok(moving > PIXEL_COUNT * 0.8);
});

test("a few cells glint softly, once per 15-45 second cycle", () => {
  let twinklers = 0;
  for (let index = 0; index < PIXEL_COUNT; index++) {
    const period = field.sparkPeriod[index];
    if (period === 0) continue;
    twinklers++;
    assert.ok(period >= 15000 && period <= 45000);
    assert.ok(field.sparkPhase[index] >= 0 && field.sparkPhase[index] <= period);
  }
  assert.ok(twinklers > PIXEL_COUNT * 0.02 && twinklers < PIXEL_COUNT * 0.05);
  const index = field.sparkPeriod.findIndex((period) => period > 0);
  const start = settled + field.sparkPeriod[index] - ((settled + field.sparkPhase[index]) % field.sparkPeriod[index]);
  const calm = paint({ time: start + PIXEL_SPARK_DURATION + 50 })[index];
  const peak = paint({ time: start + PIXEL_SPARK_DURATION / 2 })[index];
  // Brighter than its surroundings, but never the white of a completion.
  assert.ok(peak > calm + 40 && peak < 225);
  for (let second = 0; second < 30; second += 5) {
    const time = settled + second * 1000;
    let active = 0;
    for (let cell = 0; cell < PIXEL_COUNT; cell++) {
      const period = field.sparkPeriod[cell];
      if (period && (time + field.sparkPhase[cell]) % period < PIXEL_SPARK_DURATION) active++;
    }
    assert.ok(active < PIXEL_COUNT * 0.005);
  }
});

test("reduced motion is one still frame: no wave, drift or twinkle", () => {
  const still = paint({ reducedMotion: true });
  assert.equal(lit(still), PIXEL_COUNT);
  assert.ok(new Set(still).size > 100);
  for (const overrides of [
    { time: 0 }, { time: settled + 12345 },
    { elapsed: [0, 0, 0, 0], pulse: 0 }, { elapsed: [0, 500, 500, 500], pulse: 500 },
  ]) {
    assert.deepEqual(paint({ reducedMotion: true, ...overrides }), still);
  }
});

test("the palette runs from clear through blood red to ivory", () => {
  assert.equal(PIXEL_PALETTE.length, 256 * 4);
  assert.deepEqual([...PIXEL_PALETTE.slice(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...PIXEL_PALETTE.slice(255 * 4)], [255, 238, 226, 255]);
  for (let shade = 1; shade < 256; shade++) {
    const [red, green, blue, alpha] = PIXEL_PALETTE.slice(shade * 4, shade * 4 + 4);
    assert.ok(alpha > 0 && alpha >= PIXEL_PALETTE[shade * 4 - 1]);
    assert.ok(red >= green && red >= blue, "always a red, never another hue");
  }
});
