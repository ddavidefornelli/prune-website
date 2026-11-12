import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVercel } from "./build-vercel.ts";
import { buildFunctions } from "./build-functions.ts";
import { checkDeployment, printDeploymentResult } from "./check-deployment.mjs";

function compile() {
  const npm = process.env.npm_execpath;
  const result = npm
    ? spawnSync(process.execPath, [npm, "run", "build"], { stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status;
}

/** A failed build/check must not leave an older --prebuilt deployable behind. */
export async function buildRelease({ source = "dist", destination = ".vercel/output", runBuild = compile, onResult = printDeploymentResult, packageFunctions = buildFunctions } = {}) {
  rmSync(destination, { recursive: true, force: true });
  try {
    if (runBuild() !== 0) throw new Error("Production compilation failed; no deployable output was retained.");
    buildVercel(source, destination);
    packageFunctions(destination);
    const report = await checkDeployment(destination, onResult);
    if (report.exitCode !== 0) throw new Error("Packaged deployment failed security checks; no deployable output was retained.");
    return report;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await buildRelease();
    console.log(`\nVerified Vercel package: ${report.counts.PASS} security checks passed. This has NOT deployed or verified the live website.`);
  } catch (error) {
    console.error(`Release build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
