import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import { PublicConfig } from "./src/cloud/config.ts";
import { productionCsp } from "./scripts/csp-plugin.ts";

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // An unconfigured dev checkout can show setup help. A production artifact
  // must never silently ship a broken signup or a privileged credential.
  const config =
    command === "build" || env.VITE_SUPABASE_URL || env.VITE_SUPABASE_ANON_KEY
      ? PublicConfig.parse(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
      : null;
  // Dev stays relaxed for Vite's injected styles and HMR WebSocket. Build and
  // preview use the same hash-locked policy, derived from the final artifact.
  return {
    plugins: [
      solid(),
      productionCsp(config?.url ?? null, env.VITE_POSTHOG_HOST),
    ],
  };
});
