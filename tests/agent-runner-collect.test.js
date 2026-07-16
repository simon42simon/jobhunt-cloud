// RC-3 / SIM-87 I7 - the laptop runner posts ONLY new/modified, kind-bounded job
// outputs (MF-2): raw facts / out-of-scope files are never collected for egress.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectOutputs, snapshotFolder } from "../ops/agent-runner.mjs";

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
