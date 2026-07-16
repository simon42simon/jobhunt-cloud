import { useEffect, useRef, useState } from "react";
import { Button } from "ssc-ui";
import { api } from "../api";
import type { AppConfig } from "../types";
import { STATUS_LABEL, STATUS_ORDER } from "../lib/constants";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";

const inputCls =
  "w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]";

const SECTORS = ["private", "municipal", "provincial", "federal", "bps", "nonprofit"];

// Agent-first intake: a human only supplies what a human actually knows at lead
// time (role, employer, sector, deadline). track + fit are assessed by the
// first-draft-job agent, so we deliberately do NOT ask for them here.
export function AddJobModal({
  config,
  onClose,
  onCreated,
}: {
  config: AppConfig | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    role: "",
    employer: "",
    status: "lead",
    sector: "private",
    deadline: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);

  // Dialog contract (D3), matching JobDetail / ChatCapture / NotificationPanel:
  // remember the opener, move focus into the dialog on open, and hand focus back
  // to the opener on close (unmount). Esc is deliberately NOT handled here - the
  // app's global handler (App.tsx) already closes this modal on Escape, so a local
  // one would double-close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogRef.current) getFocusableElements(dialogRef.current)[0]?.focus();
    return () => opener?.focus();
  }, []);

  // Trap Tab / Shift+Tab inside the dialog so focus can never land on the page
  // behind it.
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

  function set(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.role.trim() || !form.employer.trim()) {
      setErr("Role and employer are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const job = await api.createJob(form);
      onCreated(job.id);
    } catch (e2) {
      setErr(String((e2 as Error).message || e2));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-6 pt-24" onClick={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-job-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[min(520px,94vw)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 shadow-2xl"
      >
        <h3 id="add-job-title" className="mb-1 text-[16px] font-semibold text-[var(--color-text)]">Add a lead</h3>
        <p className="mb-4 text-[12px] leading-relaxed text-[#7a869d]">
          Capture a posting you found. The first-draft-job agent assigns the track and fit when you draft it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Role *</span>
            <input className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value)} />
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Employer *</span>
            <input className={inputCls} value={form.employer} onChange={(e) => set("employer", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Sector</span>
            <select className={inputCls} value={form.sector} onChange={(e) => set("sector", e.target.value)}>
              {SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Status</span>
            <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value)}>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Deadline</span>
            <input type="date" className={inputCls} value={form.deadline} onChange={(e) => set("deadline", e.target.value)} />
          </label>
        </div>
        {err && <div className="mt-3 text-[12px] text-rose-400">{err}</div>}
        <div className="mt-3 text-[11px] text-[var(--color-muted)]">
          Creates a new folder in your vault: <code className="text-[var(--color-accent-text)]">Jobs/{form.role || "Role"} - {form.employer || "Employer"}/</code>
        </div>
        {/* SIM-43 / DS-5: first ssc-ui primitive adoption. Cancel -> outline,
            primary submit -> default (dark --primary === jobhunt --color-accent).
            The min-h-[44px] sm:min-h-0 override preserves the mobile tap-target
            contract the ad-hoc buttons enforced. */}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="min-h-[44px] sm:min-h-0"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy}
            className="min-h-[44px] sm:min-h-0"
          >
            {busy ? "Creating..." : "Add lead"}
          </Button>
        </div>
      </form>
    </div>
  );
}
