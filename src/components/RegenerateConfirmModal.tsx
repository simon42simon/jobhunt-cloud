import { useEffect, useRef } from "react";
import { Button } from "ssc-ui";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";

// Confirmation gate for re-running an action whose output ALREADY exists (Part 1).
// Regenerating overwrites the current deliverables in place, so this names exactly
// what will be replaced and reassures that a dated copy is kept (never-delete) and
// nothing is submitted. Modeled on StatusChangeModal (same dialog/focus contract):
// remember the opener, focus the safe default (Cancel) on open, trap Tab, restore
// focus on close. Esc is handled by App's global handler, as with the other modals.
export function RegenerateConfirmModal({
  title,
  role,
  employer,
  body,
  targets,
  onConfirm,
  onCancel,
}: {
  title: string;
  role: string;
  employer: string;
  body: string;
  targets: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogRef.current) getFocusableElements(dialogRef.current)[0]?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const target = nextTrapTarget(getFocusableElements(dialogRef.current), document.activeElement, e.shiftKey);
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
        aria-labelledby="regen-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[min(520px,94vw)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        {/* header */}
        <div className="border-b border-[var(--color-edge)] p-5">
          <div className="mb-2 inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-semibold text-amber-300" style={{ background: "rgba(245,158,11,0.12)" }}>
            <span aria-hidden>↻</span> Regenerate
          </div>
          <h3 id="regen-title" className="text-[15px] font-semibold leading-snug text-[var(--color-text)]">
            {title}
          </h3>
          <div className="text-[13px] text-[var(--color-muted)]">
            {role} - {employer}
          </div>
        </div>

        {/* what happens */}
        <div className="space-y-3 p-5">
          <div className="text-[13px] leading-relaxed text-[var(--color-text)]">{body}</div>
          {targets.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Will be replaced
              </div>
              <ul className="mt-1 space-y-0.5">
                {targets.map((t) => (
                  <li key={t} className="truncate text-[12.5px] text-[var(--color-text)]">
                    <span aria-hidden className="text-[var(--color-muted)]">•</span> {t}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-300">
            ⚡ A dated copy of the current version is kept in the job folder. Nothing is deleted or submitted.
          </div>
        </div>

        {/* actions */}
        {/* SIM-43 / DS-5: ssc-ui Button adoption. Cancel -> outline. Regenerate is
            a WARNING action with no DS variant yet, so it uses the default Button
            with a className override (tailwind-merge lets bg-amber-* win over
            bg-primary) - the documented escape hatch until a warning variant lands. */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-edge)] p-4">
          <Button
            variant="outline"
            onClick={onCancel}
            className="min-h-[44px] sm:min-h-0"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className="min-h-[44px] bg-amber-500 font-semibold text-black hover:bg-amber-400 sm:min-h-0"
          >
            Regenerate
          </Button>
        </div>
      </div>
    </div>
  );
}
