import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// SIM-577: JobChat's client-side half of the honest-degradation fix. The
// server (server/index.js POST /api/jobs/:id/chat) now gates on the SAME
// CLAUDE_BIN_PRESENT fact the SIM-425 DEMO_MODE gate already used, returning
// the identical { disabled, reason, messages } shape for a real, non-demo
// instance with no local claude binary to spawn. This file pins the client
// contract: `unavailableReason` collapses with `demoMode` into one `offReason`
// so every existing demoMode disabling behavior (compose box, banner,
// placeholder) also covers the new case, and a disabled POST response is
// surfaced as a plain notice - never the rose error styling used for genuine
// failures. There is no React render layer in this project (the
// chatcapture-reset.test.ts idiom), so the behavior is pinned as a source
// contract.

const src = readFileSync(
  fileURLToPath(new URL("../src/components/JobChat.tsx", import.meta.url)),
  "utf8",
);

describe("JobChat honest-degradation (source contract)", () => {
  it("accepts unavailableReason and derives one offReason shared with demoMode", () => {
    expect(src).toContain("unavailableReason = null");
    expect(src).toContain(
      'const offReason = demoMode ? "The live assistant is turned off in the hosted demo." : unavailableReason;',
    );
  });

  it("every demoMode disabling site now gates on offReason, not the old demoMode-only checks", () => {
    // The banner, textarea, and send button all key off offReason - so the
    // SIM-577 case gets the exact same treatment (box disabled, banner shown,
    // send() guarded) as the SIM-425 demo case, with zero duplicated branches.
    expect(src).toContain("{offReason &&");
    expect(src).toContain("disabled={!!offReason}");
    expect(src).toContain("disabled={!!offReason || sending || !input.trim()}");
    expect(src).toContain("if (!text || sending || offReason) return;");
    // The old demoMode-only guards are gone, not just duplicated alongside offReason.
    expect(src).not.toContain("if (!text || sending || demoMode) return;");
    expect(src).not.toMatch(/disabled=\{demoMode\b/);
  });

  it("a disabled POST response sets a plain notice, never the rose error state", () => {
    const fn = src.slice(src.indexOf("async function send()"), src.indexOf("function onKeyDown"));
    expect(fn).toContain('if ("disabled" in r && r.disabled) setNotice(r.reason);');
    // notice renders separately from err, with neutral (not rose-400) styling.
    expect(src).toMatch(/\{notice && <p className="[^"]*text-\[#7a869d\][^"]*">\{notice\}<\/p>\}/);
    expect(src).toMatch(/\{err && <div className="[^"]*text-rose-400[^"]*">\{err\}<\/div>\}/);
  });
});
