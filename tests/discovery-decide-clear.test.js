import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// POST /api/discovery/decide "clear" verb (t-1783178044080): the persist side
// of undoing a New->Skip/Maybe triage back to undecided. v1 shipped that undo
// optimistic-only because the endpoint had no way to BLANK a Decision cell.
//
// Hermetic via the JOBHUNT_PYTHON seam (mirrors JOBHUNT_JOBS_DIR /
// JOBHUNT_DISCOVERY_FINDS): the env points the server's python resolver at the
// node binary, and the fixture workspace carries a fake ops/scripts/discovery.py
// (a CommonJS script) that records its argv and can simulate the real script's
// exit contract (4 = LOCKED workbook, 3 = no matching row). So the endpoint's
// FULL execFile path runs - spawn, arg marshalling, exit-code handling - with no
// real python and no xlsx. The real discovery.py's clear behavior (write a
// genuinely EMPTY cell) is owner-local and verified against a synthetic
// workbook copy at change time; its CLI contract is what this fake mirrors.

let app;
let tmpRoot;
let scriptsDir;

const CAPTURE = () => path.join(scriptsDir, "capture.json");
const LOCKED = () => path.join(scriptsDir, "LOCKED");
const NOTFOUND = () => path.join(scriptsDir, "NOTFOUND");

// The fake discovery.py, run by node (JOBHUNT_PYTHON): mirrors the real
// script's decide exit contract.
const FAKE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
if (fs.existsSync(path.join(dir, "LOCKED"))) {
  console.error("LOCKED: Job Discovery.xlsx is open in Excel (close it to continue)");
  process.exit(4);
}
if (fs.existsSync(path.join(dir, "NOTFOUND"))) {
  console.error("NOT FOUND: no matching row");
  process.exit(3);
}
fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(process.argv.slice(2)));
console.log("DECIDED row 3: fake -> " + process.argv[4]);
`;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-decide-clear-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  scriptsDir = path.join(tmpRoot, "ops", "scripts");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "discovery.py"), FAKE_SCRIPT, "utf8");
  process.env.JOBHUNT_TEST = "1";
  // WORKSPACE_DIR = dirname(JOBS_DIR), so the server resolves the fake script
  // at <tmpRoot>/ops/scripts/discovery.py.
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_PYTHON = process.execPath;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.JOBHUNT_PYTHON;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  for (const f of [CAPTURE(), LOCKED(), NOTFOUND()]) fs.rmSync(f, { force: true });
});

const decide = (body) => request(app).post("/api/discovery/decide").send(body);

describe("POST /api/discovery/decide decision:'clear'", () => {
  it("accepts the clear verb and passes it to discovery.py decide verbatim", async () => {
    const res = await decide({ title: "Some Role", link: "https://x.example/1", decision: "clear" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.decision).toBe("clear");
    // The script got exactly the real CLI contract: decide <title> <link> clear.
    expect(JSON.parse(fs.readFileSync(CAPTURE(), "utf8"))).toEqual([
      "decide",
      "Some Role",
      "https://x.example/1",
      "clear",
    ]);
  });

  it("normalizes case/whitespace like the other verbs (' CLEAR ' -> clear)", async () => {
    const res = await decide({ title: "Some Role", link: "https://x.example/1", decision: " CLEAR " });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("clear");
  });

  it("degrades gracefully when the workbook is locked (exit 4 -> ok:false locked:true, never a 500)", async () => {
    fs.writeFileSync(LOCKED(), "");
    const res = await decide({ title: "Some Role", link: "https://x.example/1", decision: "clear" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.locked).toBe(true);
    expect(res.body.message).toMatch(/open in Excel/i);
  });

  it("maps a no-matching-row clear (exit 3) to a 404", async () => {
    fs.writeFileSync(NOTFOUND(), "");
    const res = await decide({ title: "Gone Role", link: "https://x.example/gone", decision: "clear" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no matching/i);
  });

  it("still rejects an unknown verb, and the 400 names the full verb set", async () => {
    const res = await decide({ title: "Some Role", link: "https://x.example/1", decision: "clearly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/skip, maybe, pursue, clear/);
    expect(fs.existsSync(CAPTURE())).toBe(false); // validation fires before the script
  });

  it("the existing verbs keep working through the same path (skip round-trip)", async () => {
    const res = await decide({ title: "Some Role", link: "https://x.example/1", decision: "skip" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(CAPTURE(), "utf8"))[3]).toBe("skip");
  });
});
