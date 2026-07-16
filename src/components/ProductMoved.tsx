import { sscHubUrl, SSC_HUB_WINDOW } from "../lib/sscHub";

// Phase B handoff, made permanent (SIM-59). The product-dev command center
// lives in the standalone SSC Product Hub, reading this same board over its
// API; the legacy in-app hub is retired. This panel is the Product tab's whole
// content: it keeps the P shortcut, the TopBar tab, and `#/tasks` deep links
// landing somewhere honest, and hands the owner off to the real surface. The
// CTA targets the hub's shared named window (lib/sscHub) so repeated opens
// reuse one tab.
export function ProductMoved() {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <div className="text-4xl" aria-hidden="true">
          🧭
        </div>
        <h2 className="mt-4 text-xl font-semibold text-[var(--color-text)]">The Product Hub has moved to SSC</h2>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--color-muted)]">
          Roadmap, Projects, Tasks, Intake, Decisions, Team, Activity and Knowledge now live in the standalone{" "}
          <strong className="text-[var(--color-text)]">SSC Product Hub</strong> — the org's own command center —
          reading this same board. Job-Hunt stays focused on the job search itself.
        </p>
        <a
          href={sscHubUrl()}
          target={SSC_HUB_WINDOW}
          rel="noopener"
          className="mt-6 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-medium text-white"
          style={{ background: "var(--color-accent, #4f46e5)" }}
        >
          Open Product Hub →
        </a>
      </div>
    </div>
  );
}
