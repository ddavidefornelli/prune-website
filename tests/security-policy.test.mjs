import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANALYTICS_SCRIPTS, ANALYTICS_CONNECTIONS, ERROR_LOG_CONNECTIONS, CONTENTSQUARE_SCRIPTS, CONTENTSQUARE_CONNECTIONS, CONTENTSQUARE_IMAGES, CONTENTSQUARE_RESOURCES, API_PATHS, hardenHtml, integrity, securityHeaders } from "../scripts/security-policy.ts";
import { productionCsp } from "../scripts/csp-plugin.ts";
import { buildVercel } from "../scripts/build-vercel.ts";

const origin = "https://web-fixture.supabase.co";
const script = "console.log('trusted build');";
const css = "body { color: white; }";
const assets = new Map([["assets/app.js", script], ["assets/app.css", css]]);
const entry = '<html><head><script type="module" crossorigin src="/assets/app.js"></script><link rel="stylesheet" crossorigin href="/assets/app.css"></head><body></body></html>';
const directives = (policy) => Object.fromEntries(policy.split(";").map((part) => {
  const [name, ...sources] = part.trim().split(/\s+/);
  return [name, sources.join(" ")];
}));

test("CSP and SRI use hashes of exact emitted bytes, with explicit managed analytics exceptions", () => {
  const built = hardenHtml(entry, assets, origin);
  const expected = `sha384-${createHash("sha384").update(script).digest("base64")}`;
  const csp = directives(built.headers["Content-Security-Policy"]);
  assert.equal(csp["script-src"], `'${expected}' ${[...ANALYTICS_SCRIPTS, ...CONTENTSQUARE_SCRIPTS].join(" ")}`);
  assert.ok(built.html.includes(`<script integrity="${expected}"`));
  assert.ok(built.html.includes(`<link integrity="${integrity(css)}"`));
  assert.ok(built.html.indexOf("http-equiv=") < built.html.indexOf("<script"));
  assert.equal(csp["connect-src"], [...API_PATHS.map((path) => `${origin}${path}`), ...ERROR_LOG_CONNECTIONS, ...ANALYTICS_CONNECTIONS, ...CONTENTSQUARE_CONNECTIONS, ...CONTENTSQUARE_RESOURCES].join(" "));
  // Replay may read static files from the site, never its same-origin API.
  assert.ok(CONTENTSQUARE_RESOURCES.every((source) => /^https:\/\/(?:www\.)?prune\.win\/(?:assets\/|fonts\/|[\w-]+\.(?:png|webp))$/.test(source)));
  assert.ok(!csp["connect-src"].split(" ").includes("'self'"));
  assert.equal(csp["img-src"], `'self' ${CONTENTSQUARE_IMAGES.join(" ")}`);
  for (const sources of Object.values(csp)) {
    for (const source of sources.split(" ")) {
      if (source.includes("*")) assert.match(source, /^https:\/\/\*\.contentsquare\.(net|com)$/);
    }
  }
  assert.ok(!built.headers["Content-Security-Policy"].includes("unsafe-"));
  assert.equal(csp["style-src"], "'self'");
  assert.equal(csp["font-src"], "'self'");
  for (const name of ["default-src", "script-src-attr", "style-src-attr", "object-src", "child-src", "frame-src", "worker-src", "base-uri", "form-action", "manifest-src", "media-src", "frame-ancestors"]) {
    assert.equal(csp[name], "'none'", name);
  }
  assert.ok(!built.html.includes("frame-ancestors"), "HTTP-only directives do not belong in meta");
  assert.equal(built.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(built.headers["X-Frame-Options"], "DENY");
  assert.equal(built.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(built.headers["Referrer-Policy"], "no-referrer");
  assert.equal(built.headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.match(built.headers["Strict-Transport-Security"], /max-age=31536000/);
});

test("build changes rotate the script allowlist automatically", () => {
  const changed = hardenHtml(entry, new Map([...assets, ["assets/app.js", `${script}\n`]]), origin);
  assert.notEqual(changed.headers["Content-Security-Policy"], hardenHtml(entry, assets, origin).headers["Content-Security-Policy"]);
});

test("CSP generation fails closed for missing assets, inline scripts/styles or insecure backends", () => {
  for (const html of [
    entry.replace("/assets/app.js", "https://cdn.invalid/app.js"),
    entry.replace("/assets/app.js", "/assets/missing.js"),
    entry.replace("/assets/app.css", "/assets/missing.css"),
    entry.replace("</head>", "<script>alert(1)</script></head>"),
    entry.replace("</head>", "<style>body{display:none}</style></head>"),
    entry.replace("<body>", '<body onload="alert(1)">'),
    entry.replace("<body>", '<body style="display:none">'),
    "<html><head></head></html>",
  ]) assert.throws(() => hardenHtml(html, assets, origin));
  for (const url of ["http://project.supabase.co", "http://localhost:54321", `${origin}/`, `${origin}/path`]) {
    assert.throws(() => securityHeaders(url, [integrity(script)]));
  }
});

test("generated asset tags reject ambiguous URLs, duplicate/unknown attributes and credentialed loads", () => {
  for (const html of [
    entry.replace('src="/assets/app.js"', 'data-src="/assets/app.js"'),
    entry.replace('src="/assets/app.js"', 'src="/assets/app.js" src="/assets/app.js"'),
    entry.replace('src="/assets/app.js"', 'src="/assets/app.js?changed=1"'),
    entry.replace('src="/assets/app.js"', 'src="&#47;assets/app.js"'),
    entry.replace('src="/assets/app.js"', 'src="/assets/app.js" data-integrity="ignored"'),
    entry.replace('crossorigin src=', 'crossorigin="use-credentials" src='),
    entry.replace('type="module"', 'type="text/javascript"'),
    entry.replace('href="/assets/app.css"', 'data-href="/assets/app.css"'),
    entry.replace('rel="stylesheet"', "rel='stylesheet'"),
    entry.replace('rel="stylesheet"', 'rel="style&#115;heet"'),
    entry.replace('rel="stylesheet"', 'rel="modulepreload"'),
    entry.replace('</head>', '<base href="https://untrusted.invalid/"></head>'),
    entry.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src *"></head>'),
  ]) assert.throws(() => hardenHtml(html, assets, origin));
});

test("packaging revalidates complete HTML, styles, SRI and a single matching meta policy", () => {
  const built = hardenHtml(entry, assets, origin);
  assert.deepEqual(hardenHtml(built.html, assets, origin, { verify: true }), built);
  for (const html of [
    built.html.replace('</script>', 'globalThis.injected = true;</script>'),
    built.html.replace('<body>', '<body onload="globalThis.injected = true">'),
    built.html.replace('</head>', '<style>body{display:none}</style></head>'),
    built.html.replace("default-src 'none'", "default-src 'self'"),
    built.html.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src *"></head>'),
    built.html.replace(/ integrity="[^"]+"/, ''),
  ]) assert.throws(() => hardenHtml(html, assets, origin, { verify: true }));
  for (const path of ["assets/app.js", "assets/app.css"]) {
    assert.throws(() => hardenHtml(built.html, new Map([...assets, [path, "modified bytes"]]), origin, { verify: true }), /integrity/);
  }
});

test("final HTML and bundle bytes fail closed on known tracking integrations", () => {
  assert.throws(() => hardenHtml(entry.replace('</body>', '<script src="https://gc.zgo.at/count.js"></script></body>'), assets, origin), /tracker/);
  for (const tracker of ['gtag("config", "fixture");', 'window.dataLayer = [];', 'fetch("/_vercel/speed-insights/view");']) {
    assert.throws(() => hardenHtml(entry, new Map([...assets, ["assets/app.js", tracker]]), origin), /tracker/);
  }
  assert.ok(hardenHtml(entry.replace('</body>', 'Google Ads and GoatCounter are not loaded.</body>'), assets, origin));
});

test("code splitting fails closed instead of weakening hash-only CSP", () => {
  const plugin = productionCsp(origin);
  for (const field of ["imports", "dynamicImports"]) {
    const chunk = { type: "chunk", code: script, imports: [], dynamicImports: [], [field]: ["other.js"] };
    const bundle = { "index.html": { type: "asset", source: entry }, "assets/app.js": chunk };
    assert.throws(() => plugin.generateBundle.handler.call({}, {}, bundle), /self-contained/);
  }
});

test("Vercel packages the exact built headers with static files and both download routes", () => {
  const temp = mkdtempSync(join(tmpdir(), "prune-csp-"));
  try {
    const source = join(temp, "dist");
    const output = join(temp, "output");
    mkdirSync(join(source, "assets"), { recursive: true });
    for (const [name, content] of assets) writeFileSync(join(source, name), content);
    const built = hardenHtml(entry, assets, origin);
    writeFileSync(join(source, "index.html"), built.html);
    writeFileSync(join(source, "security-headers.json"), JSON.stringify(built.headers));
    buildVercel(source, output);
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8"));
    assert.equal(config.version, 3);
    assert.deepEqual(config.routes[0], { src: "/(.*)", headers: built.headers, continue: true });
    const rewrite = config.routes.find((route) => route.dest === "/index.html");
    assert.ok(new RegExp(rewrite.src).test("/download"));
    assert.ok(new RegExp(rewrite.src).test("/download/"));
    assert.ok(!new RegExp(rewrite.src).test("/download/unexpected"));
    assert.equal(readFileSync(join(output, "static/index.html"), "utf8"), built.html);
    assert.equal(existsSync(join(output, "static/security-headers.json")), false);
    const cacheRule = config.routes.find((route) => route.headers?.["Cache-Control"]);
    for (const path of ["/", "/index.html", "/download", "/download/", "/login", "/login/"]) assert.ok(new RegExp(cacheRule.src).test(path));

    writeFileSync(join(source, "assets/app.js"), `${script}\n// changed after hashing`);
    assert.throws(() => buildVercel(source, output), /integrity/);
    writeFileSync(join(source, "assets/app.js"), script);
    const weakened = { ...built.headers, "Content-Security-Policy": built.headers["Content-Security-Policy"].replace("script-src ", "script-src 'self' ") };
    writeFileSync(join(source, "security-headers.json"), JSON.stringify(weakened));
    assert.throws(() => buildVercel(source, output), /security policy/);
    writeFileSync(join(source, "security-headers.json"), JSON.stringify(built.headers));
    writeFileSync(join(source, "index.html"), entry);
    assert.throws(() => buildVercel(source, output), /integrity/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
