import { test, expect, addTask, openList, cloudTask, ACCOUNT_ID, GROUP_ID, TOKEN, type Backend } from "./helpers/browser";

type Page = import("@playwright/test").Page;
const sheet = (page: Page) => page.getByRole("dialog", { name: "Share list" });
const LINK = `http://127.0.0.1:4173/?join=${TOKEN}`;
const shareButton = (page: Page) => page.getByRole("button", { name: /^(Share|Shared · \d+)$/ });

/** Opens a space: from the sidebar on a laptop, from the sheet behind the space name on a phone. */
async function openSpace(page: Page, name: string) {
  const sidebar = page.locator(".space-sidebar");
  if (await sidebar.isVisible()) {
    await sidebar.getByRole("button", { name }).click();
    return;
  }
  await page.locator(".space-button").click();
  const spaces = page.getByRole("dialog", { name: "Spaces" });
  await spaces.getByRole("button", { name }).click();
  await expect(spaces).toHaveCount(0);
}

/** A group space someone else made, with one task, that the visitor can join. */
function theirSpace(backend: Backend, members: string[] = ["99999999-9999-4999-8999-999999999999"]) {
  backend.groups.push({ id: GROUP_ID, name: "Trip", token: TOKEN, owner: members[0], members: [...members], tasks: [cloudTask("Book flights")] });
}

test("a guest signs in from Share, names the space, and gets its link; Personal starts empty", async ({ page, backend, context, browserName }) => {
  // WebKit has no clipboard permissions to grant: the link is still shown to copy by hand.
  const clipboard = browserName === "chromium";
  if (clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openList(page);
  await addTask(page, "Plan the trip");
  // Share is in the header, always in sight.
  await shareButton(page).click();
  await expect(sheet(page).getByRole("heading", { name: "Share this list" })).toBeVisible();
  await sheet(page).getByRole("textbox", { name: "Email" }).fill("alice@example.test");
  await sheet(page).getByRole("button", { name: "Send code" }).click();
  await sheet(page).getByRole("textbox", { name: "Code" }).fill("123456");
  await sheet(page).getByRole("button", { name: "Sign in" }).click();

  // Back as the account: Share opens again, asking what to call the shared space.
  await expect(sheet(page).getByText("Your tasks move to a new shared space.")).toBeVisible();
  await sheet(page).getByRole("textbox", { name: "Name" }).fill("Trip");
  await sheet(page).getByRole("button", { name: "Create link" }).click();
  await expect(sheet(page).getByRole("textbox", { name: "Link" })).toHaveValue(LINK);
  await expect(sheet(page).getByRole("heading", { name: "Trip" })).toBeVisible();
  if (clipboard) {
    await sheet(page).getByRole("button", { name: "Copy link" }).click();
    await expect(sheet(page).getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINK);
  }
  expect(backend.groups[0]).toMatchObject({ name: "Trip", owner: ACCOUNT_ID });
  expect(backend.groups[0].tasks.map((task) => task.title)).toEqual(["Plan the trip"]);
  await page.keyboard.press("Escape");

  // The shared space is open, with the task; Personal is empty.
  await expect(page.getByRole("checkbox", { name: "Plan the trip" })).toBeVisible();
  await openSpace(page, "Personal");
  await expect(page.getByRole("checkbox", { name: "Plan the trip" })).toHaveCount(0);
  await addTask(page, "Call mum");
  await expect.poll(() => backend.tasks.map((task) => task.title)).toEqual(["Call mum"]);
  expect(backend.groups[0].tasks.map((task) => task.title)).toEqual(["Plan the trip"]);
});

test.describe("opening a shared space's link", () => {
  test.use({ visitor: "account", seed: { tasks: [cloudTask("My own errand")] } });

  test("adds the space beside Personal, opens it, and the token never stays in the address bar", async ({ page, backend }) => {
    theirSpace(backend);
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("heading", { name: "You're in" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
    expect(backend.groups[0].members).toContain(ACCOUNT_ID);
    await expect(sheet(page).getByText("2 people")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "My own errand" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Shared · 2" })).toBeVisible();

    // Leaving: back to Personal, which kept its own tasks.
    await page.getByRole("button", { name: "Shared · 2" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await sheet(page).getByRole("button", { name: "Leave space" }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(backend.groups[0].members).not.toContain(ACCOUNT_ID);
    await expect(page.getByRole("checkbox", { name: "My own errand" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toHaveCount(0);
  });

  test("a link that no longer works says so", async ({ page }) => {
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("alert")).toHaveText(/doesn't work any more/);
  });

  test("a space deleted by its owner closes, back to Personal", async ({ page, backend }) => {
    theirSpace(backend, ["99999999-9999-4999-8999-999999999999", ACCOUNT_ID]);
    await openList(page);
    await openSpace(page, "Trip");
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toBeVisible();
    backend.groups = [];
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "My own errand" })).toBeVisible();
    await expect(page.locator(".space-sidebar")).toHaveCount(0);
  });
});

test.describe("a new visitor opening a link", () => {
  test.use({ visitor: "new" });

  test("is asked to sign in, accepting the terms, then joins", async ({ page, backend }) => {
    theirSpace(backend);
    await page.goto(`/?join=${TOKEN}`);
    await expect(sheet(page).getByRole("heading", { name: "Join a shared list" })).toBeVisible();
    await sheet(page).getByRole("textbox", { name: "Email" }).fill("bob@example.test");
    await sheet(page).getByRole("button", { name: "Send code" }).click();
    await sheet(page).getByRole("textbox", { name: "Code" }).fill("123456");
    await sheet(page).getByRole("button", { name: "Sign in" }).click();
    await expect(sheet(page).getByRole("heading", { name: "You're in" })).toBeVisible();
    expect(backend.groups[0].members).toContain(ACCOUNT_ID);
  });
});

test.describe("a shared space in real time", () => {
  test.use({ visitor: "account" });

  test("someone else's change shows up the moment the server says so", async ({ page, backend, context }) => {
    theirSpace(backend, ["99999999-9999-4999-8999-999999999999", ACCOUNT_ID]);
    let socket: import("@playwright/test").WebSocketRoute | null = null;
    const joined: Record<string, any>[] = [];
    await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.event === "phx_join") {
          joined.push(message);
          ws.send(JSON.stringify({ topic: message.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: message.ref, join_ref: message.join_ref }));
        }
      });
    });
    await openList(page);
    await openSpace(page, "Trip");
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toBeVisible();
    await expect.poll(() => joined.length).toBeGreaterThan(0);
    // Only the person's own private topic, with their token.
    expect(joined[0].topic).toBe(`realtime:list:${ACCOUNT_ID}`);
    expect(joined[0].payload.config.private).toBe(true);
    expect(joined[0].payload.access_token).toEqual(expect.any(String));

    // The other person adds a task; the server pings this browser.
    backend.groups[0].tasks.push(cloudTask("Pack the bags", {}, 0));
    socket!.send(JSON.stringify({ topic: joined.at(-1)!.topic, event: "broadcast", payload: { type: "broadcast", event: "changed", payload: { space: GROUP_ID } }, ref: null }));
    await expect(page.getByRole("checkbox", { name: "Pack the bags" })).toBeVisible({ timeout: 3000 });
  });
});

test.describe("on a phone", () => {
  test.use({ visitor: "account", viewport: { width: 390, height: 844 }, seed: { tasks: [cloudTask("My own errand")] } });

  test("the space name in the header opens the list of spaces", async ({ page, backend }) => {
    theirSpace(backend, ["99999999-9999-4999-8999-999999999999", ACCOUNT_ID]);
    await openList(page);
    await expect(page.locator(".space-sidebar")).toBeHidden();
    await expect(page.locator(".space-button")).toHaveText("Personal");
    await openSpace(page, "Trip");
    await expect(page.locator(".space-button")).toHaveText("Trip");
    await expect(page.getByRole("checkbox", { name: "Book flights" })).toBeVisible();
  });
});
