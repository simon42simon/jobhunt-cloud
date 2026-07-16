import type { EntityRef } from "./relatedEntities";

// Phase B half B (SIM-59): the in-app Product Hub is retired - the product-dev
// command center is the standalone SSC Product Hub, reading the same live
// board. This module is the ONE place that knows where that surface lives and
// how its deep links are shaped, so every handoff (related-entity chips, the
// bell's "Review decisions", the ProductMoved panel's CTA) agrees.
//
// The URL scheme mirrors the hub's hash router (SSC/apps/product-hub
// src/route.ts - pinned there by tests/route.test.ts):
//   <base>/#/<pageKey>       open that page            (e.g. #/decisions)
//   <base>/#/tasks/<id>      Tasks page, that task's drawer open
//   <base>/#/projects/<id>   Projects page filtered to that project

export const SSC_HUB_URL = "http://localhost:5185";

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

// EntityRef -> hub URL. A task lands on its drawer, a project on the Projects
// page filtered to it; a bare page key lands on that page; no target lands on
// the hub's own default view.
export function sscHubUrl(target?: EntityRef | SscHubPage): string {
  if (!target) return `${SSC_HUB_URL}/`;
  if (typeof target === "string") return `${SSC_HUB_URL}/#/${target}`;
  const page = target.kind === "task" ? "tasks" : "projects";
  return `${SSC_HUB_URL}/#/${page}/${encodeURIComponent(target.id)}`;
}

// Open (or re-navigate) the shared hub window and bring it forward. The
// current job-hunt view is deliberately left alone - the hub is its own
// surface now, not a view of this app.
export function openSscHub(target?: EntityRef | SscHubPage): void {
  const w = window.open(sscHubUrl(target), SSC_HUB_WINDOW);
  w?.focus();
}
