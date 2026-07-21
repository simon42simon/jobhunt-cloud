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

// The canned transcripts are recorded against a placeholder job: folder "Demo",
// job file "Operations Analyst.md" (both inside "Jobs/Demo/..." paths). SIM-390
// item 2: the run panel showed "Writing Demo/Operations Analyst.md" no matter
// which job the visitor replayed. personalizeTranscriptLines rewrites those
// placeholders IN THE RAW JSONL (values are JSON-escaped so a folder name with a
// quote/backslash can never tear a line) so the replay names the job it actually
// runs against. Order matters: the job-FILE placeholder is replaced first, then
// the folder, so a role that itself reads "Operations Analyst" round-trips.
const PLACEHOLDER_FOLDER = "Jobs/Demo/";
const PLACEHOLDER_JOB_FILE = "Operations Analyst.md";
const jsonEscape = (s) => JSON.stringify(String(s)).slice(1, -1);

export function personalizeTranscriptLines(lines, { jobFolder, jobFile } = {}) {
  if (!jobFolder) return lines;
  const folder = `Jobs/${jsonEscape(jobFolder)}/`;
  const file = jsonEscape(jobFile || `${jobFolder}.md`);
  return lines.map((l) =>
    String(l).split(PLACEHOLDER_JOB_FILE).join(file).split(PLACEHOLDER_FOLDER).join(folder),
  );
}

// Return the raw JSONL lines for a routine kind (each line is a stream-json event,
// ready to feed through the same applyLine pump a real run uses). Tolerant: a
// missing/broken transcript falls back to the generic lines so the demo never hangs.
// Pass { jobFolder, jobFile } to personalize the placeholder job paths (SIM-390).
export function loadTranscriptLines(kind, { jobFolder = null, jobFile = null } = {}) {
  const name = KIND_MAP[kind];
  const lines = (() => {
    if (!name) return GENERIC_LINES.slice();
    try {
      const raw = fs.readFileSync(path.join(TRANSCRIPT_DIR, `${name}.jsonl`), "utf8");
      const ls = raw.split(/\r?\n/).filter((l) => l.trim());
      return ls.length ? ls : GENERIC_LINES.slice();
    } catch {
      return GENERIC_LINES.slice();
    }
  })();
  return personalizeTranscriptLines(lines, { jobFolder, jobFile });
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

// SIM-422 (GATE 2 fix). demo/seed.mjs pre-bakes fictional CV + cover-letter
// artifacts for jobs it seeds past "queued" (see its `artifacts` builder), but a
// job the visitor pushes through "Draft CV + cover letter" via a LIVE
// first-draft-job replay started with none: the run panel said DONE, the
// transcript above says "ready for review," but the drawer's FILES section
// stayed empty and the status never advanced (the store's readiness derivation
// needs a real cv/cover file - see hasCV/hasCoverLetter in server/store.js -
// before draftDone, and therefore nextStatusAfterRun, can flip). This mirrors
// the SAME fictional-artifact shape the seed bakes (same %PDF-1.4 placeholder
// header + FICTIONAL DEMO markers, so it passes the forbidden-substrings guard
// (MF-11) exactly like the seeded ones - both are pure functions of fictional
// inputs, never real vault data) so the replay attaches real files instead of
// only promising them. DEMO_APPLICANT_NAME is a fixed, clearly-invented persona
// name (not a real person) so every replay of a given job is idempotent
// (upserts the same two file names on re-draft rather than piling up copies).
const DEMO_APPLICANT_NAME = "Jordan Ashworth";

export function fictionalDraftArtifacts({ role, employer, jobId } = {}) {
  const r = role || "the role";
  const e = employer || "the employer";
  const person = DEMO_APPLICANT_NAME;
  // Cosmetic-only variability (bullet numbers) keyed off the job id so different
  // jobs don't render byte-identical CVs; never affects file naming or content shape.
  let seed = 0;
  for (const ch of String(jobId || r)) seed = (seed + ch.charCodeAt(0)) % 97;
  return [
    {
      name: `${person} - CV - ${r}.pdf`,
      mime: "application/pdf",
      text:
        `%PDF-1.4 (fictional demo)\n# ${person}\n\n## ${r} - ${e} (FICTIONAL DEMO)\n\n` +
        `- Led a cross-functional team of ${3 + (seed % 5)} at a fictional prior employer.\n` +
        `- Improved a made-up metric by ${10 + (seed % 40)}%.\n\n` +
        `_This is invented sample data for the public demo; no real person or record._\n`,
    },
    {
      name: `${person} - Cover Letter - ${e}.pdf`,
      mime: "application/pdf",
      text:
        `%PDF-1.4 (fictional demo)\nDear Hiring Team at ${e},\n\n` +
        `I am excited to apply for the ${r} role. This letter is fictional demo content.\n\n` +
        `Sincerely,\n${person}\n`,
    },
  ];
}
