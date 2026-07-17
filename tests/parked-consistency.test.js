import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { computeParkedConsistency, resolveDataDir } from "../server/lib.js";

// Deterministic guard for the Decisions inbox drift (ADR-020, t-1783371847653):
// a ticket parked for the owner (title marked "[PARKED]") that is MISSING the
// canonical "parked" label. This is the drift that silently dropped the
// contacts/referrals US-9 and Apify owner-decisions from the inbox under the old
// BOTH-labels rule. Mirrors tests/interview-consistency.test.js: fixture cases pin
// the precision bar, then a live-data case guards the real SoT against recurrence.

const mk = (over = {}) => ({ id: "t-x", title: "Decide the thing", status: "todo", labels: [], comments: [], ...over });

describe("computeParkedConsistency (fixtures)", () => {
  it("HIGH-flags a [PARKED]-titled, non-terminal ticket missing the 'parked' label (the live drop bug)", () => {
    const out = computeParkedConsistency([
      mk({ id: "t-drift", title: "[PARKED] Product direction: contacts layer?", labels: ["owner-decision", "userstory"] }),
    ]);
    expect(out.checked).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe("high");
    expect(out.findings[0].kind).toBe("parked-label-missing");
    expect(out.findings[0].id).toBe("t-drift");
    expect(out.findings[0].message).toContain("parked");
  });

  it("does NOT flag a well-formed parked ticket (title marker AND label agree)", () => {
    const out = computeParkedConsistency([
      mk({ id: "t-ok", title: "[PARKED] Which Chrome is personal?", labels: ["owner-decision", "parked", "qa"] }),
    ]);
    expect(out.findings).toHaveLength(0);
  });

  it("does NOT flag a RESOLVED-but-still-open decision (marker stripped + 'Owner decision:' comment)", () => {
    // buildResolveWrite strips "[PARKED]" and appends an "Owner decision:" comment.
    // Neither the title test nor the belt-and-braces comment test should trip.
    const stripped = mk({ id: "t-resolved", title: "Product direction: contacts layer?", labels: ["owner-decision"], status: "todo", comments: [{ author: "owner", body: "Owner decision: chose Option A - stay applications-only." }] });
    expect(computeParkedConsistency([stripped]).findings).toHaveLength(0);
    // Defense in depth: even if a legacy resolve left the "[PARKED]" title, the
    // "Owner decision:" comment exempts it (it is resolved, not awaiting a call).
    const lingering = { ...stripped, title: "[PARKED] Product direction: contacts layer?" };
    expect(computeParkedConsistency([lingering]).findings).toHaveLength(0);
  });

  it("does NOT flag a terminal (done/canceled) ticket - a resolved decision correctly has no 'parked' label", () => {
    const out = computeParkedConsistency([
      mk({ id: "t-done", title: "[PARKED] Merge branch + cut a release?", labels: ["owner-decision", "release"], status: "done" }),
    ]);
    expect(out.findings).toHaveLength(0);
  });

  it("does NOT treat the 'owner-decision' label alone as a positive signal (it is a permanent classification)", () => {
    // owner-decision kept after resolve; without a "[PARKED]" title it is not drift.
    const out = computeParkedConsistency([mk({ id: "t-cls", title: "unmarked", labels: ["owner-decision"] })]);
    expect(out.findings).toHaveLength(0);
  });
});

// ---- Live-data recurrence catch over the real docs/tasks.yaml ----------------
// After the two drifted tickets were reconciled (parked label added), the real SoT
// must carry NO parked-label drift. This goes red the moment an agent files a
// "[PARKED]" owner-decision without the "parked" label again.
describe("computeParkedConsistency (live tasks.yaml in the data zone)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // ADR-023: the live board left docs/ for the data zone (env > config dataDir > docs).
  const tasksPath = path.join(resolveDataDir(path.join(here, "..")), "tasks.yaml");
  // Clean-repo hermeticity (I9): the live board lives in the data zone, which the
  // public extraction deliberately does not carry - skip there, never fail.
  const live = fs.existsSync(tasksPath);

  it.skipIf(!live)("the live task board has zero parked-label drift", () => {
    const data = yaml.load(fs.readFileSync(tasksPath, "utf8")) || {};
    const out = computeParkedConsistency(data.tasks || []);
    // A failure prints exactly which ticket drifted and how to fix it.
    expect(out.findings.map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  });
});
