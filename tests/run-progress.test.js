import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// Live run progress (t-1783650926662): the routine runner spawns the CLI with
// `--output-format stream-json`, ignores stdin (killing the 3s "no stdin data"
// stall every run used to start with), and folds the event stream into the run
// record LIVE - transcript, currentActivity, per-routine milestone stageIndex,
// expectedMs (median of past successful durations), and finish stats. This
// suite guards:
//   1. WIRING - the spawn argv carries the streaming flags and stdin is
//      ignored, without touching the ADR-005 permission posture.
//   2. PARSING - NDJSON events (including lines torn across chunk boundaries)
//      update the polled run record; non-JSON lines pass through verbatim
//      (graceful degradation to the old text behavior).
//   3. ESTIMATES - expectedMs seeds from the activity log's paired start/close
//      lines and only successful runs feed it.
//   4. The pure lib.js helpers (describeToolUse / matchRunStage /
//      agentEventToUpdate / medianMs / runDurationHistory).
//
// The runner spawns the real `claude.exe`; tests must never launch it, so
// node:child_process spawn is mocked BEFORE importing the server module - the
// same pattern as tests/routine-agents.test.js.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

let lastProc = null;
const spawnMock = vi.fn(() => {
  lastProc = makeFakeProc();
  return lastProc;
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app;
let lib;
let tmpRoot;
let docsDir;
let jobsDir;

const FIXTURE_JOB = "Progress Role - Progress Co";

// Two paired finalize-job runs in the activity log: 60s and 120s -> median 90s.
// A failed run and an unmatched close are noise the parser must ignore.
function writeActivityFixture() {
  const lines = [
    { ts: "2026-07-08T10:00:00.000Z", kind: "run", runId: "r1", routine: "finalize-job", label: "Finalize application", jobId: FIXTURE_JOB, status: "running" },
    { ts: "2026-07-08T10:01:00.000Z", kind: "run", runId: "r1", status: "done", exitCode: 0 },
    { ts: "2026-07-08T11:00:00.000Z", kind: "run", runId: "r2", routine: "finalize-job", label: "Finalize application", jobId: FIXTURE_JOB, status: "running" },
    { ts: "2026-07-08T11:02:00.000Z", kind: "run", runId: "r2", status: "done", exitCode: 0 },
    // failed run: must NOT feed the estimate
    { ts: "2026-07-08T12:00:00.000Z", kind: "run", runId: "r3", routine: "finalize-job", label: "Finalize application", jobId: FIXTURE_JOB, status: "running" },
    { ts: "2026-07-08T12:00:05.000Z", kind: "run", runId: "r3", status: "failed", exitCode: 1 },
    // close with no start line: ignored
    { ts: "2026-07-08T13:00:00.000Z", kind: "run", runId: "r9", status: "done", exitCode: 0 },
  ];
  fs.writeFileSync(path.join(docsDir, "activity-log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function writeTasksFixture() {
  const y = ["columns:", "  - todo", "  - done", "tasks: []", ""].join("\n");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), y, "utf8");
}

const chunk = (s) => Buffer.from(s, "utf8");
const evtLine = (o) => JSON.stringify(o) + "\n";

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-run-progress-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(jobsDir, FIXTURE_JOB), { recursive: true });
  writeActivityFixture();
  writeTasksFixture();

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
  lib = await import("../server/lib.js");
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

async function launch(routine = "finalize-job") {
  const res = await request(app).post("/api/routines/run").send({ routine, jobId: FIXTURE_JOB });
  expect(res.status).toBe(201);
  return res.body.runId;
}

async function getRun(runId) {
  const res = await request(app).get(`/api/routines/run/${runId}`);
  expect(res.status).toBe(200);
  return res.body;
}

// ---- 1. Wiring: streaming flags + ignored stdin, posture unchanged ----------
describe("spawn wiring (stream-json + stdin ignore)", () => {
  it("appends --output-format stream-json --verbose and ignores stdin", async () => {
    spawnMock.mockClear();
    const runId = await launch();
    const [, args, opts] = spawnMock.mock.calls[0];
    const fi = args.indexOf("--output-format");
    expect(fi).toBeGreaterThan(-1);
    expect(args[fi + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // stdin IGNORED - the 3s "no stdin data received" stall is gone.
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    // Streaming is observability only: ADR-005 posture untouched.
    expect(args.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(args).toContain("--permission-mode");
    expect(args).not.toContain("--dangerously-skip-permissions");
    // Close as FAILED: only successful runs feed the duration history, so this
    // throwaway run cannot skew the 90s median the next test asserts.
    lastProc.emit("close", 1);
    await getRun(runId);
  });
});

// ---- 2. Event parsing into the polled run record ----------------------------
describe("stream-json events fold into the run record", () => {
  it("streams transcript/activity/milestones live and stats on result", async () => {
    spawnMock.mockClear();
    const runId = await launch("finalize-job");
    const proc = lastProc;

    // init -> immediate feedback before the first turn
    proc.stdout.emit("data", chunk(evtLine({ type: "system", subtype: "init", model: "opus" })));
    let run = await getRun(runId);
    expect(run.currentActivity).toBe("Agent started");
    expect(run.stages).toEqual([
      "Read gaps + current draft",
      "Fold answers into facts",
      "Re-tailor application content",
      "Render final documents + PDFs",
      "Update job file + wrap up",
    ]);
    expect(run.stageIndex).toBe(-1);
    // expectedMs = median of the two successful fixture durations (60s, 120s)
    expect(run.expectedMs).toBe(90_000);

    // assistant turn: text + a Read tool call, TORN across two chunks
    const turn = evtLine({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the gaps note." },
          { type: "tool_use", name: "Read", input: { file_path: `Jobs/${FIXTURE_JOB}/Role gaps.md` } },
        ],
      },
    });
    proc.stdout.emit("data", chunk(turn.slice(0, 25)));
    proc.stdout.emit("data", chunk(turn.slice(25)));
    run = await getRun(runId);
    expect(run.output).toContain("Reading the gaps note.");
    expect(run.output).toContain("> Reading Progress Role - Progress Co/Role gaps.md");
    expect(run.currentActivity).toBe("Reading Progress Role - Progress Co/Role gaps.md");
    expect(run.stageIndex).toBe(0); // "Read gaps + current draft"

    // facts edit -> stage 1; render script -> stage 3 (2 legitimately skipped)
    proc.stdout.emit(
      "data",
      chunk(
        evtLine({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "ops/facts/resume.yaml" } }] },
        }) +
          evtLine({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", name: "Bash", input: { command: `python ops/scripts/render_application.py "Jobs/${FIXTURE_JOB}/application-content.json"` } },
              ],
            },
          })
      )
    );
    run = await getRun(runId);
    expect(run.stageIndex).toBe(3);
    expect(run.currentActivity).toMatch(/^Running python ops\/scripts\/render_application\.py/);

    // a non-JSON warning line passes through verbatim (graceful degradation)
    proc.stdout.emit("data", chunk("Warning: something the CLI printed\n"));
    run = await getRun(runId);
    expect(run.output).toContain("Warning: something the CLI printed");

    // terminal result: stats land, activity clears; error subtypes stay visible
    proc.stdout.emit(
      "data",
      chunk(evtLine({ type: "result", subtype: "success", duration_ms: 245_000, num_turns: 23, total_cost_usd: 1.37, result: "All done." }))
    );
    proc.emit("close", 0);
    run = await getRun(runId);
    expect(run.status).toBe("done");
    expect(run.currentActivity).toBeNull();
    expect(run.stats).toEqual({ durationMs: 245_000, numTurns: 23, costUsd: 1.37 });
  });

  it("flushes a final line that arrives without a trailing newline", async () => {
    spawnMock.mockClear();
    const runId = await launch("first-draft-job");
    const proc = lastProc;
    proc.stdout.emit(
      "data",
      chunk(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tail line" }] } }))
    ); // no \n
    // A real run always outlives one clock tick; guarantee a nonzero duration
    // so this successful close records a history sample for the next test.
    await new Promise((r) => setTimeout(r, 10));
    proc.emit("close", 0);
    const run = await getRun(runId);
    expect(run.output).toContain("tail line");
    expect(run.status).toBe("done");
  });

  it("a successful close feeds the duration history for the NEXT run's estimate", async () => {
    // first-draft-job has no fixture history -> first run has no estimate...
    spawnMock.mockClear();
    const firstId = await launch("first-draft-job");
    // (the run just above already closed successfully, so history now exists;
    // this run launched after it and must carry a real estimate)
    const run = await getRun(firstId);
    expect(typeof run.expectedMs).toBe("number");
    expect(run.expectedMs).toBeGreaterThan(0);
    lastProc.emit("close", 1); // throwaway close; failed -> history untouched
  });
});

// ---- 3. Pure helpers (server/lib.js) ----------------------------------------
describe("lib.js progress helpers", () => {
  it("describeToolUse shortens paths and caps length", () => {
    expect(lib.describeToolUse("Read", { file_path: "C:/very/deep/ops/facts/resume.yaml" })).toBe("Reading facts/resume.yaml");
    expect(lib.describeToolUse("Bash", { command: "python  ops/scripts/render_application.py   --no-pdf" })).toBe(
      "Running python ops/scripts/render_application.py --no-pdf"
    );
    expect(lib.describeToolUse("WebFetch", { url: "https://example.com/posting" })).toBe("Fetching https://example.com/posting");
    expect(lib.describeToolUse("Read", {})).toBe("Reading");
    expect(lib.describeToolUse("Bash", { command: "x".repeat(200) })).toHaveLength("Running ".length + 80);
  });

  it("matchRunStage advances forward only, honors path + exclude, allows skips", () => {
    const stages = [
      { label: "read", match: { tools: ["Read"] } },
      { label: "facts", match: { tools: ["Edit"], path: /ops[\\/]+facts/i } },
      { label: "render", match: { tools: ["Bash"], path: /render_application/i } },
      { label: "wrap", match: { tools: ["Edit"], path: /\.md/i, exclude: /gaps\.md/i } },
    ];
    expect(lib.matchRunStage(stages, -1, "Read", "whatever.txt")).toBe(0);
    // a later Read never regresses the index
    expect(lib.matchRunStage(stages, 2, "Read", "whatever.txt")).toBe(2);
    // skipping is legit: Bash render from stage 0 jumps straight to 2
    expect(lib.matchRunStage(stages, 0, "Bash", "python render_application.py")).toBe(2);
    // exclude keeps the gaps note from counting as the wrap-up job-file edit
    expect(lib.matchRunStage(stages, 2, "Edit", "Jobs/X/Role gaps.md")).toBe(2);
    expect(lib.matchRunStage(stages, 2, "Edit", "Jobs/X/Role.md")).toBe(3);
    // an Edit whose CONTENT mentions the render script must not match render:
    // matching runs on toolTarget (file_path), never the full input
    expect(lib.toolTarget("Edit", { file_path: "notes.txt", new_string: "render_application.py" })).toBe("notes.txt");
  });

  it("agentEventToUpdate: init/text/tool_use/result semantics", () => {
    expect(lib.agentEventToUpdate({ type: "system", subtype: "init" }, null, -1).activity).toBe("Agent started");
    const upd = lib.agentEventToUpdate(
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      null,
      -1
    );
    expect(upd.appendText).toBe("hi\n");
    expect(upd.activity).toBeUndefined(); // text alone leaves activity as-is
    const err = lib.agentEventToUpdate({ type: "result", subtype: "error_max_turns", result: "ran out" }, null, 2);
    expect(err.activity).toBeNull();
    expect(err.appendText).toContain("[result: error_max_turns] ran out");
    expect(err.stats).toEqual({ durationMs: null, numTurns: null, costUsd: null });
    // success result adds NO duplicate text (the last assistant turn already streamed)...
    expect(lib.agentEventToUpdate({ type: "result", subtype: "success", result: "done" }, null, 2, true).appendText).toBe("");
    // ...but IS the fallback when nothing streamed (unrecognized turn events):
    // output must never end up emptier than the old text mode.
    expect(lib.agentEventToUpdate({ type: "result", subtype: "success", result: "done" }, null, 2, false).appendText).toBe("done\n");
  });

  it("medianMs + runDurationHistory pair starts with done closes only", () => {
    expect(lib.medianMs([])).toBeNull();
    expect(lib.medianMs(null)).toBeNull();
    expect(lib.medianMs([5000])).toBe(5000);
    expect(lib.medianMs([60_000, 120_000])).toBe(90_000);
    // A fixed raw log (NOT the live tmp file, which the integration tests
    // above have since appended real run lines to): the failed r3 pair, the
    // orphan r9 close, and a torn line must all be ignored.
    const raw =
      [
        JSON.stringify({ ts: "2026-07-08T10:00:00.000Z", kind: "run", runId: "r1", routine: "finalize-job", status: "running" }),
        JSON.stringify({ ts: "2026-07-08T10:01:00.000Z", kind: "run", runId: "r1", status: "done", exitCode: 0 }),
        JSON.stringify({ ts: "2026-07-08T11:00:00.000Z", kind: "run", runId: "r2", routine: "finalize-job", status: "running" }),
        JSON.stringify({ ts: "2026-07-08T11:02:00.000Z", kind: "run", runId: "r2", status: "done", exitCode: 0 }),
        JSON.stringify({ ts: "2026-07-08T12:00:00.000Z", kind: "run", runId: "r3", routine: "finalize-job", status: "running" }),
        JSON.stringify({ ts: "2026-07-08T12:00:05.000Z", kind: "run", runId: "r3", status: "failed", exitCode: 1 }),
        JSON.stringify({ ts: "2026-07-08T13:00:00.000Z", kind: "run", runId: "r9", status: "done", exitCode: 0 }),
        '{"torn',
      ].join("\n") + "\n";
    const hist = lib.runDurationHistory(raw);
    expect(hist.get("finalize-job")).toEqual([60_000, 120_000]); // failed r3 + orphan r9 + torn line ignored
  });
});
