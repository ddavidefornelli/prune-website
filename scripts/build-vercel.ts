import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenHtml } from "./security-policy.ts";

/** Package immutable bytes + their headers together via Vercel Build Output API. */
export function buildVercel(source = "dist", destination = ".vercel/output"): void {
  const headers = JSON.parse(readFileSync(resolve(source, "security-headers.json"), "utf8"));
  const html = readFileSync(resolve(source, "index.html"), "utf8");
  const assets = new Map<string, string | Uint8Array>();
  for (const name of readdirSync(resolve(source, "assets"))) {
    if (/\.(?:js|css)$/.test(name)) assets.set(`assets/${name}`, readFileSync(resolve(source, "assets", name)));
  }
  const backend = /(?:^|; )connect-src (https:\/\/[^/\s;]+)\//.exec(headers["Content-Security-Policy"] ?? "")?.[1];
  // Reuse the build contract, including full script bodies/attributes, tracker
  // denial, CSS integrity and meta agreement. Checking only opening script tags
  // would miss executable content introduced after the Vite build.
  const expected = backend && hardenHtml(html, assets, backend, { verify: true }).headers;
  if (!expected || Object.keys(headers).length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, value]) => headers[name] !== value)) {
    throw new Error("Refusing to package a missing, weakened or mismatched HTTP security policy.");
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, resolve(destination, "static"), { recursive: true });
  // Security metadata belongs to the deployment, not the public document tree.
  rmSync(resolve(destination, "static/security-headers.json"));
  const config = {
    version: 3,
    routes: [
      { src: "/(.*)", headers, continue: true },
      // Never cache HTML independently from the deployment's hash policy.
      { src: "^/(?:index\\.html|download/?|login/?)?$", headers: { "Cache-Control": "no-store" }, continue: true },
      { src: "^/(?:download|login)/?$", dest: "/index.html" },
      { handle: "filesystem" },
    ],
  };
  writeFileSync(resolve(destination, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildVercel();
