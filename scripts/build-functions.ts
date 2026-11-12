import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { loadEnv } from "vite";
import { publicConfig } from "../src/planner/config.ts";

/** Package the /api/error-log Edge Function into Vercel Build Output. */
export function buildFunctions(destination = ".vercel/output", mode = "production"): void {
  const env = loadEnv(mode, process.cwd(), "VITE_SUPABASE_");
  const config = publicConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  const directory = resolve(destination, "functions/api/error-log.func");
  mkdirSync(directory, { recursive: true });
  buildSync({
    entryPoints: [resolve("server/error-log-entry.ts")],
    outfile: resolve(directory, "index.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: true,
    define: {
      __SUPABASE_URL__: JSON.stringify(config.url),
      __SUPABASE_PUBLIC_KEY__: JSON.stringify(config.publicKey),
    },
  });
  writeFileSync(
    resolve(directory, ".vc-config.json"),
    `${JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2)}\n`,
  );
}
