import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

// Every case spawns a real node child process; under a full-suite run the
// spawn alone can exceed vitest's default 5s per-test budget on this machine
// (observed 2026-07-05: different cases timing out each run, all green in
// isolation). Spawn-appropriate budget, not a behavior change.
vi.setConfig({ testTimeout: 30000 });

// ops/hooks/capture-prompt.mjs - the UserPromptSubmit intake-capture hook.
// Contract pinned here (t-1783144206969):
//   1. Harness-injected NON-OWNER turns (<task-notification> blocks, the
//      "[SYSTEM NOTIFICATION ...]" wrapper, <system-reminder> blocks) are
//      NEVER recorded - they are agent/system machinery, not owner asks, and
//      they were polluting the ADR-009 Intake ledger.
//   2. A genuine substantive owner prompt IS recorded, verbatim, source
//      "session".
//   3. Trivial approvals stay skipped (the owner's original opt-out).
//   4. The hook is SILENT on stdout (UserPromptSubmit stdout is injected into
//      the model context) and always exits 0.
// The hook posts to 127.0.0.1:<JOBHUNT_INTAKE_PORT || 8787>; the env seam
// points it at this suite's ephemeral fixture server so the test can never
// write a record into the real running app.

const HOOK = path.resolve(__dirname, "..", "ops", "hooks", "capture-prompt.mjs");

let server;
let port;
let received; // bodies of POST /api/requests the fixture server saw

beforeAll(async () => {
  received = [];
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Run the hook once with `payload` on stdin; resolve { code, stdout } after exit.
function runHook(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, JOBHUNT_INTAKE_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

const TASK_NOTIFICATION =
  "<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n" +
  "<summary>Agent \"Release-gate governance audit\" finished</summary>\n" +
  "<result>Report follows.</result>\n</task-notification>";

describe("capture-prompt hook - non-owner turn filtering (t-1783144206969)", () => {
  it("does NOT record a <task-notification> block (the r-1783224958199 shape)", async () => {
    const before = received.length;
    const { code, stdout } = await runHook({ prompt: TASK_NOTIFICATION });
    expect(code).toBe(0);
    expect(stdout).toBe(""); // silent on stdout, always
    expect(received.length).toBe(before); // no intake record
  });

  it("does NOT record a '[SYSTEM NOTIFICATION ...]'-wrapped notification", async () => {
    const before = received.length;
    const { code } = await runHook({
      prompt: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n${TASK_NOTIFICATION}`,
    });
    expect(code).toBe(0);
    expect(received.length).toBe(before);
  });

  it("does NOT record a <system-reminder> block", async () => {
    const before = received.length;
    const { code } = await runHook({
      prompt: "<system-reminder>\nBackground shell finished; check the output file.\n</system-reminder>",
    });
    expect(code).toBe(0);
    expect(received.length).toBe(before);
  });

  it("still skips trivial approvals (the original opt-out)", async () => {
    const before = received.length;
    const { code } = await runHook({ prompt: "ok" });
    expect(code).toBe(0);
    expect(received.length).toBe(before);
  });

  it("records a genuine substantive owner prompt, verbatim, source session", async () => {
    const before = received.length;
    const ask = "Please redesign the discovery sources console: cadence pills read wrong at 390px.";
    const { code, stdout } = await runHook({ prompt: ask });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(received.length).toBe(before + 1);
    const rec = received[received.length - 1];
    expect(rec.method).toBe("POST");
    expect(rec.url).toBe("/api/requests");
    expect(JSON.parse(rec.body)).toEqual({ text: ask, source: "session" });
  });

  it("exits 0 quietly on a non-JSON payload", async () => {
    const before = received.length;
    const { code, stdout } = await runHook("this is not json");
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(received.length).toBe(before);
  });
});
