import type { Page } from "@playwright/test";
import { test, expect, openPlanner, addTask, synced } from "./helpers/browser";

// The production CSP lists the live site's /sounds/ folder, which the local
// preview origin is not; tests/security-policy.test.mjs covers that entry.
// WebKit enforces the page's <meta> CSP even with bypassCSP, so only Chromium
// can fetch the files here.
test.use({ signedIn: true, bypassCSP: true });
test.skip(({ browserName }) => browserName !== "chromium", "WebKit cannot bypass the page's own CSP");

/** Counts the loops the page starts and stops, without real speakers. */
async function countSounds(page: Page) {
  await page.addInitScript(() => {
    const counts = { started: 0, stopped: 0, closed: 0 };
    Object.assign(window, { soundCounts: counts });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      counts.started++;
      return start.apply(this, args);
    };
    const stop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.stop = function (...args) {
      counts.stopped++;
      return stop.apply(this, args);
    };
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function () {
      counts.closed++;
      return close.call(this);
    };
  });
  return () => page.evaluate(() => (window as unknown as { soundCounts: Record<string, number> }).soundCounts);
}

async function startFocus(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlanner(page);
  await addTask(page, "Write the proposal");
  await synced(page);
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(page.locator("#focus-timer")).toBeVisible();
  return page.getByRole("group", { name: "Sounds" });
}

test("focus sounds switch between off, rain and white noise and stop when the task is done", async ({ page }) => {
  const counts = await countSounds(page);
  const fetched: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/sounds/")) fetched.push(new URL(request.url()).pathname);
  });
  const sounds = await startFocus(page);
  const off = sounds.getByRole("radio", { name: "Off", exact: true });
  const rain = sounds.getByRole("radio", { name: "Rain", exact: true });
  const noise = sounds.getByRole("radio", { name: "White noise", exact: true });
  await expect(off).toBeChecked();
  await expect(sounds.getByRole("slider", { name: "Volume" })).toHaveCount(0);
  // Nothing is downloaded until someone asks for a sound.
  expect(fetched).toEqual([]);

  await rain.check();
  await expect(rain).toBeChecked();
  await expect(sounds).toHaveAttribute("aria-busy", "false");
  await expect(sounds.getByRole("slider", { name: "Volume" })).toBeVisible();
  expect(fetched).toEqual(["/sounds/rain.m4a"]);
  expect((await counts()).started).toBe(1);

  // Switching swaps the sound rather than layering both.
  await noise.check();
  await expect(sounds).toHaveAttribute("aria-busy", "false");
  await expect(rain).not.toBeChecked();
  expect(fetched).toEqual(["/sounds/rain.m4a", "/sounds/white-noise.m4a"]);
  expect(await counts()).toMatchObject({ started: 2, stopped: 1 });

  await sounds.getByRole("slider", { name: "Volume" }).fill("0.3");
  expect(await page.evaluate(() => localStorage.getItem("prune:focus-sound-volume:v1"))).toBe("0.3");

  await off.check();
  await expect(sounds.getByRole("slider", { name: "Volume" })).toHaveCount(0);
  expect((await counts()).stopped).toBe(2);

  // Coming back to a sound reuses the download.
  await rain.check();
  await expect(sounds).toHaveAttribute("aria-busy", "false");
  expect(fetched).toHaveLength(2);
  expect((await counts()).started).toBe(3);

  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(page.getByRole("main", { name: "Today", exact: true })).toBeVisible();
  expect((await counts()).closed).toBe(1);
});

test("a sound that fails to load goes back to off and says so", async ({ page }) => {
  await page.route("**/sounds/rain.m4a", (route) => route.fulfill({ status: 503 }));
  const sounds = await startFocus(page);
  await sounds.getByRole("radio", { name: "Rain", exact: true }).click();
  await expect(sounds.getByRole("status")).toHaveText("That sound didn't load. Check your connection and try again.");
  await expect(sounds.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
  await expect(sounds.getByRole("slider", { name: "Volume" })).toHaveCount(0);
});
