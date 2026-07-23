import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// SIM-577: the ChatCapture assessment leg. "Queue it" auto-fires the
// comment-only assess-ticket routine; before this fix, a report with no CTO
// comment yet ALWAYS rendered the "Awaiting CTO assessment..." spinner, even
// on an instance that can never spawn assess-ticket at all (no local claude
// binary, and ticket-scoped routines are deliberately excluded from runner
// routing - server/index.js startRun). The spinner then never resolved -
// nothing in the app's state model distinguished "genuinely pending" from
// "structurally impossible here". The fix threads GET /api/config's
// agentSpawnAvailable (App -> agentAssessmentAvailable prop) into
// renderReportRow so the SAME per-row branch that already reads whether a CTO
// comment exists also reads whether one can ever arrive - response-only,
// derived from an existing fact, no new persisted state (the SIM-562/
// queuedRunnerView pattern). There is no React render layer in this project
// (the chatcapture-reset.test.ts idiom), so the behavior is pinned as a
// source contract.

const src = readFileSync(
  fileURLToPath(new URL("../src/components/ChatCapture.tsx", import.meta.url)),
  "utf8",
);

describe("ChatCapture assessment-spinner honesty (source contract)", () => {
  it("accepts agentAssessmentAvailable, defaulting to available (optimistic before config loads)", () => {
    expect(src).toContain("agentAssessmentAvailable = true");
    expect(src).toContain("agentAssessmentAvailable?: boolean;");
  });

  it("renderReportRow's no-comment branch resolves honestly instead of spinning forever when unavailable", () => {
    const body = src.slice(src.indexOf("function renderReportRow"), src.indexOf("return (\n    <>"));
    // Three-way branch: a CTO comment already landed -> show it; no comment yet
    // but this instance CAN still produce one -> the (unchanged) spinner; no
    // comment AND this instance never can -> an honest terminal message, not a
    // third spinner variant.
    expect(body).toMatch(/\{cto \? \([\s\S]*\) : agentAssessmentAvailable \? \([\s\S]*Awaiting CTO assessment\.\.\.[\s\S]*\) : \(/);
    expect(body).toContain("Assessment runs on the laptop runner - unavailable on this instance.");
    // The honest branch is a plain status note, not the animated spinner markup.
    const honestBranch = body.slice(body.indexOf("Assessment runs on the laptop runner") - 300, body.indexOf("Assessment runs on the laptop runner"));
    expect(honestBranch).not.toContain("animate-spin");
  });
});
