// The ONE undo toast (UI consistency pack t-1783183576693): App's status-move
// toast and TriageInbox's skip/maybe toast used to carry near-identical copies
// of this markup. The toast is purely presentational - the OWNER of the undo
// state keeps its own auto-dismiss timer (the ~6s convention) and undo
// semantics, because those are tied to its state shape.
//
// role="status" so the move is announced politely; the Undo button is a 44px
// tap target on touch (relaxed at >= sm, the app-wide phone-fit idiom); the
// toast clamps to the viewport so a long role/title can never force horizontal
// overflow at 390px.
export function UndoToast({
  onUndo,
  children,
}: {
  onUndo: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-[70] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-2 text-[13px] text-[var(--color-text)] shadow-2xl"
    >
      <span className="min-w-0 truncate">{children}</span>
      <button
        type="button"
        onClick={onUndo}
        className="min-h-[44px] shrink-0 rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] font-semibold text-[var(--color-accent-text)] hover:border-[var(--color-accent)] sm:min-h-0"
      >
        Undo
      </button>
    </div>
  );
}
