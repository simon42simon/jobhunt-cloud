import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bug t-1783371570597: "I submitted the ticket (Queue & delegate now) but when I
// closed and reopened it the chat was still here." Root cause: closePanel() reset
// the compose form only when `step === "done"`, but "Queue & delegate now" files
// the ticket and parks on the "confirm" step. Closing there (X / Esc / backdrop)
// skipped the reset, so the already-submitted text survived to the next open and
// could be re-filed as a duplicate.
//
// Fix: one resetForm() helper, and closePanel() resets whenever a ticket was
// ALREADY filed this session (createdTask non-null - true on BOTH "confirm" and
// "done"), while a genuinely unsent draft (createdTask null) is preserved. There
// is no React render layer in this project, so the behaviour is pinned as a
// source contract (the chatcapture-esc.test.ts / related-chips-ui.test.ts idiom).

const src = readFileSync(
  fileURLToPath(new URL("../src/components/ChatCapture.tsx", import.meta.url)),
  "utf8",
);

describe("ChatCapture compose-form reset (source contract)", () => {
  it("has one shared resetForm() helper that clears the composed report + filed state", () => {
    const body = src.slice(src.indexOf("function resetForm()"), src.indexOf("function closePanel()"));
    expect(body).toContain("function resetForm()");
    for (const call of [
      'setText("")',
      'setTaskType("")',
      'setPriority("")',
      "setCreatedTask(null)",
      'setOutcome({ kind: "none" })',
      "clearPendingImages()",
      "setAttachNote(null)",
    ]) {
      expect(body, call).toContain(call);
    }
  });

  it("closePanel resets on createdTask (covers the confirm step), NOT only step===done", () => {
    const body = src.slice(src.indexOf("function closePanel()"), src.indexOf("function fileAnother()"));
    // The reset now fires whenever a ticket was filed this session...
    expect(body).toMatch(/if \(createdTask\) \{[\s\S]*resetForm\(\)/);
    // ...and the old, too-narrow guard is gone.
    expect(body).not.toContain('if (step === "done")');
  });

  it("closePanel PRESERVES a genuinely unsent draft (createdTask null) but still discards orphan images", () => {
    const body = src.slice(src.indexOf("function closePanel()"), src.indexOf("function fileAnother()"));
    // The else branch keeps the composed text (no setText("")) yet still clears
    // pasted-but-unuploaded images.
    expect(body).toMatch(/\} else \{[\s\S]*clearPendingImages\(\);[\s\S]*setAttachNote\(null\);[\s\S]*\}/);
    const elseBranch = body.slice(body.indexOf("} else {"));
    expect(elseBranch).not.toContain('setText("")');
  });

  it("fileAnother routes through the same resetForm (paths cannot drift)", () => {
    const body = src.slice(src.indexOf("function fileAnother()"));
    const fn = body.slice(0, body.indexOf("\n  }") + 4);
    expect(fn).toContain("resetForm()");
    // It no longer re-implements the field clears inline.
    expect(fn).not.toContain('setText("")');
  });
});
