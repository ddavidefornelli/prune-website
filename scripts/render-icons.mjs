// Renders the icons from scripts/brand/prune-mark.svg. index.html links
// prune-icon.png and prune-touch-icon.png; favicon.png and apple-touch-icon.png
// are the same images at the names browsers and iOS look for by themselves.
// Browsers cache icons by URL for a long time: when the mark changes, rename
// the linked files (and update index.html and scripts/security-policy.ts). Run: node scripts/render-icons.mjs [outDir]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("./brand/prune-mark.svg", import.meta.url), "utf8");
const out = process.argv[2] ?? new URL("../public/", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size] of [["prune-icon.png", 64], ["favicon.png", 64], ["prune-touch-icon.png", 180], ["apple-touch-icon.png", 180], ["preview-512.png", 512]]) {
  if (name === "preview-512.png" && !process.argv[2]) continue;
  await page.setViewportSize({ width: size, height: size });
  // The touch icon is square: iOS rounds the corners itself.
  const body = size === 180 ? svg.replace('rx="116"', 'rx="0"') : svg;
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${body}`);
  await page.screenshot({ path: `${out}/${name}`, omitBackground: true });
}
await browser.close();
