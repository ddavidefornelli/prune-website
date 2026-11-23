import type { Page } from "@playwright/test";
import { test, expect, cloudTask, openList, synced, ACCOUNT_ID, GROUP_ID, TOKEN } from "./helpers/browser";

/** Today at `hour`, local time in the browser (the fixture runs in the machine's zone). */
const todayAt = (hour: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).getTime();
};

const calendar = (page: Page) => page.getByRole("region", { name: "Calendar" });
const hours = (page: Page) => page.locator(".calendar-body");
const isOpen = (page: Page) => expect(calendar(page)).toHaveClass(/is-open/);
const isClosed = (page: Page) => expect(calendar(page)).not.toHaveClass(/is-open/);
/** Opens the hours with the calendar's button and waits for them to finish growing. */
async function openCalendar(page: Page) {
  await calendar(page).getByRole("button", { name: "Open calendar" }).click();
  await isOpen(page);
  await expect.poll(() => hours(page).evaluate((el) => el.getBoundingClientRect().height === el.scrollHeight && el.clientHeight > 100)).toBe(true);
  await page.waitForTimeout(400);
}

/** The middle of `hour` in the first visible day column. */
async function hourPoint(page: Page, hour: number, column = 0) {
  const box = (await page.locator(".calendar-column").nth(column).boundingBox())!;
  const grid = (await page.locator(".calendar-columns").boundingBox())!;
  return { x: box.x + box.width / 2, y: grid.y + (hour + 0.5) * (grid.height / 24) };
}

/** Drags with a mouse, in steps, the way a person does. */
async function drag(page: Page, from: { x: number; y: number }, to: () => Promise<{ x: number; y: number }>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 12, { steps: 3 });
  // The calendar opens as the task comes in; aim once it has.
  await isOpen(page);
  await page.waitForTimeout(450);
  const end = await to();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

test.describe("on a laptop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a task dragged onto an hour is planned there, and dragged out it leaves", async ({ page, backend }) => {
    await openList(page);
    await page.getByRole("textbox", { name: "New task", exact: true }).fill("Write the bio");
    await page.keyboard.press("Enter");
    await isClosed(page);
    const row = page.getByRole("listitem").filter({ hasText: "Write the bio" });
    const start = (await row.locator(".task-title").boundingBox())!;
    const scroller = page.locator(".calendar-scroll");
    await drag(page, { x: start.x + 20, y: start.y + 12 }, async () => {
      await scroller.evaluate((element) => (element.scrollTop = 0));
      const day = (await page.locator(".calendar-day.is-today").evaluate((el) => [...el.parentElement!.children].indexOf(el)));
      return hourPoint(page, 2, day);
    });
    await expect(calendar(page).getByRole("button", { name: /^Write the bio, / })).toBeVisible();
    await expect(row.locator(".task-when")).toBeVisible();
    // It closes again by itself once the task has landed.
    await isClosed(page);
    await synced(page);
    expect(backend.tasks[0].startAt).toBe(todayAt(2));

    // Out again: opened with its button, the block is dragged down onto the list.
    await openCalendar(page);
    await scroller.evaluate((element) => (element.scrollTop = 0));
    const block = (await calendar(page).getByRole("button", { name: /^Write the bio, / }).boundingBox())!;
    const list = (await page.getByRole("list", { name: "To do" }).boundingBox())!;
    await drag(page, { x: block.x + 10, y: block.y + 8 }, async () => ({ x: list.x + 40, y: list.y + list.height + 40 }));
    await expect(calendar(page).getByRole("button", { name: /^Write the bio, / })).toHaveCount(0);
    await synced(page);
    expect(backend.tasks[0].startAt).toBeNull();
    // Pinned open with its button: it stays open.
    await isOpen(page);
  });

  test("a tap on an empty hour plans a task, a tap on a planned one takes it off", async ({ page, backend }) => {
    backend.tasks = [cloudTask("Call the bank"), cloudTask("Pay rent")];
    await openList(page);
    await openCalendar(page);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const day = await page.locator(".calendar-day.is-today").evaluate((el) => [...el.parentElement!.children].indexOf(el));
    const point = await hourPoint(page, 3, day);
    await page.mouse.click(point.x, point.y);
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Pay rent" }).click();
    await expect(sheet).toHaveCount(0);
    await synced(page);
    expect(backend.tasks.find((task) => task.title === "Pay rent")!.startAt).toBe(todayAt(3));

    await calendar(page).getByRole("button", { name: /^Pay rent, / }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove from calendar" }).click();
    await synced(page);
    expect(backend.tasks.find((task) => task.title === "Pay rent")!.startAt).toBeNull();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("one day at a time, chosen in the week strip; the hours never fill the screen", async ({ page, backend }) => {
    backend.tasks = [cloudTask("Gym", { startAt: todayAt(7) }), cloudTask("Write the bio")];
    await openList(page);
    await expect(page.locator(".calendar-day")).toHaveCount(7);
    await calendar(page).getByRole("button", { name: "Open calendar" }).tap();
    await isOpen(page);
    await expect(page.locator(".calendar-column")).toHaveCount(1);
    const open = (await hours(page).boundingBox())!;
    expect(open.height).toBeLessThan(844 * 0.6);
    await expect(calendar(page).getByRole("button", { name: /^Gym, / })).toBeVisible();
    // Another day: today's task is not on it.
    const other = (await page.locator(".calendar-day.is-today").evaluate((el) => [...el.parentElement!.children].indexOf(el))) === 0 ? 1 : 0;
    await page.locator(".calendar-day").nth(other).tap();
    await expect(calendar(page).getByRole("button", { name: /^Gym, / })).toHaveCount(0);
  });
});

test.describe("on a phone, by touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("holding a task picks it up; the calendar grows and takes it", async ({ page, backend, browserName }) => {
    test.skip(browserName !== "chromium", "Real touch sequences go through Chromium's DevTools protocol.");
    backend.tasks = [cloudTask("Write the bio")];
    await openList(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const row = (await page.locator(".task-title").first().boundingBox())!;
    const from = { x: row.x + 30, y: row.y + row.height / 2 };

    // A quick swipe is a scroll: nothing is picked up.
    await touch("touchStart", from.x, from.y);
    await touch("touchMove", from.x, from.y - 40);
    await touch("touchEnd", from.x, from.y - 40);
    await isClosed(page);

    // Held, it lifts and the calendar opens to take it.
    await touch("touchStart", from.x, from.y);
    await page.waitForTimeout(400);
    await isOpen(page);
    await expect(page.locator(".drag-ghost")).toHaveText("Write the bio");
    await page.waitForTimeout(450);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const target = await hourPoint(page, 4);
    for (let step = 1; step <= 10; step += 1)
      await touch("touchMove", from.x + ((target.x - from.x) * step) / 10, from.y + ((target.y - from.y) * step) / 10);
    await expect(page.locator(".calendar-drop")).toBeVisible();
    await touch("touchEnd", target.x, target.y);
    await expect(page.locator(".drag-ghost")).toHaveCount(0);
    await synced(page);
    const day = await page.locator(".calendar-day.is-selected").evaluate((el) => [...el.parentElement!.children].indexOf(el));
    const shown = await page.evaluate((index) => {
      const now = new Date();
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
      return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, 4).getTime();
    }, day);
    expect(backend.tasks[0].startAt).toBe(shown);
    // It did not also open the task for editing.
    await expect(page.getByRole("textbox", { name: "Task", exact: true })).toHaveCount(0);
  });
});

test.describe("smoothness", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a planned block stays put while the list changes around it: no flicker, no replayed landing", async ({ page, backend }) => {
    backend.tasks = [cloudTask("Write the bio", { startAt: todayAt(2) }), cloudTask("Call the bank")];
    await openList(page);
    await openCalendar(page);
    const block = await calendar(page).getByRole("button", { name: /^Write the bio, / }).elementHandle();
    // Another task changes and syncs: the block is the same element.
    await page.getByRole("button", { name: "Edit Call the bank", exact: true }).click();
    await page.getByRole("textbox", { name: "Task", exact: true }).fill("Call the bank today");
    await page.keyboard.press("Enter");
    await synced(page);
    expect(await block!.evaluate((element) => element.isConnected)).toBe(true);
  });
});

test.describe("a planned task's details", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("its sheet sets how long it takes and keeps a description whose links open", async ({ page, backend }) => {
    backend.tasks = [cloudTask("Call the bank", { startAt: todayAt(2) })];
    await openList(page);
    await openCalendar(page);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const block = calendar(page).getByRole("button", { name: /^Call the bank, / });
    const before = (await block.boundingBox())!.height;
    await block.click();
    const sheet = page.getByRole("dialog", { name: "Call the bank" });
    // Like a calendar app: the day, then start – end; the end lists times with their length.
    await expect(sheet.getByRole("combobox", { name: "Ends" }).locator("option", { hasText: "(1 h 30 min)" })).toHaveCount(1);
    await sheet.getByRole("combobox", { name: "Ends" }).selectOption("90");
    const shown = () => sheet.locator(".calendar-when-times .calendar-field-text").allInnerTexts().then((texts) => texts.map((text) => text.replace(/\s/g, " ")));
    await expect.poll(shown).toEqual(["2:00 AM", "3:30 AM"]);
    // Moving the start keeps the length.
    await sheet.getByRole("combobox", { name: "Starts" }).selectOption(String(3 * 60));
    await expect.poll(shown).toEqual(["3:00 AM", "4:30 AM"]);
    const notes = sheet.getByRole("textbox", { name: "Description" });
    await notes.fill("Ask about the card. Form: https://example.com/form?x=1.");
    const link = sheet.getByRole("list", { name: "Links" }).getByRole("link");
    await expect(link).toHaveText("example.com/form?x=1");
    await expect(link).toHaveAttribute("href", "https://example.com/form?x=1");
    await expect(link).toHaveAttribute("target", "_blank");
    await sheet.getByRole("button", { name: "Close" }).click();
    await synced(page);
    expect(backend.tasks[0]).toMatchObject({ startAt: todayAt(3), minutes: 90, notes: "Ask about the card. Form: https://example.com/form?x=1." });
    await expect.poll(async () => (await block.boundingBox())!.height).toBeGreaterThan(before * 1.4);
  });

  test("dragging a block's bottom edge changes its length in 15-minute steps", async ({ page, backend }) => {
    backend.tasks = [cloudTask("Write the bio", { startAt: todayAt(2) })];
    await openList(page);
    await openCalendar(page);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const block = calendar(page).getByRole("button", { name: /^Write the bio, / });
    const box = (await block.boundingBox())!;
    const hour = (await page.locator(".calendar-columns").boundingBox())!.height / 24;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3 + hour * 0.8, { steps: 6 });
    await page.mouse.up();
    await synced(page);
    expect(backend.tasks[0].minutes).toBe(105);
    expect(backend.tasks[0].startAt).toBe(todayAt(2));
    // The press did not also open its sheet.
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("calendars and spaces", () => {
  test.use({ viewport: { width: 1280, height: 800 }, visitor: "account" });

  test("Personal also shows plans made in groups; a group shows its people's busy time, blurred", async ({ page, backend }) => {
    backend.groups.push({ id: GROUP_ID, name: "Trip", token: TOKEN, owner: ACCOUNT_ID, members: [ACCOUNT_ID, "99999999-9999-4999-8999-999999999999"], tasks: [cloudTask("Book flights", { startAt: todayAt(5) })] });
    backend.calendar.elsewhere = [{ id: backend.groups[0].tasks[0].id, space: GROUP_ID, spaceName: "Trip", title: "Book flights", startAt: todayAt(5), minutes: 60, done: false, notes: "" }];
    backend.calendar.busy = [{ start: todayAt(1), end: todayAt(3) }];
    await openList(page);
    await openCalendar(page);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const elsewhere = calendar(page).getByRole("button", { name: /^Book flights, Trip, / });
    await expect(elsewhere).toContainText("Trip");
    await elsewhere.click();
    await expect(page.getByRole("dialog", { name: "Book flights" })).toContainText("Trip");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    // Personal shows no one else's busy time.
    await expect(page.locator(".calendar-busy")).toHaveCount(0);

    await page.locator(".space-sidebar").getByRole("button", { name: "Trip" }).click();
    await openCalendar(page);
    await page.locator(".calendar-scroll").evaluate((element) => (element.scrollTop = 0));
    const busy = page.locator(".calendar-busy");
    await expect(busy).toHaveCount(1);
    await expect(busy).toHaveText("");
    await expect(busy).toHaveAttribute("aria-label", /^Busy /);
    // The group's own task is a normal, movable block.
    await expect(calendar(page).locator(".calendar-item.is-task")).toHaveCount(1);
    const asked = backend.requests.filter((request) => request.body?.p_action === "calendar").map((request) => request.body.p_args.space ?? null);
    expect(asked).toContain(GROUP_ID);
    expect(asked).toContain(null);
  });
});
