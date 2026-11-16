// Renders public/favicon.png and public/apple-touch-icon.png from
// scripts/brand/prune-mark.svg. Run: node scripts/render-icons.mjs [outDir]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("./brand/prune-mark.svg", import.meta.url), "utf8");
const out = process.argv[2] ?? new URL("../public/", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size] of [["favicon.png", 64], ["apple-touch-icon.png", 180], ["preview-512.png", 512]]) {
  if (name === "preview-512.png" && !process.argv[2]) continue;
  await page.setViewportSize({ width: size, height: size });
  // The touch icon is square: iOS rounds the corners itself.
  const body = name === "apple-touch-icon.png" ? svg.replace('rx="116"', 'rx="0"') : svg;
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${body}`);
  await page.screenshot({ path: `${out}/${name}`, omitBackground: true });
}
await browser.close();
