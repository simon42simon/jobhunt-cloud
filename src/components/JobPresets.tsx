import { useRef, type KeyboardEvent } from "react";
import type { Job } from "../types";
import { PRESETS, presetCounts } from "../lib/jobPresets";

// ---------------------------------------------------------------------------
// Preset "quick view" tabs above the Jobs list (ENG-M3-T1), live in BOTH the
// board and the table. A horizontally-scrollable role="tablist" of buttons, each
// carrying a live count badge from presetCounts. A dedicated tablist (not the
// shared SegmentedControl) because the presets are many, scrollable, and carry
// counts - but it matches the same accent-fill idiom (selected = solid accent,
// white text) and the app-wide 44px-on-touch tap targets.
//
// Roving tabindex + arrow-key navigation (Left/Right/Up/Down + Home/End) make it
// keyboard-navigable per the tablist pattern; activation stays manual (Enter /
// Space / click) so arrowing across tabs never re-filters or double-fires
// telemetry. A zero-count preset is still selectable - the list below just shows
// its normal empty state.
// ---------------------------------------------------------------------------

export function JobPresets({
  jobs,
  value,
  onChange,
}: {
  jobs: Job[];
  value: string;
  onChange: (key: string) => void;
}) {
  const counts = presetCounts(jobs);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Move focus (and scroll into view inside the overflow-x row) with wraparound.
  function focusTab(idx: number) {
    const n = PRESETS.length;
    const i = ((idx % n) + n) % n;
    const el = tabRefs.current[i];
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusTab(idx + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusTab(idx - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(PRESETS.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    // Scrolls internally so a long tab list never pushes the page body wide at
    // 280px - the row owns its own horizontal overflow.
    <div
      role="tablist"
      aria-label="Job quick views"
      className="mx-5 mb-2 flex shrink-0 items-center gap-1 overflow-x-auto"
    >
      {PRESETS.map((preset, i) => {
        const on = preset.key === value;
        const count = counts[preset.key] ?? 0;
        return (
          <button
            key={preset.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            // Roving tabindex: only the selected tab is in the Tab order; arrow
            // keys move focus across the rest (tablist pattern).
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => onChange(preset.key)}
            title={`${preset.label} (${count})`}
            className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1 text-[13px] font-medium transition sm:min-h-[32px] ${
              on
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-edge)] bg-[var(--color-panel-2)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            }`}
          >
            <span>{preset.label}</span>
            <span
              className={`min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none ${
                on ? "bg-white/25 text-white" : "bg-[var(--color-edge)] text-[var(--color-muted)]"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
