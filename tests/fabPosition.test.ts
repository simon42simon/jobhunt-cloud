import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DOCK_BAND_HEIGHT,
  DOCK_CORRIDOR_WIDTH,
  DRAG_THRESHOLD_PX,
  FAB_MARGIN,
  FAB_SIZE,
  clampFabPosition,
  isDragGesture,
  parseFabPosition,
  serializeFabPosition,
} from "../src/lib/fabPosition";

// Draggable chat-capture FAB (t-1783256152026). The geometry / persistence
// decisions are pure (lib/fabPosition) and unit-tested here; the pointer-event
// wiring in ChatCapture is pinned as a source contract, the
// related-chips-ui.test.ts idiom (no React render layer in this project).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const vp = { width: 1280, height: 800 };

describe("clampFabPosition", () => {
  it("leaves an in-bounds position untouched", () => {
    expect(clampFabPosition({ x: 300, y: 300 }, vp)).toEqual({ x: 300, y: 300 });
  });

  it("clamps every edge to the margin", () => {
    // Off-screen top-left.
    expect(clampFabPosition({ x: -50, y: -50 }, vp)).toEqual({ x: FAB_MARGIN, y: FAB_MARGIN });
    // Off-screen right: max x = width - size - margin.
    expect(clampFabPosition({ x: 5000, y: 300 }, vp).x).toBe(vp.width - FAB_SIZE - FAB_MARGIN);
  });

  it("keeps the FAB's DEFAULT bottom-left home legal (inside the left corridor)", () => {
    // The CSS default is bottom-6 left-6 => x=24, y=height-24-56. The corridor
    // exists exactly so the home position never gets shoved around by the
    // dock reservation.
    const home = { x: 24, y: vp.height - 24 - FAB_SIZE };
    expect(home.x + FAB_SIZE).toBeLessThanOrEqual(DOCK_CORRIDOR_WIDTH);
    expect(clampFabPosition(home, vp)).toEqual(home);
  });

  it("lifts a bottom-center/right drop above the RunDock band", () => {
    const bandTop = vp.height - DOCK_BAND_HEIGHT;
    // Dropped dead-center on the dock strip.
    const center = clampFabPosition({ x: 600, y: vp.height - FAB_SIZE }, vp);
    expect(center.y + FAB_SIZE).toBeLessThanOrEqual(bandTop);
    expect(center.x).toBe(600);
    // Dropped bottom-right (where expanded run panels + the dock live).
    const right = clampFabPosition({ x: 5000, y: 5000 }, vp);
    expect(right.y + FAB_SIZE).toBeLessThanOrEqual(bandTop);
  });

  it("never returns a coordinate below the margin even on a tiny viewport", () => {
    const tiny = clampFabPosition({ x: 500, y: 500 }, { width: 40, height: 40 });
    expect(tiny.x).toBe(FAB_MARGIN);
    expect(tiny.y).toBe(FAB_MARGIN);
  });
});

describe("isDragGesture (click-vs-drag disambiguation)", () => {
  it("movement under the threshold stays a click", () => {
    expect(isDragGesture(0, 0)).toBe(false);
    expect(isDragGesture(3, 3)).toBe(false); // hypot ~4.24 < 5
    expect(isDragGesture(-4, 0)).toBe(false);
  });

  it("movement at/over the threshold is a drag, in any direction", () => {
    expect(isDragGesture(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(isDragGesture(0, -6)).toBe(true);
    expect(isDragGesture(-4, -4)).toBe(true); // hypot ~5.66
  });
});

describe("parse/serialize round-trip (localStorage persistence)", () => {
  it("round-trips a position, rounded to whole px", () => {
    expect(parseFabPosition(serializeFabPosition({ x: 123.6, y: 45.2 }))).toEqual({ x: 124, y: 45 });
  });

  it("rejects everything that is not a finite {x,y} blob", () => {
    expect(parseFabPosition(null)).toBeNull();
    expect(parseFabPosition("")).toBeNull();
    expect(parseFabPosition("not json")).toBeNull();
    expect(parseFabPosition('"a string"')).toBeNull();
    expect(parseFabPosition("[1,2]")).toBeNull(); // array has no x/y keys
    expect(parseFabPosition('{"x":10}')).toBeNull(); // partial
    expect(parseFabPosition('{"x":"10","y":20}')).toBeNull(); // stringly typed
    expect(parseFabPosition('{"x":1e999,"y":0}')).toBeNull(); // Infinity
  });
});

// --- Source contracts: the ChatCapture FAB wiring --------------------------

describe("ChatCapture FAB drag wiring (source contract)", () => {
  const src = read("../src/components/ChatCapture.tsx");

  it("drives the drag with pointer events (mouse + touch) and pointer capture", () => {
    expect(src).toContain("onPointerDown={");
    expect(src).toContain("onPointerMove={");
    expect(src).toContain("onPointerUp={");
    expect(src).toContain("onPointerCancel={");
    expect(src).toContain("setPointerCapture(");
  });

  it("clamps through the pure lib on move/end/restore and re-clamps on window resize", () => {
    expect(src).toContain("clampFabPosition(");
    expect(src).toMatch(/addEventListener\("resize"/);
  });

  it("persists the position under the namespaced key and restores via the tolerant parser", () => {
    expect(src).toContain('"jobhunt.chatCapture.fabPosition"');
    expect(src).toContain("parseFabPosition(");
    expect(src).toContain("serializeFabPosition(");
  });

  it("suppresses the synthetic click after a drag, so a drag never opens the panel", () => {
    expect(src).toContain("isDragGesture(");
    expect(src).toMatch(/suppressFabClick/);
  });

  it("stays a keyboard-activatable 44px+ button (drag is pointer-only sugar)", () => {
    // Still a plain <button> with the same accessible name and 56px box;
    // touch-none stops touch-drag from scrolling the page instead.
    expect(src).toContain('aria-label="Report a bug or request (opens chat capture)"');
    expect(src).toMatch(/h-14 w-14[^"]*touch-none|touch-none[^"]*h-14 w-14/);
  });
});
