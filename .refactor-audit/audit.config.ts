import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Temporary refactor audit: records the rendered DOM of every screen so a
// before/after diff can prove the refactor changed nothing for visitors.
export const PORT = 4179;
const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.audit.ts",
  workers: 4,
  fullyParallel: true,
  forbidOnly: true,
  reporter: "list",
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: `npm run build -- --outDir .refactor-audit/dist && npm run preview -- --outDir .refactor-audit/dist --port ${PORT} --strictPort`,
    cwd: root,
    env: {
      VITE_SUPABASE_URL: "https://web-fixture.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_fixture",
    },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
