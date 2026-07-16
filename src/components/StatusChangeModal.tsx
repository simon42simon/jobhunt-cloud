import { useEffect, useRef } from "react";
import { STATUS_ACCENT, STATUS_INFO, STATUS_LABEL } from "../lib/constants";
import { readableOn } from "../lib/utils";
import type { Status } from "../types";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";

// Shown on every status change (drag on the board, or the table dropdown) so you
// see the trigger and exactly what will happen before it is written to the file.
export function StatusChangeModal({
  role,
  employer,
  from,
  to,
  onConfirm,
  onCancel,
}: {
  role: string;
  employer: string;
  from: Status;
  to: Status;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const info = STATUS_INFO[to];
  const fromColor = STATUS_ACCENT[from];
  const toColor = STATUS_ACCENT[to];
  // Confirm button: status-colored fill with a text color that clears WCAG AA
  // (white-on-amber/emerald/etc. failed badly otherwise).
  const confirmBtn = readableOn(toColor);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Dialog contract (D3), matching JobDetail / ChatCapture / NotificationPanel:
  // remember the opener, move focus onto the first control (Cancel - the safe
  // default for a confirmation gate) on open, and restore focus to the opener on
  // close (unmount). Esc is deliberately NOT handled here - the app's global
  // handler (App.tsx) already closes this modal on Escape, so a local one would
  // double-close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogRef.current) getFocusableElements(dialogRef.current)[0]?.focus();
    return () => opener?.focus();
  }, []);

  // Trap Tab / Shift+Tab inside the dialog so focus can never move to controls
  // BEHIND the confirmation gate.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const target = nextTrapTarget(
        getFocusableElements(dialogRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 p-6 pt-28" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-change-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[min(520px,94vw)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        {/* header: the transition */}
        <div className="border-b border-[var(--color-edge)] p-5">
          <div className="mb-3 flex items-center gap-2">
            <span
              className="rounded px-2 py-0.5 text-[12px] font-semibold"
              style={{ color: fromColor, background: `${fromColor}22` }}
            >
              {STATUS_LABEL[from]}
            </span>
            <span className="text-[var(--color-muted)]">-&gt;</span>
            <span
              className="rounded px-2 py-0.5 text-[12px] font-semibold"
              style={{ color: toColor, background: `${toColor}22` }}
            >
              {STATUS_LABEL[to]}
            </span>
          </div>
          <h3
            id="status-change-title"
            className="text-[15px] font-semibold leading-snug text-[var(--color-text)]"
          >
            {role}
          </h3>
          <div className="text-[13px] text-[var(--color-muted)]">{employer}</div>
        </div>

        {/* trigger + impact */}
        <div className="space-y-3 p-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Trigger</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-text)]">{info.trigger}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">What happens</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-text)]">{info.impact}</div>
          </div>
          {info.effect && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-300">
              ⚡ {info.effect}
            </div>
          )}
          {info.next && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Next move</div>
              <div className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-muted)]">{info.next}</div>
            </div>
          )}
          <div className="text-[11px] text-[#7a869d]">
            Writes <code className="text-[var(--color-accent-text)]">status: {to}</code> to the job file. Nothing is submitted or deleted.
          </div>
        </div>

        {/* actions */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-edge)] p-4">
          <button
            onClick={onCancel}
            className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="min-h-[44px] rounded-md px-3 py-1.5 text-[13px] font-semibold hover:opacity-90 sm:min-h-0"
            style={{ background: confirmBtn.bg, color: confirmBtn.fg }}
          >
            Move to {STATUS_LABEL[to]}
          </button>
        </div>
      </div>
    </div>
  );
}
