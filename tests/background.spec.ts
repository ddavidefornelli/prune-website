import type { Page } from "@playwright/test";
import { test, expect, synced, type Backend } from "./helpers/browser";
import {
  createPixelField, paintPixels, PIXEL_COLUMNS, PIXEL_ROWS, PIXEL_COUNT, PIXEL_PALETTE,
  PIXEL_FRAME_INTERVAL, PIXEL_REVEAL_DURATION,
} from "../src/shared/pixel-background";

const field = createPixelField();
const counts = [0, 1, 2, 3].map((level) => field.tier.filter((tier) => tier <= level).length);
// The still frame shown under reduced motion, as alpha values.
const still = (() => {
  const shades = new Uint8Array(PIXEL_COUNT);
  paintPixels(field, shades, { level: 3, time: 0, elapsed: [0, 0, 0, 0], pulse: 0, reducedMotion: true });
  return Array.from(shades, (shade) => PIXEL_PALETTE[shade * 4 + 3]);
})();

function seedTasks(backend: Backend): void {
  backend.data.todayTasks = ["First outcome", "Second outcome", "Third outcome"].map((outcome, i) => ({
    id: `background-task-${i}`, outcome, isPriority: false,
    plannedFor: backend.data.today, estimatedMinutes: 30, actualSeconds: 0,
    status: "planned", startedAt: null, completedOn: null,
    createdAt: backend.data.serverNow, resources: [],
  }));
}

async function expectArtwork(page: Page, level: number): Promise<void> {
  await expect(page.locator("#app")).toHaveAttribute("data-completion-level", String(level));
  const artwork = page.locator(".cyber-artwork");
  await expect(artwork).toHaveAttribute("aria-hidden", "true");
  await expect(artwork).toHaveCSS("pointer-events", "none");
  await expect(artwork).toHaveCSS("visibility", level ? "visible" : "hidden");
  await expect(artwork).toHaveCSS("opacity", ["0", "0.5", "0.72", "0.94"][level]);
  const mask = await artwork.evaluate((node) => getComputedStyle(node).maskImage);
  expect(mask).toContain("/prune-background-mask.png");
  await expect(artwork).toHaveCSS("mask-mode", "alpha");
  const canvas = page.locator("canvas.pixel-grid");
  // One buffer pixel per cell: the browser scales it, so frames stay tiny.
  await expect(canvas).toHaveAttribute("width", String(PIXEL_COLUMNS));
  await expect(canvas).toHaveAttribute("height", String(PIXEL_ROWS));
  await expect(canvas).toHaveCSS("image-rendering", "pixelated");
  // Density must not turn into thousands of DOM nodes or CSS animations.
  await expect(artwork.locator("*")).toHaveCount(1);
  await expect(canvas).toHaveCSS("animation-name", "none");
}

const pixelAlphas = (page: Page): Promise<number[]> => page.locator(".pixel-grid").evaluate((node) => {
  const canvas = node as HTMLCanvasElement;
  const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  return Array.from({ length: canvas.width * canvas.height }, (_, index) => data[index * 4 + 3]);
});

async function expectLitPixels(page: Page, level: number): Promise<void> {
  await expect.poll(async () => (await pixelAlphas(page)).filter((alpha) => alpha > 0).length).toBe(counts[level]);
}

async function expectStaticPixels(page: Page): Promise<void> {
  // Wait for the JS media-query change event as well as the CSS update.
  // One step of tolerance covers engines rounding the sine table differently.
  await expect.poll(async () => (await pixelAlphas(page)).filter((alpha, index) =>
    Math.abs(alpha - still[index]) > 2).length).toBe(0);
}

test.use({ signedIn: true, timezoneId: "UTC" });

test("the artwork mask has real transparency without luminance-mask support", async ({ page }) => {
  await page.goto("/");
  const mask = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/prune-background-mask.png";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let transparent = 0;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 0) transparent++;
      if (data[i] > 128) visible++;
    }
    return { width: canvas.width, height: canvas.height, transparent, visible };
  });
  expect(mask.width / mask.height).toBe(2);
  expect(mask.transparent).toBeGreaterThan(0);
  expect(mask.visible).toBeGreaterThan(0);
});

for (const width of [390, 1440]) {
  test.describe(`completion grid at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce" });

    test("only completing tasks reveals cumulative clusters, stable across navigation and reload", async ({ page, backend }) => {
      seedTasks(backend);
      await page.goto("/");
      await expect(page.locator(".task")).toHaveCount(3);
      await expectArtwork(page, 0);
      await expectLitPixels(page, 0);
      let previousCount = 0;
      for (const level of [1, 2, 3]) {
        await page.getByRole("button", { name: "Start focus", exact: true }).first().click();
        await synced(page);
        await expectArtwork(page, level - 1);
        await page.getByRole("button", { name: "Complete task", exact: true }).click();
        await synced(page);
        await expectArtwork(page, level);
        await expectLitPixels(page, level);
        expect(counts[level]).toBeGreaterThan(previousCount);
        previousCount = counts[level];
        if (level === 3) expect(counts[level]).toBe(12800);
        if (level === 1) {
          const initial = await pixelAlphas(page);
          for (const view of ["Tomorrow", "Overview", "Today"]) {
            await page.getByRole("navigation").getByRole("button", { name: view, exact: true }).click();
            await expectArtwork(page, 1);
            expect(await pixelAlphas(page)).toEqual(initial);
          }
        }
      }
      const completed = await pixelAlphas(page);
      await page.reload();
      await expectArtwork(page, 3);
      await expectLitPixels(page, 3);
      expect(await pixelAlphas(page)).toEqual(completed);
    });
  });
}

test("past completions stay dim and synced progress caps at three", async ({ page, backend }) => {
  const yesterday = new Date(Date.parse(`${backend.data.today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  backend.data.completions = [{ day: yesterday, count: 3 }, { day: backend.data.today, count: 0 }];
  await page.goto("/");
  await expectArtwork(page, 0);
  for (const count of [2, 5]) {
    backend.data.completions[1].count = count;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expectArtwork(page, Math.min(count, 3));
  }
});

test("pixels change gently and independently; reduced motion makes them static", async ({ page, backend }) => {
  await page.clock.install();
  backend.data.completions = [{ day: backend.data.today, count: 3 }];
  await page.goto("/");
  await expectArtwork(page, 3);
  await page.clock.runFor(5000);
  await expectLitPixels(page, 3);
  const first = await pixelAlphas(page);
  expect(new Set(first).size).toBeGreaterThan(20);
  await page.clock.runFor(1000);
  const second = await pixelAlphas(page);
  expect(second).not.toEqual(first);
  // The light drifts: most cells move, but only twinkles change a lot in a second.
  const changes = second.map((alpha, index) => Math.abs(alpha - first[index]));
  expect(changes.filter((change) => change > 0).length).toBeGreaterThan(counts[3] / 4);
  expect(changes.filter((change) => change > 80).length).toBeLessThan(counts[3] / 20);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".pixel-grid")).toHaveCSS("transition-duration", "0s");
  await expectStaticPixels(page);
  const still = await pixelAlphas(page);
  await page.clock.runFor(2000);
  expect(await pixelAlphas(page)).toEqual(still);
  await expectArtwork(page, 3);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(pixelAlphas.bind(null, page)).not.toEqual(still);
});

test("a completion blooms outward from the centre, then settles", async ({ page, backend }) => {
  await page.clock.install();
  await page.goto("/");
  await expectArtwork(page, 0);
  // Freeze time so the wave only advances when the test says so.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  backend.data.completions = [{ day: backend.data.today, count: 3 }];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectArtwork(page, 3);
  await page.clock.runFor(500);
  const early = await pixelAlphas(page);
  const lit = early.filter((alpha) => alpha > 0).length;
  expect(lit).toBeGreaterThan(0);
  expect(lit).toBeLessThan(counts[3] / 2);
  const reach = (wanted: boolean) => early.reduce((sum, alpha, index) =>
    alpha > 0 === wanted ? sum + field.radius[index] : sum, 0) / (wanted ? lit : counts[3] - lit);
  expect(reach(true)).toBeLessThan(reach(false) / 2);
  await page.clock.runFor(PIXEL_REVEAL_DURATION);
  await expectLitPixels(page, 3);
});

test("drawing is capped, skips unchanged frames, and stops when hidden or inactive", async ({ page, backend }) => {
  await page.clock.install();
  await page.addInitScript(({ interval }) => {
    const stats = { scheduled: 0, paints: 0 };
    Object.assign(window, { __pixelStats: stats });
    const timers: Window = window;
    const schedule = timers.setTimeout.bind(timers);
    timers.setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === interval) stats.scheduled++;
      return schedule(handler, timeout, ...args);
    };
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args: unknown[]) {
      if ((this.canvas as HTMLCanvasElement).classList.contains("pixel-grid")) stats.paints++;
      return (put as (...args: unknown[]) => void).apply(this, args);
    };
  }, { interval: PIXEL_FRAME_INTERVAL });
  const stats = () => page.evaluate(() => (window as typeof window & {
    __pixelStats: { scheduled: number; paints: number };
  }).__pixelStats);
  await page.goto("/");
  await expectArtwork(page, 0);
  await page.clock.runFor(1000);
  expect(await stats()).toEqual({ scheduled: 0, paints: 0 });

  backend.data.completions = [{ day: backend.data.today, count: 3 }];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectArtwork(page, 3);
  await page.clock.runFor(5000);
  const start = await stats();
  await page.clock.runFor(1000);
  const active = await stats();
  const frames = active.scheduled - start.scheduled;
  // Ambient light: at most 10 updates/second, each a single small upload.
  expect(frames).toBeGreaterThan(5);
  expect(frames).toBeLessThanOrEqual(11);
  expect(active.paints - start.paints).toBeGreaterThan(0);
  expect(active.paints - start.paints).toBeLessThanOrEqual(frames + 1);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await stats();
  await page.clock.runFor(2000);
  expect(await stats()).toEqual(hidden);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(500);
  expect((await stats()).scheduled).toBeGreaterThan(hidden.scheduled);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".pixel-grid")).toHaveCSS("transition-duration", "0s");
  await expectStaticPixels(page);
  const reduced = await stats();
  await page.clock.runFor(2000);
  expect(await stats()).toEqual(reduced);

  backend.data.completions[0].count = 0;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectArtwork(page, 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const inactive = await stats();
  await page.clock.runFor(2000);
  expect(await stats()).toEqual(inactive);
});

test("the grid resets on the next day, including offline", async ({ page, backend }) => {
  await page.clock.install({ time: backend.data.serverNow * 1000 });
  backend.data.completions = [{ day: backend.data.today, count: 3 }];
  await page.goto("/");
  await expectArtwork(page, 3);
  backend.offline = true;
  await page.clock.setSystemTime((backend.data.serverNow + 86400) * 1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectArtwork(page, 0);
});

test("an offline completion lights the first cluster", async ({ page, backend }) => {
  seedTasks(backend);
  const task = backend.data.todayTasks[0];
  backend.data.activeTask = { ...task, status: "active", startedAt: backend.data.serverNow };
  backend.data.todayTasks = [];
  await page.goto("/");
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expectArtwork(page, 0);
  backend.offline = true;
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expectArtwork(page, 1);
  backend.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await synced(page);
  await expectArtwork(page, 1);
});
