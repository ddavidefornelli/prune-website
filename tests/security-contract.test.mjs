import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import viteConfig from "../vite.config.ts";
import { PRIVACY_POLICY_VERSION } from "../src/planner/privacy-state.ts";

const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
test("Vercel uses generated build output, not a static wildcard CSP", () => {
  assert.equal(deployment.framework, null);
  assert.equal(deployment.buildCommand, "npm run build:vercel");
  assert.equal(deployment.headers, undefined);
  assert.equal(deployment.outputDirectory, undefined);
});

function configuration(url, key, command = "build") {
  const keys = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
  const original = keys.map((name) => process.env[name]);
  try {
    process.env.VITE_SUPABASE_URL = url;
    process.env.VITE_SUPABASE_ANON_KEY = key;
    return viteConfig({ command, mode: "production" });
  } finally {
    keys.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
}
for (const [name, url, key] of [
  ["missing configuration", "", ""],
  ["partial configuration", "https://web-fixture.supabase.co", ""],
  ["secret key", "https://web-fixture.supabase.co", "sb_secret_fixture"],
  ["service-role JWT", "https://web-fixture.supabase.co", `h.${btoa(JSON.stringify({ role: "service_role" }))}.s`],
  ["insecure hosted API", "http://web-fixture.supabase.co", "sb_publishable_fixture"],
]) {
  test(`production build fails closed with ${name}`, () => {
    assert.throws(() => configuration(url, key));
  });
}
test("production build accepts public-only configuration; unconfigured development still shows setup help", () => {
  assert.ok(configuration("https://web-fixture.supabase.co", "sb_publishable_fixture"));
  assert.ok(configuration("", "", "serve"));
});

test("production installs the final-artifact CSP plugin", () => {
  const config = configuration("https://web-fixture.supabase.co", "sb_publishable_fixture");
  const plugin = config.plugins.find((plugin) => plugin?.name === "production-csp");
  assert.equal(plugin.apply({}, { command: "build" }), true);
  assert.equal(plugin.apply({}, { command: "serve", isPreview: true }), true);
  assert.equal(plugin.apply({}, { command: "serve" }), false);
  assert.equal(plugin.generateBundle.order, "post");
  assert.equal(typeof plugin.configurePreviewServer, "function");
});

test("the displayed privacy version matches its gate and describes Google as the only sign-in", () => {
  const policy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
  assert.ok(policy.includes(`Version: ${PRIVACY_POLICY_VERSION}`));
  assert.ok(policy.includes("Google is the only way to sign in on this website, and Supabase handles Google sign-in"));
  assert.ok(!policy.includes("magic-link"));
  assert.ok(!policy.includes("Supabase handles email-and-password"));
  assert.ok(!/guest|start-up questions|prune:survey/i.test(policy));
});

test("public support surfaces do not publish a personal email or email contact link", () => {
  for (const path of ["../src/reviews/WeeklyReview.tsx", "../src/App.tsx", "../PRIVACY.md"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /mailto:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, path);
  }
});

test("HTML entry point contains no marketing trackers or remote executable dependencies", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!/googletagmanager|goatcounter|google-analytics|gc\.zgo\.at|vercel-scripts/i.test(html));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attributes] of scripts) {
    assert.match(attributes, /\bsrc="\/(?!\/)[^"]+"/);
  }
});
