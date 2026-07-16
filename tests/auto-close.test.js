import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldAutoClose, isExpiredDeadline, localDateISO, AUTO_CLOSE_NOTE, AUTO_CLOSE_STATUSES } from "../server/lib.js";

// Deadline auto-close: the ONE rule-based automatic write in the app
// (DATA_CONTRACT.md "What the app may do"). A lazy sweep piggybacks GET
// /api/jobs, at most once per process per day: any job still in a
// pre-application status (lead / queued / drafted) whose deadline is a literal
// YYYY-MM-DD strictly before today's LOCAL date gets status -> closed plus
// next_action provenance, through the surgical updateFrontmatter path (body
// byte-identical, EOL preserved, never a delete). Everything else - submitted
// and later, today's deadline, no deadline, free-text deadline - is NEVER
// touched.
//
// One fixture vault holds every boundary case and ONE first GET sweeps them
// all: the module-level once-per-day guard means only the first GET /api/jobs
// of this app instance sweeps, so all closable cases must exist before it.
// The final describe then proves the guard itself (no re-sweep on a later GET
// the same day). Tests within a file run sequentially in vitest, so that
// ordering is reliable.

let app;
let fixture;

const TODAY = localDateISO(); // same local-date logic the sweep uses

// Build a job file's content with a controllable EOL.
function jobMd({ role, employer, status, deadline }, eol = "\n") {
  return [
    "---",
    "type: job",
    `role: ${role}`,
    `employer: ${employer}`,
    "track: b2b_gtm_focused",
    "fit: strong",
    `status: ${status}`,
    "sector: private",
    "tailoring: light",
    ...(deadline ? [`deadline: ${deadline}`] : []),
    "tags: [job]",
    "---",
    "",
    `# ${role} - ${employer}`,
    "",
    "**Lead with:** the body must survive byte-for-byte",
    "",
  ].join(eol);
}

// folder id -> { content, file }
const jobs = {};

function addJob(role, employer, status, deadline, eol = "\n") {
  const folder = `${role} - ${employer}`;
  const dir = path.join(fixture, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "job.md");
  const content = jobMd({ role, employer, status, deadline }, eol);
  fs.writeFileSync(file, content, "utf8");
  jobs[folder] = { content, file };
  return folder;
}

const bodyOf = (raw, eol = "\n") => raw.split(`${eol}---${eol}`)[1];

let res; // the single sweeping GET, shared by the assertions below

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jh-autoclose-"));

  // must close (past deadline, pre-application):
  addJob("Past Lead", "A Co", "lead", "2020-01-01");
  addJob("Past Queued", "B Co", "queued", "2020-01-02");
  addJob("Past Drafted CRLF", "C Co", "drafted", "2020-01-03", "\r\n");
  // must never close:
  addJob("Past Submitted", "D Co", "submitted", "2020-01-01");
  addJob("Today Lead", "E Co", "lead", TODAY); // strictly BEFORE today only
  addJob("No Deadline", "F Co", "lead", null);
  addJob("Text Deadline", "G Co", "lead", "1-yr contract");

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  ({ app } = await import("../server/index.js"));

  res = await request(app).get("/api/jobs"); // first load -> the daily sweep
});

afterAll(() => {
  try {
    fs.rmSync(fixture, { recursive: true, force: true });
  } catch {}
});

const inRes = (folder) => res.body.find((j) => j.id === folder);

describe("shouldAutoClose (pure rule, server/lib.js)", () => {
  it("closes only the pre-submission statuses (incl. `ready` - finalized but not yet applied)", () => {
    expect(AUTO_CLOSE_STATUSES).toEqual(["lead", "queued", "drafted", "ready"]);
    for (const s of ["lead", "queued", "drafted", "ready"]) {
      expect(shouldAutoClose(s, "2020-01-01", "2026-07-02")).toBe(true);
    }
    for (const s of ["submitted", "interview", "offer", "rejected", "closed"]) {
      expect(shouldAutoClose(s, "2020-01-01", "2026-07-02")).toBe(false);
    }
  });

  it("is strictly-before: today's deadline is still live, tomorrow's obviously too", () => {
    expect(shouldAutoClose("lead", "2026-07-02", "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", "2026-07-03", "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", "2026-07-01", "2026-07-02")).toBe(true);
  });

  it("never judges a non-YYYY-MM-DD deadline (free text, absent) or a malformed today", () => {
    expect(shouldAutoClose("lead", "1-yr contract", "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", null, "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", undefined, "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", "", "2026-07-02")).toBe(false);
    expect(shouldAutoClose("lead", "2020-01-01", "not-a-date")).toBe(false);
  });

  it("localDateISO renders LOCAL date components, zero-padded", () => {
    expect(localDateISO(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDateISO(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

// isExpiredDeadline is the shared "past deadline" predicate that shouldAutoClose
// delegates to and the discovery write path reuses (server: mapApifyDataset;
// mirrored in discovery.py cmd_add). It carries the same real-ISO / strictly-
// before / never-judge-free-text semantics WITHOUT the status gate - so an
// expired discovery find is judged the same way an expired Job is (t-1783422051088).
describe("isExpiredDeadline (shared past-deadline predicate, server/lib.js)", () => {
  it("is true only for a real YYYY-MM-DD strictly before today", () => {
    expect(isExpiredDeadline("2026-07-01", "2026-07-02")).toBe(true);
    expect(isExpiredDeadline("2020-12-31", "2026-07-02")).toBe(true);
  });
  it("is strictly-before: today's deadline is still live, a future one obviously too", () => {
    expect(isExpiredDeadline("2026-07-02", "2026-07-02")).toBe(false); // today = still open
    expect(isExpiredDeadline("2026-07-03", "2026-07-02")).toBe(false); // future
  });
  it("never judges a free-text, absent, or malformed deadline / today", () => {
    expect(isExpiredDeadline("rolling", "2026-07-02")).toBe(false);
    expect(isExpiredDeadline("1-yr contract", "2026-07-02")).toBe(false);
    expect(isExpiredDeadline("", "2026-07-02")).toBe(false);
    expect(isExpiredDeadline(null, "2026-07-02")).toBe(false);
    expect(isExpiredDeadline(undefined, "2026-07-02")).toBe(false);
    expect(isExpiredDeadline("2026/07/01", "2026-07-02")).toBe(false); // wrong format, not judged
    expect(isExpiredDeadline("2020-01-01", "not-a-date")).toBe(false);
  });
  it("shouldAutoClose == isExpiredDeadline gated by a pre-application status", () => {
    // same deadline, same today: the ONLY difference shouldAutoClose adds is the status gate.
    expect(shouldAutoClose("lead", "2020-01-01", "2026-07-02")).toBe(isExpiredDeadline("2020-01-01", "2026-07-02"));
    expect(shouldAutoClose("submitted", "2020-01-01", "2026-07-02")).toBe(false); // gate blocks it
    expect(isExpiredDeadline("2020-01-01", "2026-07-02")).toBe(true); // ...but the deadline IS expired
  });
});

describe("lazy sweep on GET /api/jobs - closes expired pre-application jobs", () => {
  it("closes past-deadline lead / queued / drafted with provenance, visible in the SAME response", () => {
    expect(res.status).toBe(200);
    for (const folder of ["Past Lead - A Co", "Past Queued - B Co", "Past Drafted CRLF - C Co"]) {
      const job = inRes(folder);
      expect(job, folder).toBeDefined();
      expect(job.status, folder).toBe("closed");
      expect(job.nextAction, folder).toBe(AUTO_CLOSE_NOTE);
    }
  });

  it("writes status + provenance into the frontmatter and nothing else (LF file: body byte-identical)", () => {
    const { content: before, file } = jobs["Past Lead - A Co"];
    const after = fs.readFileSync(file, "utf8");

    expect(after).toContain("status: closed");
    // yamlScalar quotes the note (it contains a colon).
    expect(after).toContain(`next_action: "${AUTO_CLOSE_NOTE}"`);
    expect(after).not.toContain("status: lead");
    // the body below the frontmatter is untouched, byte for byte.
    expect(bodyOf(after)).toBe(bodyOf(before));
    // surgical: exactly the status line changed plus one inserted line.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length + 1);
  });

  it("preserves CRLF line endings on a CRLF job file (no EOL rewrite on the sweep's write)", () => {
    const { content: before, file } = jobs["Past Drafted CRLF - C Co"];
    const after = fs.readFileSync(file, "utf8");

    expect(after).toContain("status: closed");
    expect(after).toContain(`next_action: "${AUTO_CLOSE_NOTE}"`);
    // still CRLF throughout: no bare \n survives once \r\n pairs are removed.
    expect(after).toContain("\r\n");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    // body byte-identical, CRLF and all.
    expect(bodyOf(after, "\r\n")).toBe(bodyOf(before, "\r\n"));
  });

  it("never touches a past-deadline SUBMITTED job (the application outlives the posting)", () => {
    const { content: before, file } = jobs["Past Submitted - D Co"];
    expect(inRes("Past Submitted - D Co").status).toBe("submitted");
    expect(fs.readFileSync(file, "utf8")).toBe(before); // byte-identical
  });

  it("never touches a job whose deadline is TODAY (strictly before only)", () => {
    const { content: before, file } = jobs["Today Lead - E Co"];
    expect(inRes("Today Lead - E Co").status).toBe("lead");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("never touches a job with no deadline", () => {
    const { content: before, file } = jobs["No Deadline - F Co"];
    expect(inRes("No Deadline - F Co").status).toBe("lead");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("never touches a job with a free-text deadline", () => {
    const { content: before, file } = jobs["Text Deadline - G Co"];
    expect(inRes("Text Deadline - G Co").status).toBe("lead");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("once-per-process-per-day guard", () => {
  it("does not re-sweep on a later GET the same day (a hand-reopened job stays open)", async () => {
    // The owner reverses an auto-close by hand: back to lead, deadline still past.
    const { file } = jobs["Past Lead - A Co"];
    fs.writeFileSync(file, jobMd({ role: "Past Lead", employer: "A Co", status: "lead", deadline: "2020-01-01" }), "utf8");

    const again = await request(app).get("/api/jobs");
    expect(again.status).toBe(200);
    const job = again.body.find((j) => j.id === "Past Lead - A Co");
    // the sweep already ran today for this process - no second write.
    expect(job.status).toBe("lead");
    expect(fs.readFileSync(file, "utf8")).toContain("status: lead");
  });
});
