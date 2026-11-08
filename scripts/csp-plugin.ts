import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { hardenHtml } from "./security-policy.ts";

export function productionCsp(apiOrigin: string | null): Plugin {
  return {
    name: "production-csp",
    apply: (_config, { command, isPreview }) => command === "build" || !!isPreview,
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (!apiOrigin) throw new Error("Production CSP requires a configured backend.");
        const entry = bundle["index.html"];
        if (!entry || entry.type !== "asset") throw new Error("Production HTML is missing.");
        const assets = new Map<string, string | Uint8Array>();
        for (const [name, output] of Object.entries(bundle)) {
          if (output.type === "chunk") {
            // Hash-only CSP does not delegate trust to module loaders. Review
            // code splitting/import integrity before introducing more chunks.
            if (output.imports.length || output.dynamicImports.length) {
              throw new Error("Hash-locked CSP requires a self-contained JavaScript bundle.");
            }
            assets.set(name, output.code);
          } else {
            assets.set(name, output.source);
          }
        }
        const html = typeof entry.source === "string" ? entry.source : new TextDecoder().decode(entry.source);
        const hardened = hardenHtml(html, assets, apiOrigin);
        entry.source = hardened.html;
        this.emitFile({ type: "asset", fileName: "security-headers.json", source: JSON.stringify(hardened.headers, null, 2) });
      },
    },
    configurePreviewServer(server) {
      // Use the artifact, never the current environment: hashes and headers
      // must always describe the exact bytes being served.
      const headers = JSON.parse(readFileSync(resolve(server.config.root, server.config.build.outDir, "security-headers.json"), "utf8"));
      // HTTP loopback preview has no TLS listener. In particular, WebKit would
      // upgrade its local assets to HTTPS and make the preview unusable.
      if (!server.config.preview.https) {
        headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace("; upgrade-insecure-requests", "");
      }
      const html = readFileSync(resolve(server.config.root, server.config.build.outDir, "index.html"));
      server.middlewares.use((request, response, next) => {
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, String(value));
        const path = request.url?.split("?")[0] ?? "/";
        if (["GET", "HEAD"].includes(request.method ?? "") && /^\/(?:index\.html|download\/?|login\/?)?$/.test(path)) {
          // Serve the exact document ourselves: Vite's HTML middleware would
          // overwrite Cache-Control with no-cache rather than no-store.
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(request.method === "HEAD" ? undefined : html);
          return;
        }
        next();
      });
    },
  };
}
