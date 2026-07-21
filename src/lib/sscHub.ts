import type { EntityRef } from "./relatedEntities";

// Phase B half B (SIM-59): the in-app Product Hub is retired - the product-dev
// command center is the standalone SSC Product Hub, reading the same live
// board. This module is the ONE place that knows how that surface's deep
// links are shaped, so every handoff (related-entity chips, the bell's
// "Review decisions", the ProductMoved panel's CTA) agrees.
//
// SIM-426 (GATE 2 fix): the hub's BASE URL is no longer hardcoded here - it
// only ever resolves for someone on the SAME machine as the hub process (i.e.
// Simon's laptop against local dev), so a hardcoded localhost URL rendered a
// dead link on every hosted instance (private AND public demo alike). The
// server now declares the real answer per deployment (`AppConfig.sscHubUrl`,
// GET /api/config - null on every hosted/pg-backed instance); every function
// here takes that resolved base as an explicit `hubUrl` param instead, and
// every call site is expected to check it is non-null before calling in
// (App.tsx's openEntity/openDecisions, ProductMoved) - see each call site for
// how it renders when there is nothing to link to.
//
// The URL scheme mirrors the hub's hash router (SSC/apps/product-hub
// src/route.ts - pinned there by tests/route.test.ts):
//   <base>/#/<pageKey>       open that page            (e.g. #/decisions)
//   <base>/#/tasks/<id>      Tasks page, that task's drawer open
//   <base>/#/projects/<id>   Projects page filtered to that project

// The named window every handoff reuses: repeated opens re-navigate ONE hub
// tab (its router applies each new hash) instead of spawning tab litter.
export const SSC_HUB_WINDOW = "ssc-hub";

// The hub's page keys (subset we link to; the hub accepts more).
export type SscHubPage =
  | "roadmap"
  | "projects"
  | "tasks"
  | "intake"
  | "decisions"
  | "team"
  | "activity"
  | "docs"
  | "usage";

// EntityRef -> hub URL, given a resolved (non-null) hub base. A task lands on
// its drawer, a project on the Projects page filtered to it; a bare page key
// lands on that page; no target lands on the hub's own default view.
export function sscHubUrl(hubUrl: string, target?: EntityRef | SscHubPage): string {
  if (!target) return `${hubUrl}/`;
  if (typeof target === "string") return `${hubUrl}/#/${target}`;
  const page = target.kind === "task" ? "tasks" : "projects";
  return `${hubUrl}/#/${page}/${encodeURIComponent(target.id)}`;
}

// Open (or re-navigate) the shared hub window and bring it forward. The
// current job-hunt view is deliberately left alone - the hub is its own
// surface now, not a view of this app. No-op when there is no hub to open
// (hubUrl null/empty - a hosted instance): callers should already be hiding
// the affordance that triggers this, but this stays a hard no-op too rather
// than ever falling back to a guessed URL.
export function openSscHub(hubUrl: string | null | undefined, target?: EntityRef | SscHubPage): void {
  if (!hubUrl) return;
  const w = window.open(sscHubUrl(hubUrl, target), SSC_HUB_WINDOW);
  w?.focus();
}
