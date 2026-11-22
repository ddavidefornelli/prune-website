import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

const OUT = process.env.AUDIT_OUT;
if (!OUT) throw new Error("Set AUDIT_OUT to the directory that receives the snapshots.");

/**
 * Runs in the page. Serializes everything a visitor can perceive through the
 * DOM, in a form that ignores only what they cannot: comment markers,
 * attribute order, class-token order and the numbering of generated ids.
 */
async function canonicalize(options: { canvas?: boolean }): Promise<string> {
  const ids = new Map<string, string>();
  const uid = (value: string) =>
    value.replace(/\bcl-\d+\b/g, (match) => {
      if (!ids.has(match)) ids.set(match, `uid-${ids.size}`);
      return ids.get(match)!;
    });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const out: string[] = [
    `title: ${document.title}`,
    `url: ${location.pathname}${location.search}${location.hash}`,
    `scroll: ${Math.round(scrollX)},${Math.round(scrollY)}`,
  ];
  const hashes = new Map<Element, string>();
  if (options.canvas) {
    for (const canvas of document.querySelectorAll("canvas")) {
      const bytes = new TextEncoder().encode(canvas.toDataURL());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      hashes.set(
        canvas,
        Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
      );
    }
  }
  // The landing demo's clock ticks once a second outside reduced motion.
  const ticking = (element: Element) => !reduced && !!element.closest(".mock-timer");

  function describe(element: Element): string {
    const parts: string[] = [];
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name;
      let value = attribute.value;
      if (name === "class") {
        value = [...new Set(value.split(/\s+/).filter(Boolean))].sort().join(" ");
        if (!value) continue;
      } else if (name === "style") {
        value = value
          .split(";")
          .map((declaration) => declaration.trim())
          .filter(Boolean)
          .sort()
          .join("; ");
        if (!value) continue;
      } else if (["id", "for", "aria-labelledby", "aria-describedby", "aria-controls"].includes(name)) {
        value = uid(value);
      }
      if (name === "stroke-dashoffset" && ticking(element)) value = "<ticking>";
      parts.push(`${name}=${JSON.stringify(value)}`);
    }
    parts.sort();
    if (element instanceof HTMLInputElement) {
      parts.push(`:value=${JSON.stringify(element.value)}`);
      if (element.type === "checkbox" || element.type === "radio")
        parts.push(`:checked=${element.checked}`);
    }
    if (element instanceof HTMLTextAreaElement)
      parts.push(`:value=${JSON.stringify(element.value)}`);
    if (element instanceof HTMLDialogElement)
      parts.push(`:modal=${element.matches(":modal")}`);
    if ("validationMessage" in element && (element as HTMLInputElement).validationMessage)
      parts.push(`:invalid=${JSON.stringify((element as HTMLInputElement).validationMessage)}`);
    if (element === document.activeElement) parts.push(":focus");
    const hash = hashes.get(element);
    if (hash) parts.push(`:pixels=${hash}`);
    return `<${element.localName}${parts.length ? ` ${parts.join(" ")}` : ""}>`;
  }

  function walk(node: Node, depth: number): void {
    const indent = "  ".repeat(depth);
    let text = "";
    const flush = () => {
      if (text) out.push(`${indent}${JSON.stringify(text)}`);
      text = "";
    };
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child as Text).data;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      if (element.localName === "script" || element.localName === "style") continue;
      flush();
      out.push(`${indent}${describe(element)}`);
      if (element.matches(".timer-digits") && ticking(element)) {
        out.push(`${indent}  "<ticking>"`);
        continue;
      }
      // A textarea's children are its default value, already recorded above.
      if (element instanceof HTMLTextAreaElement) continue;
      walk(element, depth + 1);
    }
    flush();
  }

  walk(document.body, 0);
  return `${out.join("\n")}\n`;
}

/**
 * Waits for fonts, for the planner's entrance animations and for two frames.
 * The tour measures its target, so an element still sliding in would be
 * recorded at an arbitrary point of its animation; once it rests, a resize
 * event makes the tour measure again.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const app = document.getElementById("app");
    if (app) {
      const finite = app.getAnimations({ subtree: true }).filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
      await Promise.all(finite.map((animation) => animation.finished.catch(() => null)));
      window.dispatchEvent(new Event("resize"));
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
    );
  });
}

export type Snap = (name: string, options?: { canvas?: boolean }) => Promise<void>;

export function snapper(
  page: Page,
  testInfo: TestInfo,
  idle: () => Promise<void>,
): Snap {
  let index = 0;
  const slug = testInfo.titlePath
    .slice(1)
    .join(" ")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const directory = join(OUT!, testInfo.project.name, slug);
  mkdirSync(directory, { recursive: true });
  return async (name, options = {}) => {
    await idle();
    await settle(page);
    await idle();
    await settle(page);
    const text = await page.evaluate(canonicalize, options);
    index += 1;
    writeFileSync(join(directory, `${String(index).padStart(2, "0")}-${name}.txt`), text);
  };
}
