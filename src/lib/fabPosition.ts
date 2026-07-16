// Pure geometry + persistence helpers for the draggable chat-capture FAB
// (t-1783256152026). DOM-free and side-effect-free so they unit-test node-env
// style (tests/fabPosition.test.ts), the same model as lib/shortcuts.ts - the
// pointer-event wiring, localStorage IO, and rendering live in ChatCapture;
// only the decisions (clamp, click-vs-drag, parse) live here.

// A stored/derived FAB position: the button's top-left corner, px from the
// viewport's top-left. Absent (null at the call sites) means "never dragged" -
// the FAB stays on its CSS default home (bottom-6 left-6).
export interface FabPoint {
  x: number;
  y: number;
}

export interface FabViewport {
  width: number;
  height: number;
}

// The FAB is h-14 w-14 (56px) - comfortably over the 44px tap-target floor.
export const FAB_SIZE = 56;

// Minimum clearance kept between the FAB and every viewport edge.
export const FAB_MARGIN = 8;

// Movement under this many px within one pointer gesture is a CLICK (open the
// panel); at or beyond it, the gesture is a drag and the click is suppressed.
export const DRAG_THRESHOLD_PX = 5;

// The bottom strip reserved for the RunDock (chips are min-h-[44px] plus the
// dock's own padding and rounded top). A dragged FAB may not come to REST
// overlapping this band...
export const DOCK_BAND_HEIGHT = 64;

// ...except inside the FAB's home corridor on the far left, which the centered
// dock (RunDock: left-1/2 -translate-x-1/2, max-w 760px) does not occupy on any
// but the narrowest screens. This keeps the default bottom-left home position
// (x=24, width 56 => right edge 80) legal, matching today's layout.
export const DOCK_CORRIDOR_WIDTH = 96;

// Click-vs-drag disambiguation: total pointer displacement within the gesture.
export function isDragGesture(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

// Clamp a (proposed or restored) position fully into the viewport, honoring
// the edge margin and the reserved RunDock band. Applied on every drag move,
// on drag end (the persisted value), on localStorage restore, and on window
// resize - so a stale saved position can never strand the FAB off-screen or
// under the dock.
export function clampFabPosition(pos: FabPoint, viewport: FabViewport, size = FAB_SIZE): FabPoint {
  const maxX = Math.max(FAB_MARGIN, viewport.width - size - FAB_MARGIN);
  const maxY = Math.max(FAB_MARGIN, viewport.height - size - FAB_MARGIN);
  const x = Math.min(Math.max(pos.x, FAB_MARGIN), maxX);
  let y = Math.min(Math.max(pos.y, FAB_MARGIN), maxY);
  // Keep the bottom-center/right band clear for the RunDock's chips; a FAB
  // dropped there lifts to sit just above the strip.
  const bandTop = viewport.height - DOCK_BAND_HEIGHT;
  if (x + size > DOCK_CORRIDOR_WIDTH && y + size > bandTop) {
    y = Math.max(FAB_MARGIN, bandTop - size);
  }
  return { x, y };
}

// localStorage round-trip. Serialize rounds to whole px (subpixel noise from
// pointer deltas is meaningless across sessions); parse trusts NOTHING - a
// corrupt/partial/legacy blob or a non-finite coordinate (JSON.parse turns
// "1e999" into Infinity) degrades to null, which means "use the CSS default".
export function serializeFabPosition(pos: FabPoint): string {
  return JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) });
}

export function parseFabPosition(raw: string | null): FabPoint | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      const { x, y } = v as { x?: unknown; y?: unknown };
      if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
        return { x, y };
      }
    }
  } catch {
    /* corrupt blob -> default position */
  }
  return null;
}
