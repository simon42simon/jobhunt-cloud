// SIM-598 (JP-6) - source-contract tests (same idiom as
// tests/status-automation.test.js's "run-close applies the automation"
// block): pin that the quality gate is ACTUALLY wired into both integration
// points, so a future refactor that silently drops the call is caught here
// rather than only by chance in an end-to-end test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../server/index.js", import.meta.url)), "utf8");

describe("quality gate wiring (source contract)", () => {
  it("the runner artifact-post endpoint checks the page cap before saveJobArtifact", () => {
    const routeStart = src.indexOf('"/api/runner/jobs/:id/artifact"');
    const routeEnd = src.indexOf("Track-pack cache", routeStart);
    const route = src.slice(routeStart, routeEnd);
    const gateAt = route.indexOf("checkPageCap(");
    const saveAt = route.indexOf("store.saveJobArtifact(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(saveAt); // the gate runs BEFORE the write, not after
  });

  it("maybeAutoAdvanceJob runs runQualityGate before the status write, and skips it in demo mode", () => {
    const fn = src.slice(src.indexOf("function maybeAutoAdvanceJob"), src.indexOf("function runQualityGate"));
    expect(fn).toContain("if (!DEMO_MODE)");
    const gateAt = fn.indexOf("runQualityGate(folder, job)");
    const writeAt = fn.indexOf("store.updateJobFields(folder, { status: next })");
    expect(gateAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(writeAt);
  });

  it("a gate block returns before the status write, and logs a quality-gate-block activity entry", () => {
    const fn = src.slice(src.indexOf("function maybeAutoAdvanceJob"), src.indexOf("function runQualityGate"));
    expect(fn).toMatch(/if \(!gate\.ok\)[\s\S]*return;/);
    expect(fn).toContain('kind: "quality-gate-block"');
  });

  it("runQualityGate only gates cv/cover artifact kinds (via artifactKindOf), everything else is untouched", () => {
    const fn = src.slice(src.indexOf("function runQualityGate"), src.indexOf("function runQualityGate") + 800);
    expect(fn).toContain("artifactKindOf(file.name)");
    expect(fn).toMatch(/kind !== "cv" && kind !== "cover"/);
  });
});
