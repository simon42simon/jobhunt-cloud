// UserPromptSubmit hook: best-effort record each owner prompt into the local
// Intake ledger (POST /api/requests) the instant it is submitted, so the
// "prompt table" can never silently drift empty again (see the operational-
// system currency initiative, 2026-07-03).
//
// Contract: MUST be silent on stdout (UserPromptSubmit stdout is injected into
// the model context) and MUST never block the prompt - it exits 0 no matter
// what, and if the app server is down the POST just fails quietly.
//
// The owner opted to SKIP TRIVIAL prompts (short approvals / continuations), so
// the ledger stays focused on substantive requests. The hook only CAPTURES the
// verbatim text; the CTO enriches each record with the assessment + spawned
// tasks/projects while processing it.

import { readFileSync } from "node:fs";
import http from "node:http";

function done() { process.exit(0); }

let prompt = "";
try {
  const raw = readFileSync(0, "utf8"); // hook payload JSON on stdin
  prompt = String(JSON.parse(raw).prompt || "");
} catch {
  done(); // no/!JSON input -> nothing to record
}

const trimmed = prompt.trim();

// Harness-injected, NON-OWNER turns (t-1783144206969): background-agent
// completion events (<task-notification>, sometimes prefixed with the
// "[SYSTEM NOTIFICATION ...]" wrapper) and <system-reminder> blocks also
// arrive through UserPromptSubmit, but they are not owner asks - recording
// them buried the Intake ledger (ADR-009's "origin record of every ask") in
// agent-completion noise: 90 of 203 records by 2026-07-05. An owner prompt
// never BEGINS with one of these harness markers, so a start-anchored match
// filters the machine turns without ever suppressing a real ask.
const NON_OWNER = /^\s*(\[SYSTEM NOTIFICATION\b|<task-notification[\s>]|<system-reminder[\s>])/i;
if (NON_OWNER.test(prompt)) done();

// Trivial = short, or a bare approval/continuation/ship/push command.
const TRIVIAL = /^(continue|proceed|go ahead|go|yes+|yep|yup|ok(ay)?|sure|sounds good|do it|ship it|ship\b.*|push\b.*|pull\b.*|next|done|thanks?|thank you|ty|nice|great|perfect|good)\b[\s.!]*$/i;

if (trimmed.length < 15 || TRIVIAL.test(trimmed)) done();

const body = JSON.stringify({ text: prompt, source: "session" });
const req = http.request(
  {
    host: "127.0.0.1",
    // The port seam exists for the hook's own test (tests/capture-prompt-hook
    // .test.js points it at an ephemeral fixture server); unset, it is the
    // real app bridge on 8787, unchanged.
    port: Number(process.env.JOBHUNT_INTAKE_PORT) || 8787,
    path: "/api/requests",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  },
  (res) => { res.resume(); res.on("end", done); } // drain + exit
);
req.on("error", done);          // server down / refused -> best-effort, ignore
req.setTimeout(2500, () => { req.destroy(); done(); });
req.write(body);
req.end();
