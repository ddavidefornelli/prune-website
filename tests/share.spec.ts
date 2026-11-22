import { test, expect, addTask, openList, cloudTask } from "./helpers/browser";

const sheet = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Share list" });
const TOKEN = "0123456789abcdef0123456789abcdef";

test("a guest signs in from Share, then copies the list's link", async ({ page, backend, context, browserName }) => {
  // WebKit has no clipboard permissions to grant: the link is still shown to copy by hand.
  const clipboard = browserName === "chromium";
  if (clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openList(page);
  await addTask(page, "Plan the trip");
  // Share is in the header, always in sight.
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(sheet(page).getByRole("heading", { name: "Share this list" })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Continue with Google" })).toBeVisible();

  await sheet(page).getByRole("textbox", { name: "Email" }).fill("alice@example.test");
  await sheet(page).getByRole("button", { name: "Send code" }).click();
  await sheet(page).getByRole("textbox", { name: "Code" }).fill("123456");
  await sheet(page).getByRole("button", { name: "Sign in" }).click();

  // Back as the account: Share opens again with the link, and the list came along.
  const link = sheet(page).getByRole("textbox", { name: "Link" });
  await expect(link).toHaveValue(`http://127.0.0.1:4173/?join=${TOKEN}`);
  if (clipboard) {
    await sheet(page).getByRole("button", { name: "Copy link" }).click();
    await expect(sheet(page).getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4173/?join=${TOKEN}`);
  }
  await expect.poll(() => backend.tasks.map((task) => task.title)).toContain("Plan the trip");
  expect(backend.requests.some((request) => request.body.p_action === "share" && request.authorization?.includes("."))).toBe(true);
});

test.describe("opening a shared list's link", () => {
  test.use({ visitor: "account", seed: { tasks: [cloudTask("Book flights")] } });

  test("joins the list once signed in, and the token never stays in the address bar", async ({ page, backend }) => {
    backend.shareToken = TOKEN;
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("heading", { name: "You're in" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
    expect(backend.role).toBe("member");
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toBeVisible();
    await expect(sheet(page).getByText("2 people share this list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Shared · 2" })).toBeVisible();

    // Leaving: the shared list stays with its people.
    page.once("dialog", (dialog) => void dialog.accept());
    await sheet(page).getByRole("button", { name: "Leave this list" }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(backend.role).toBe(null);
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toHaveCount(0);
  });

  test("a link that no longer works says so", async ({ page, backend }) => {
    backend.shareToken = "f".repeat(32);
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("alert")).toHaveText(/doesn't work any more/);
  });
});

test.describe("a new visitor opening a link", () => {
  test.use({ visitor: "new" });

  test("is asked to sign in, accepting the terms, then joins", async ({ page, backend }) => {
    backend.shareToken = TOKEN;
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("heading", { name: "Join a shared list" })).toBeVisible();
    await sheet(page).getByRole("textbox", { name: "Email" }).fill("bob@example.test");
    await sheet(page).getByRole("button", { name: "Send code" }).click();
    await sheet(page).getByRole("textbox", { name: "Code" }).fill("123456");
    await sheet(page).getByRole("button", { name: "Sign in" }).click();
    await expect(sheet(page).getByRole("heading", { name: "You're in" })).toBeVisible();
    expect(backend.role).toBe("member");
  });
});
