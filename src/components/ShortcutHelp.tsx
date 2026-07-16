import { useEffect, useRef } from "react";
import { SHORTCUT_SECTIONS } from "../lib/shortcuts";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";

// '?' keyboard cheat sheet (UI consistency pack t-1783183576693). A read-only
// modal dialog listing every global shortcut, rendered from the same
// SHORTCUT_SECTIONS data the handlers are documented against. Follows the
// app's dialog contract (D3): role=dialog + aria-modal + shared Tab trap +
// focus restore. Esc is deliberately NOT handled here - the app's global
// handler (App.tsx) closes this overlay on Escape, so a local one would
// double-close.
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Remember the opener, move focus onto the first control (the close button)
  // on open, and restore focus to the opener on close (unmount).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogRef.current) getFocusableElements(dialogRef.current)[0]?.focus();
    return () => opener?.focus();
  }, []);

  // Trap Tab / Shift+Tab inside the dialog (shared boundary decision).
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
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 p-4 pt-16 sm:p-6 sm:pt-24"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-[min(600px,94vw)] overflow-y-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-[var(--color-edge)] bg-[var(--color-panel)] px-5 py-4">
          <h3 id="shortcut-help-title" className="text-[15px] font-semibold text-[var(--color-text)]">
            Keyboard shortcuts
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-5 p-5 sm:grid-cols-2">
          {SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title} aria-label={section.title}>
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                {section.title}
              </h4>
              <ul className="flex flex-col gap-1.5">
                {section.items.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="min-w-0 text-[var(--color-text)]">{item.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="border-t border-[var(--color-edge)] px-5 py-3 text-[11px] text-[var(--color-muted)]">
          Shortcuts pause while you type in a field, hold Ctrl/Cmd/Alt, or have a dialog open.
        </div>
      </div>
    </div>
  );
}
