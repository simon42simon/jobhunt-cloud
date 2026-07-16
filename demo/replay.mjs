// RC-3 / SIM-87 I6 - canned agent-replay loader (design 5.2). In demo mode the
// Draft/Finalize/Discover actions DO NOT spawn claude.exe; startRun feeds one of
// these pre-recorded stream-json transcripts through the EXISTING agentEventToUpdate
// parser, so the run panel animates realistically (stages, activity, cost) with
// ZERO model spend and ZERO real data. The transcripts are FICTIONAL and pass the
// forbidden-substrings guard (MF-11).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRANSCRIPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "transcripts");

// Map a routine `kind` to a transcript. Unknown/other routines fall back to a
// minimal generic transcript so any demo action still animates + terminates.
const KIND_MAP = {
  "first-draft-job": "first-draft-job",
  "finalize-job": "finalize-job",
  "discover-jobs": "discover-jobs",
  "discover-jobs-source": "discover-jobs",
};

const GENERIC_LINES = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Running a fictional demo action. No real data, no model spend." }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", duration_ms: 20000, num_turns: 2, total_cost_usd: 0, result: "Demo action complete." }),
];

// Return the raw JSONL lines for a routine kind (each line is a stream-json event,
// ready to feed through the same applyLine pump a real run uses). Tolerant: a
// missing/broken transcript falls back to the generic lines so the demo never hangs.
export function loadTranscriptLines(kind) {
  const name = KIND_MAP[kind];
  if (!name) return GENERIC_LINES.slice();
  try {
    const raw = fs.readFileSync(path.join(TRANSCRIPT_DIR, `${name}.jsonl`), "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    return lines.length ? lines : GENERIC_LINES.slice();
  } catch {
    return GENERIC_LINES.slice();
  }
}

// The transcript filenames the guard scans (design 5.4 / MF-11: the guard must
// cover demo/transcripts/* as well as the seed + pre-baked artifacts).
export function allTranscriptFiles() {
  try {
    return fs
      .readdirSync(TRANSCRIPT_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(TRANSCRIPT_DIR, f));
  } catch {
    return [];
  }
}

// The full concatenated text of every transcript, for the guard.
export function allTranscriptText() {
  return allTranscriptFiles()
    .map((f) => {
      try {
        return fs.readFileSync(f, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}
