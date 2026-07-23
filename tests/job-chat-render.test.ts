import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// SIM-599 / t-1784782689793, source contracts in the static-source idiom (no
// React render layer in this project - related-chips-ui.test.ts): a transcript
// message with a missing `content` (e.g. a payload persisted under another
// key) crashed the WHOLE app - MarkdownLite calls .replace on its text, and
// the job drawer used to mount OUTSIDE every ErrorBoundary, so the throw
// unmounted the full tree (white screen). Two contracts pin the fix:
//   1. JobChat renders m.content through a nullish-coalescing guard in BOTH
//      bubbles, so a malformed message degrades to an empty bubble.
//   2. App wraps JobDetailDrawer in an ErrorBoundary, so any FUTURE drawer
//      render crash is contained to the drawer surface, never the app.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("JobChat renders malformed transcript messages gracefully (SIM-599)", () => {
  const src = read("../src/components/JobChat.tsx");

  it("the assistant bubble guards m.content before it reaches MarkdownLite (which calls .replace)", () => {
    expect(src).toMatch(/<MarkdownLite text=\{m\.content \?\? ""\} \/>/);
  });

  it("the user bubble carries the same guard (an empty bubble, never a crash path)", () => {
    expect(src).toMatch(/<span className="whitespace-pre-wrap">\{m\.content \?\? ""\}<\/span>/);
  });
});

describe("the job drawer sits inside an ErrorBoundary (SIM-599)", () => {
  const src = read("../src/App.tsx");

  it("App wraps JobDetailDrawer in an ErrorBoundary so a drawer crash can no longer blank the app", () => {
    const drawerIdx = src.indexOf("<JobDetailDrawer");
    expect(drawerIdx).toBeGreaterThan(-1);
    // The nearest preceding boundary-open must be closer than the drawer's own
    // conditional mount - i.e. the boundary opens INSIDE `selectedJob && (`.
    const block = src.slice(src.indexOf("{selectedJob && ("), drawerIdx);
    expect(block).toContain("<ErrorBoundary");
  });
});
