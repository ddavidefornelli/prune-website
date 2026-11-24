import { test, expect, addTask, openList, GUEST_ID } from "./helpers/browser";

const edit = (page: import("@playwright/test").Page, title: string) => page.getByRole("button", { name: `Edit ${title}`, exact: true });
const doIt = (page: import("@playwright/test").Page, title: string) => page.getByRole("button", { name: `Do it for me: ${title}`, exact: true });
const sheet = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Do it for me" });

test("only tasks the helper can do offer Do it for me, in plain sight once they are sorted", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Buy milk");
  await addTask(page, "Email Marco about the budget");
  await expect.poll(() => backend.helperCalls.filter((call) => call.action === "classify").length).toBeGreaterThan(0);
  // No tap needed: the offer sits under the task.
  await expect(doIt(page, "Email Marco about the budget")).toBeVisible();
  await expect(doIt(page, "Buy milk")).toHaveCount(0);
  // Still there while the words are being changed.
  await edit(page, "Email Marco about the budget").click();
  await expect(doIt(page, "Email Marco about the budget")).toBeVisible();
  await page.keyboard.press("Escape");
  await edit(page, "Buy milk").click();
  await expect(doIt(page, "Buy milk")).toHaveCount(0);
});

test("Do it for me: a this-or-that question, a spinner, then the answer under the task to refine, keep or discard", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Email Marco about the budget");
  await doIt(page, "Email Marco about the budget").click();
  await expect(sheet(page).getByRole("heading", { name: "How should it sound?" })).toBeVisible();
  await sheet(page).getByRole("button", { name: "Warm" }).click();
  await expect(sheet(page)).toHaveCount(0);
  const start = backend.helperCalls.find((call) => call.action === "start")!;
  expect(start).toMatchObject({ title: "Email Marco about the budget", kind: "draft", picks: [{ question: "How should it sound?", answer: "Warm" }] });
  expect(start.locale.timeZone).toEqual(expect.any(String));
  await expect(page.getByRole("img", { name: "Working on Email Marco about the budget" })).toBeVisible();

  const answer = page.getByRole("button", { name: "Open the answer for Email Marco about the budget" });
  await expect(answer).toHaveText("Hi Marco,");
  await expect(page.getByRole("checkbox", { name: "Email Marco about the budget" })).toBeVisible();
  await answer.click();
  await expect(sheet(page).getByRole("listitem")).toHaveText(["Friday works", "See example.com/notes", "Notes"]);
  await sheet(page).getByRole("textbox", { name: "Ask for a change" }).fill("Shorter");
  await sheet(page).getByRole("button", { name: "Change" }).click();
  await expect(sheet(page).getByText("Shorter.")).toBeVisible();
  expect(backend.helperCalls.find((call) => call.action === "refine")).toMatchObject({ message: "Shorter" });
  await sheet(page).getByRole("button", { name: "Keep" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(answer).toBeVisible();

  await answer.click();
  await sheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(answer).toHaveCount(0);
  expect(backend.helperRuns.size).toBe(0);
});

test("a guest is never asked to sign in, however many answers they ask for", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Write a bio");
  await expect.poll(() => backend.helperCalls.some((call) => call.action === "classify")).toBe(true);
  // Well past what used to be the free answers.
  backend.helperStarts[GUEST_ID] = 3;
  await doIt(page, "Write a bio").click();
  await sheet(page).getByRole("button", { name: "Either is fine" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the answer for Write a bio" })).toBeVisible();
  expect(backend.helperStarts[GUEST_ID]).toBe(4);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
});
