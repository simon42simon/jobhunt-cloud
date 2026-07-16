// Pursue = one decisive action (t-1783655444456): take a discovery find, create
// the tracked job straight in "queued", AND immediately kick off its first agent
// action (first-draft-job) so the CV + cover letter draft is already running.
//
// This retires the old strong-fit-only fast path (ops audit F5): every pursued
// find now goes queue + draft, because "Pursue" means "start this application".
// The queued -> drafted auto-advance (server nextStatusAfterRun) then completes
// the pipeline once the run lands, so the owner clicks once and the job walks
// itself from find to drafted.
//
// Shared by BOTH pursue surfaces (the Triage inbox row/detail and the source
// drawer's Leads tab) so the mapping + the auto-draft can never drift between
// them - one canonical pursue, one place (structural-root-cause-fixes).

import { api } from "../api";
import { isRealUrl } from "./sources";
import type { Discovery, Job } from "../types";

// The routine a Pursue auto-launches: the job's first agent action. Mirrors the
// BASE_ACTIONS head in lib/agentActions.ts and the server ROUTINES key.
export const PURSUE_DRAFT_ROUTINE = "first-draft-job";

// Pursue a find. Creates the job in "queued", then best-effort launches the
// first draft and reports the run back via onRunStarted (for the run dock).
//
// The draft launch is best-effort ON PURPOSE: a rejected launch (run cap 429,
// offline, a draft already queued for this job) NEVER undoes the pursue - the
// job still exists in Queued and stays draftable from its drawer. Returns the
// created job so the caller can open it, exactly as the old inline path did.
export async function pursueFind(
  find: Discovery,
  onRunStarted?: (run: { runId: string; label: string }) => void,
): Promise<Job> {
  const job = await api.pursueDiscovery({
    title: find.Title,
    employer: find.Employer,
    track: find.Track,
    fit: find.Fit,
    sector: find.Sector,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(find.Deadline) ? find.Deadline : undefined,
    link: isRealUrl(find.Link) ? find.Link : undefined,
    status: "queued",
  });
  try {
    const run = await api.runRoutine(PURSUE_DRAFT_ROUTINE, job.id);
    onRunStarted?.({ runId: run.runId, label: run.label });
  } catch {
    // Best-effort: the job is queued and remains draftable from its drawer.
  }
  return job;
}
