import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import viteConfig from "../vite.config.ts";
import { PRIVACY_POLICY_VERSION } from "../src/cloud/privacy-state.ts";
import { SITE } from "../src/shared/site.ts";

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

test("the displayed privacy version matches its gate and describes guests, Do it for me, and sign-in only for sharing", () => {
  const policy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
  assert.ok(policy.includes(`Version: ${PRIVACY_POLICY_VERSION}`));
  assert.ok(policy.includes("There is no sign-up for the list. By adding a task, you accept these terms"));
  assert.ok(policy.includes("OpenRouter (OpenRouter, Inc., United States)"));
  assert.ok(!/Anthropic|Claude/.test(policy));
  assert.ok(policy.includes("to share a list or join a shared space, you sign in with Google or with a six-digit code"));
  assert.ok(!/three free answers/.test(policy));
  assert.ok(!/prune does not use AI/.test(policy));
  assert.ok(policy.includes("Supabase Auth creates a guest (an anonymous user) for this browser"));
  assert.ok(policy.includes("before your first task, prune sends nothing anywhere"));
  assert.ok(!/Continue with Google|Email me a code|magic-link|email-and-password/.test(policy));
  assert.ok(!/start-up questions|prune:survey|prune:tasks:v1/i.test(policy));
});

test("public support surfaces do not publish a personal email or email contact link", () => {
  for (const path of ["../src/tasks/components/MenuSheet.tsx", "../src/App.tsx", "../PRIVACY.md"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /mailto:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, path);
  }
});

test("HTML entry point contains no marketing trackers or remote executable dependencies", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!/googletagmanager|goatcounter|google-analytics|gc\.zgo\.at|vercel-scripts/i.test(html));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].filter(
    ([, attributes]) => attributes !== ' type="application/ld+json"',
  );
  assert.ok(scripts.length > 0);
  for (const [, attributes] of scripts) {
    assert.match(attributes, /\bsrc="\/(?!\/)[^"]+"/);
  }
});

test("HTML entry point describes the site with schema.org data at the canonical address", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const documents = [JSON.parse(blocks[0][1])].flat();
  for (const data of documents) assert.equal(data["@context"], "https://schema.org");
  const nodes = documents.flatMap((data) => data["@graph"] ?? [data]);
  const types = Object.fromEntries(nodes.map((node) => [node["@type"], node]));
  assert.ok(types.WebPage && types.WebApplication);
  assert.equal(types.WebApplication.name, SITE.name);
  assert.equal(types.WebPage.mainEntity["@id"], types.WebApplication["@id"]);
  for (const node of nodes) assert.equal(node.url, SITE.url);
  assert.match(html, new RegExp(`<meta property="og:url" content="${SITE.url}" />`));
});
