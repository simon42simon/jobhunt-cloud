// The honest demo label (RC-4 / SIM-88, spec U4 + AC2/AC7): a persistent, calm
// system readout under the TopBar on EVERY screen - mono uppercase, hairline
// border, never a loud color block. It carries the two things that must be
// reachable from anywhere: the CTA (v1 is GitHub only, owner decision
// 2026-07-16) and the "Replay tour" way back into the guidance (U1). Rendered
// by App ONLY when /api/config says appMode:"demo" - real mode never sees it.

// v1 CTA target (owner decision 2026-07-16): GitHub only; CV/LinkedIn come later.
export const DEMO_CTA_URL = "https://github.com/simon42simon";

export function DemoBanner({ onReplayTour }: { onReplayTour: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-1.5 md:px-5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">
        Demo · Fictional seed data · Resets nightly
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onReplayTour}
          className="inline-flex min-h-[44px] items-center rounded-md border border-[var(--color-edge)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0"
          title="Restart the 3-minute guided tour"
        >
          Replay tour
        </button>
        {/* Plain <a> navigation - no fetch, so the demo's 'self'-only CSP is
            untouched. noopener/noreferrer per the app's external-link idiom. */}
        <a
          href={DEMO_CTA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center text-[11px] text-[var(--color-accent-text)] underline decoration-[var(--color-edge)] underline-offset-2 hover:decoration-[var(--color-accent-text)] sm:min-h-0"
        >
          Built by Simon Kim · GitHub ↗
        </a>
      </div>
    </div>
  );
}
