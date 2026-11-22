import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { hasMarketingTracker } from "../scripts/tracking-policy.ts";
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory));
    return /\.(?:html|[cm]?js|tsx?|css|json)$/i.test(entry.name) ? [path] : [];
  });
}

test("web source and public text assets contain no marketing tracking integrations", () => {
  const files = [new URL("../index.html", import.meta.url), ...sourceFiles(new URL("../src/", import.meta.url)), ...sourceFiles(new URL("../public/", import.meta.url))];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!hasMarketingTracker(content), `Tracking integration found in ${file.pathname}`);
  }
});

test("package dependencies do not install advertising or behavioural analytics SDKs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  // PostHog is not a dependency: its library is loaded from PostHog's CDN
  // only after cookie consent (src/analytics.ts), with replays masked.
  for (const name of Object.keys(dependencies)) {
    assert.ok(!/^(?:@vercel\/speed-insights|@google-analytics\/|@segment\/|@hotjar\/|@contentsquare\/|@microsoft\/clarity|mixpanel-browser$|react-ga(?:4)?$|react-gtm-module$)/.test(name), `Tracking SDK found: ${name}`);
  }
});
