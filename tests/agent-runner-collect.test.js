// RC-3 / SIM-87 I7 - the laptop runner posts ONLY new/modified, kind-bounded job
// outputs (MF-2): raw facts / out-of-scope files are never collected for egress.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectOutputs, snapshotFolder, resolveRunOutcome } from "../ops/agent-runner.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-collect-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);

describe("collectOutputs (MF-2 bounded egress from the job folder)", () => {
  it("collects a NEW tailored CV/cover but never raw facts or out-of-scope files", async () => {
    write("job-description.md", "posting");
    const before = snapshotFolder(dir);
    // simulate the run writing outputs + touching an unrelated file
    await new Promise((r) => setTimeout(r, 5));
    write("Simon Kim - CV - Analyst.pdf", "%PDF cv");
    write("Simon Kim - Cover Letter - OCI.pdf", "%PDF cover");
    write("facts.yaml", "personal: secret"); // raw facts -> kind 'other' -> NEVER collected
    write("notes.txt", "scratch"); // out-of-scope -> not collected

    const out = collectOutputs("finalize-job", dir, before);
    const names = out.map((o) => o.name).sort();
    expect(names).toEqual(["Simon Kim - CV - Analyst.pdf", "Simon Kim - Cover Letter - OCI.pdf"]);
    expect(names).not.toContain("facts.yaml");
    expect(names).not.toContain("notes.txt");
  });

  it("ignores unchanged pre-existing files (only new/modified outputs egress)", () => {
    write("Old CV - Role.pdf", "%PDF old");
    const before = snapshotFolder(dir);
    // nothing changed after the snapshot
    const out = collectOutputs("finalize-job", dir, before);
    expect(out).toEqual([]);
  });

  it("respects the per-kind bound: first-draft may post gaps, finalize may not", () => {
    const before = {};
    write("gaps.md", "# gaps");
    const draft = collectOutputs("first-draft-job", dir, before).map((o) => o.name);
    expect(draft).toContain("gaps.md");
    const fin = collectOutputs("finalize-job", dir, before).map((o) => o.name);
    expect(fin).not.toContain("gaps.md");
  });
});

// SIM-613/615 - resolveRunOutcome is the runner's own fail-closed decision: an
// exit-0 claude process is NOT "the run succeeded" when a required artifact
// kind (cv/cover) never landed. This is the exact swallowed-400 SIM-613 named
// (agent-runner.mjs used to report "done" unconditionally on exit 0 - see
// tests/runner-fail-closed-result.test.js for the server-side backstop that
// catches this same failure mode independently of the runner's own build).
describe("resolveRunOutcome (SIM-613/615 fail-closed run result)", () => {
  it("a non-zero exit always fails, regardless of what posted", () => {
    const out = resolveRunOutcome("first-draft-job", 1, "spawn failed: ENOENT", new Set(["cv", "cover"]), []);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("spawn failed: ENOENT");
  });

  it("exit 0 with every required kind posted reports done", () => {
    const out = resolveRunOutcome("first-draft-job", 0, null, new Set(["cv", "cover"]), []);
    expect(out).toEqual({ status: "done", error: null });
  });

  it("exit 0 but a required kind (cv) rejected by the gate reports failed, carrying the reason (the SIM-613 repro)", () => {
    const out = resolveRunOutcome(
      "first-draft-job",
      0,
      null,
      new Set(["cover"]), // only the cover letter actually landed
      ["CV - Analyst.docx (cv): rejected 400 - CV exceeds the 2-page cap"],
    );
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/cv/);
    expect(out.error).toMatch(/2-page cap/);
  });

  it("exit 0 but a required kind never even attempted (missing from postedKinds, no failure logged) still reports failed", () => {
    const out = resolveRunOutcome("finalize-job", 0, null, new Set(["cv"]), []);
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/cover/);
  });

  it("a kind with no required list (interview-prep) always reports done on exit 0, regardless of what posted", () => {
    const out = resolveRunOutcome("interview-prep", 0, null, new Set(), []);
    expect(out).toEqual({ status: "done", error: null });
  });
});

// SIM-535 - the runner-side halves of the source-discovery result lane: the
// per-claim scratch dir (tracked-links in, finds out, stale finds never reused)
// and the bounded result collection (trim-to-fit, honest null on garbage).
import { prepareSourceRunWorkdir, collectSourceRunResult } from "../ops/agent-runner.mjs";

describe("prepareSourceRunWorkdir (SIM-535 scratch space)", () => {
  it("writes the claim's tracked-links index and clears any stale finds file", () => {
    const job = { id: "aj-test-1", payload: { trackedLinks: ["https://x/1", "https://x/2"] } };
    const w1 = prepareSourceRunWorkdir(job);
    expect(JSON.parse(fs.readFileSync(w1.trackedLinksFile, "utf8"))).toEqual(["https://x/1", "https://x/2"]);
    // a stale finds file from a previous attempt of the SAME claim id is removed
    fs.writeFileSync(w1.findsFile, JSON.stringify({ counters: {}, finds: [{ title: "stale", link: "x" }] }), "utf8");
    const w2 = prepareSourceRunWorkdir(job);
    expect(w2.findsFile).toBe(w1.findsFile);
    expect(fs.existsSync(w2.findsFile)).toBe(false);
    fs.rmSync(w1.dir, { recursive: true, force: true });
  });

  it("tolerates a claim without trackedLinks (empty index)", () => {
    const w = prepareSourceRunWorkdir({ id: "aj-test-2", payload: {} });
    expect(JSON.parse(fs.readFileSync(w.trackedLinksFile, "utf8"))).toEqual([]);
    fs.rmSync(w.dir, { recursive: true, force: true });
  });
});

describe("collectSourceRunResult (bounded result collection)", () => {
  it("returns null for a missing or unparseable finds file (-> incomplete run, never fake success)", () => {
    expect(collectSourceRunResult(path.join(dir, "nope.json"))).toBeNull();
    write("bad.json", "not json {");
    expect(collectSourceRunResult(path.join(dir, "bad.json"))).toBeNull();
    write("arr.json", "[1,2]");
    expect(collectSourceRunResult(path.join(dir, "arr.json"))).toBeNull();
  });

  it("passes a well-formed payload through and defaults missing halves", () => {
    write("ok.json", JSON.stringify({ counters: { candidatesReviewed: 3 }, finds: [{ title: "T", link: "L" }] }));
    expect(collectSourceRunResult(path.join(dir, "ok.json"))).toEqual({
      counters: { candidatesReviewed: 3 },
      finds: [{ title: "T", link: "L" }],
    });
    write("bare.json", JSON.stringify({}));
    expect(collectSourceRunResult(path.join(dir, "bare.json"))).toEqual({ counters: {}, finds: [] });
  });

  it("trims tail finds (never counters) to fit the cloud's JSON body cap, and says so", () => {
    const finds = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, link: `https://x/${i}`, notes: "n".repeat(1900) }));
    write("big.json", JSON.stringify({ counters: { candidatesReviewed: 60 }, finds }));
    const r = collectSourceRunResult(path.join(dir, "big.json"));
    expect(r.truncated).toBeGreaterThan(0);
    expect(r.finds.length).toBeLessThan(60);
    expect(r.counters).toEqual({ candidatesReviewed: 60 });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(90_000);
  });
});
