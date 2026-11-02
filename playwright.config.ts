import { defineConfig } from "@playwright/test";

const fixture = {
  VITE_SUPABASE_URL: "https://web-fixture.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_fixture",
};

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 4,
  fullyParallel: true,
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: [
    {
      // Exercise production output, keeping fixture configuration out of dist/.
      command: "npm run build -- --outDir .playwright-dist && npm run preview -- --outDir .playwright-dist --port 4173 --strictPort",
      env: { ...fixture, VITE_SURVEY_FLOW: "off" },
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
    {
      // The same artifact with the onboarding survey on, for the survey specs.
      command: "npx vite build --outDir .playwright-dist-survey && npm run preview -- --outDir .playwright-dist-survey --port 4174 --strictPort",
      env: { ...fixture, VITE_SURVEY_FLOW: "on" },
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
    },
  ],
});
