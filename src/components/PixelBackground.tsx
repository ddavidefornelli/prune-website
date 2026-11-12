import { createEffect, onCleanup, onMount } from "solid-js";
import { PLANNER_LIMITS } from "../planner/constants";
import {
  createPixelField,
  paintPixels,
  PIXEL_COLUMNS,
  PIXEL_COUNT,
  PIXEL_FRAME_INTERVAL,
  PIXEL_PALETTE,
  PIXEL_REVEAL_DURATION,
  PIXEL_ROWS,
  type PixelField,
} from "../shared/pixel-background";

export default function PixelBackground(props: { completionLevel: number }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const context = canvas.getContext("2d");
    if (!context) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const image = context.createImageData(PIXEL_COLUMNS, PIXEL_ROWS);
    const shades = new Uint8Array(PIXEL_COUNT);
    const painted = new Uint8Array(PIXEL_COUNT);
    const elapsed = [0, 0, 0, 0];
    const revealedAt = [0, Infinity, Infinity, Infinity];
    let field: PixelField | undefined;
    let level = 0;
    let pulseAt = -Infinity;
    let timer: number | undefined;
    let animationFrame: number | undefined;

    const stop = () => {
      window.clearTimeout(timer);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      timer = animationFrame = undefined;
    };

    const draw = () => {
      timer = animationFrame = undefined;
      if (document.hidden) return;
      // No field generation or painting until there is progress to display.
      if (level === 0 && !field) return;
      const now = performance.now();
      const reducedMotion = motion.matches;
      for (let tier = 1; tier < revealedAt.length; tier++) {
        elapsed[tier] = now - revealedAt[tier];
      }
      paintPixels((field ??= createPixelField()), shades, {
        level,
        time: now,
        elapsed,
        pulse: now - pulseAt,
        reducedMotion,
      });
      // Only cells whose brightness changed are rewritten, and a frame with
      // no change (a still, reduced-motion artwork) uploads nothing.
      let changed = false;
      for (let index = 0; index < PIXEL_COUNT; index++) {
        const shade = shades[index];
        if (shade === painted[index]) continue;
        painted[index] = shade;
        changed = true;
        const source = shade * 4;
        const target = index * 4;
        image.data[target] = PIXEL_PALETTE[source];
        image.data[target + 1] = PIXEL_PALETTE[source + 1];
        image.data[target + 2] = PIXEL_PALETTE[source + 2];
        image.data[target + 3] = PIXEL_PALETTE[source + 3];
      }
      if (changed) context.putImageData(image, 0, 0);
      // Reduced motion and an empty day get one frame with no recurring work.
      if (level === 0 || reducedMotion) return;
      // The wave after a completion runs at display rate for its few seconds;
      // the slow ambient light needs only 10 updates/second.
      if (now - pulseAt < PIXEL_REVEAL_DURATION) {
        animationFrame = requestAnimationFrame(draw);
      } else {
        timer = window.setTimeout(draw, PIXEL_FRAME_INTERVAL);
      }
    };

    const redraw = () => {
      stop();
      draw();
    };

    const syncLevel = () => {
      const next = Math.max(
        0,
        Math.min(PLANNER_LIMITS.tasksPerDay, Math.floor(props.completionLevel)),
      );
      if (next === level) return;
      const now = performance.now();
      for (let tier = 1; tier <= PLANNER_LIMITS.tasksPerDay; tier++) {
        if (tier > next) revealedAt[tier] = Infinity;
        else if (tier > level) revealedAt[tier] = now;
      }
      if (next > level) pulseAt = now;
      level = next;
      redraw();
    };

    createEffect(syncLevel);
    document.addEventListener("visibilitychange", redraw);
    motion.addEventListener("change", redraw);

    onCleanup(() => {
      stop();
      document.removeEventListener("visibilitychange", redraw);
      motion.removeEventListener("change", redraw);
    });
  });

  return (
    <div class="cyber-artwork" aria-hidden="true">
      {/* One canvas pixel per cell: the compositor does the scaling. */}
      <canvas
        class="pixel-grid"
        ref={(element) => (canvas = element)}
        width={PIXEL_COLUMNS}
        height={PIXEL_ROWS}
      />
    </div>
  );
}
