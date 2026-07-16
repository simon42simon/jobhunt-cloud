import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";
import { TrackToggleChips } from "./sourcesShared";
import { track } from "../lib/telemetry";
import type { DerivedSource, SourceActive, SourceCadence, SourceInput, SourceType } from "../types";
import {
  APIFY_INPUT_PLACEHOLDER,
  APIFY_INPUT_STUB,
  CADENCE_LABEL,
  SOURCE_ACTIVE_LABEL,
  SOURCE_ACTIVE,
  SOURCE_CADENCES,
  SOURCE_SECTORS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABEL,
  draftContractGaps,
  parseApifyInput,
  validateApifyDraft,
} from "../lib/sources";
import { validateSourceDraft } from "../lib/proposals";
import { Textarea } from "ssc-ui";

const inputCls =
  "w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]";
const selectCls = inputCls;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[#7a869d]">{hint}</span>}
    </label>
  );
}

// A chip/tag editor: Enter or comma commits the typed value; each chip has a
// remove button. Used for outputFields + aliases.
function TagEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const t = draft.trim();
    if (!t) return;
    if (!value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setDraft("");
  }

  return (
    <div className="rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-1.5">
      {value.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] py-0.5 pl-2 pr-1 text-[12px] text-[var(--color-text)]"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== tag))}
                aria-label={`Remove ${tag}`}
                // 44px hit area on touch (the x glyph stays small); compact
                // 16px again at >= sm - the JobFilterBar chip-remove idiom
                // (t-1783201082838).
                className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-edge)] hover:text-[var(--color-text)] sm:h-4 sm:w-4"
              >
                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        className="w-full bg-transparent px-1.5 py-1 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[#7c88a4]"
      />
    </div>
  );
}

// A list-of-URLs editor: one input per URL, add/remove rows.
function UrlListEditor({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const rows = value.length > 0 ? value : [""];
  function setAt(i: number, v: string) {
    const next = [...rows];
    next[i] = v;
    onChange(next);
  }
  function removeAt(i: number) {
    const next = rows.filter((_, j) => j !== i);
    onChange(next);
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((url, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="url"
            value={url}
            aria-label={`Source URL ${i + 1}`}
            placeholder="https://..."
            onChange={(e) => setAt(i, e.target.value)}
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label={`Remove URL ${i + 1}`}
            // 44px on touch, compact 36px at >= sm - the JobFilterBar
            // remove-condition idiom (t-1783201082838).
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] text-[var(--color-muted)] hover:border-rose-500/50 hover:text-rose-300 sm:h-9 sm:w-9"
          >
            <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, ""])}
        className="inline-flex min-h-[44px] w-fit items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[36px]"
      >
        <span aria-hidden="true" className="text-[var(--color-accent-text)]">+</span> Add URL
      </button>
    </div>
  );
}

export function SourceFormDrawer({
  source,
  onClose,
  onSaved,
}: {
  source?: DerivedSource | null;
  onClose: () => void;
  onSaved: (source: DerivedSource) => void;
}) {
  const editing = !!source;
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  const [name, setName] = useState(source?.name ?? "");
  const [type, setType] = useState<SourceType>(source?.type ?? "board");
  const [sector, setSector] = useState(source?.sector ?? "private");
  const [active, setActive] = useState<SourceActive>(source?.active ?? "yes");
  const [cadence, setCadence] = useState<SourceCadence>(source?.cadence ?? "manual");
  const [urls, setUrls] = useState<string[]>(source?.urls ?? []);
  const [instructions, setInstructions] = useState(source?.instructions ?? "");
  const [outputFields, setOutputFields] = useState<string[]>(source?.outputFields ?? []);
  const [aliases, setAliases] = useState<string[]>(source?.aliases ?? []);
  const [tracks, setTracks] = useState<string[]>(source?.tracks ?? []);
  const [notes, setNotes] = useState(source?.notes ?? "");

  // apify-only (type:"apify"). Editing an apify source prefills its stored
  // actor + input; a new source starts from the stub example so the owner has a
  // working shape to edit. inputErr is the near-field JSON parse advisory, set
  // on blur and cleared while typing (no nagging mid-keystroke).
  const [actorId, setActorId] = useState(source?.actorId ?? "");
  const [inputText, setInputText] = useState(
    source?.input ? JSON.stringify(source.input, null, 2) : APIFY_INPUT_STUB,
  );
  const [inputErr, setInputErr] = useState<string | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Focus management: move focus in on open, trap Tab, Esc closes, restore focus
  // on close. Uses the app's shared dialogFocus helper (getFocusableElements +
  // nextTrapTarget) so the Tab-wrap matches AddJobModal / StatusChangeModal.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const target = nextTrapTarget(
        getFocusableElements(panelRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // apify: a deterministic actor run needs a name + Actor ID + a run-input
    // JSON object (the field swap has no landing URL to validate). Non-apify:
    // the starting-link principle (DISC-W3 §11.4) - a NEW source needs only a
    // name + a landing URL; the proposal loop authors the instructions after the
    // first save. Each branch reads ONE shared rule so form and tests agree.
    const draftErr =
      type === "apify"
        ? validateApifyDraft({ name, actorId, inputText })
        : validateSourceDraft({ editing, name, urls });
    if (draftErr) {
      setErr(draftErr);
      return;
    }
    setBusy(true);
    setErr(null);
    let input: SourceInput;
    if (type === "apify") {
      // validateApifyDraft already proved this parses to an object.
      const parsed = parseApifyInput(inputText);
      input = {
        name: name.trim(),
        type,
        sector,
        active,
        cadence,
        aliases,
        tracks,
        notes,
        actorId: actorId.trim(),
        input: parsed.ok ? parsed.value : {},
      };
    } else {
      input = {
        name: name.trim(),
        type,
        sector,
        active,
        cadence,
        urls: urls.map((u) => u.trim()).filter(Boolean),
        instructions,
        outputFields,
        aliases,
        tracks,
        notes,
      };
    }
    try {
      const saved = editing ? await api.updateSource(source!.id, input) : await api.createSource(input);
      // Event name only (add vs edit) - never the source name/URL/instructions.
      track("action", "discovery-sources", editing ? "source-edit" : "source-add", { journey: "J10" });
      onSaved(saved);
    } catch (e2) {
      setErr(String((e2 as Error).message || e2));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed right-0 top-0 z-[61] flex h-full w-[min(560px,94vw)] flex-col border-l border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-edge)] p-5">
          <h2 id={titleId} className="text-[16px] font-semibold text-[var(--color-text)]">
            {editing ? "Edit source" : "Add a source"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[32px] sm:min-w-[32px]"
          >
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <Field label="Name *">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <select className={selectCls} value={type} onChange={(e) => setType(e.target.value as SourceType)}>
                  {SOURCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SOURCE_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sector">
                <select className={selectCls} value={sector} onChange={(e) => setSector(e.target.value)}>
                  {SOURCE_SECTORS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Cadence">
                <select
                  className={selectCls}
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as SourceCadence)}
                >
                  {SOURCE_CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {CADENCE_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Active">
                <select className={selectCls} value={active} onChange={(e) => setActive(e.target.value as SourceActive)}>
                  {SOURCE_ACTIVE.map((a) => (
                    <option key={a} value={a}>
                      {SOURCE_ACTIVE_LABEL[a]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="Tracks"
              hint="Leave none selected if this source feeds every track (e.g. a generic board like LinkedIn or Indeed)."
            >
              <TrackToggleChips
                selected={tracks}
                onToggle={(t) => setTracks((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
              />
            </Field>

            {type === "apify" ? (
              /* apify field swap (design §8): a deterministic actor run has no
                 landing URL / crawl instructions - the owner gives an Actor ID
                 + a run-input JSON object instead. */
              <>
                <Field
                  label="Actor ID *"
                  hint="The Apify actor to run, in username~actorName form (e.g. misceres~indeed-scraper)."
                >
                  <input
                    className={inputCls}
                    value={actorId}
                    onChange={(e) => setActorId(e.target.value)}
                    placeholder="username~indeed-scraper"
                    aria-label="Actor ID"
                  />
                </Field>

                <Field
                  label="Actor input (JSON)"
                  hint="The run input passed to the actor - search terms, location, maxItems. Must be a JSON object; the server caps maxItems to the per-run ceiling."
                >
                  <Textarea
                    className={`${inputCls} font-mono`}
                    style={{ minHeight: "120px" }}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      if (inputErr) setInputErr(null);
                    }}
                    onBlur={() => {
                      const parsed = parseApifyInput(inputText);
                      setInputErr(parsed.ok ? null : parsed.error);
                    }}
                    placeholder={APIFY_INPUT_PLACEHOLDER}
                    aria-label="Actor input JSON"
                    spellCheck={false}
                  />
                  {/* Friendly inline advisory - the same amber treatment as the
                      output-fields hint; the hard gate is validateApifyDraft on
                      submit, so this never blocks by itself. */}
                  {inputErr && <span className="text-[11px] text-amber-400">{inputErr}</span>}
                </Field>
              </>
            ) : (
              <>
                <Field
                  label={editing ? "Landing URL(s)" : "Landing URL(s) *"}
                  hint="Where the job database or board lives. The scout studies this page to propose crawl instructions from it."
                >
                  <UrlListEditor value={urls} onChange={setUrls} />
                </Field>

                <Field
                  label="Instructions"
                  hint={
                    editing
                      ? "Optional - the scout proposes these via the source's Instructions tab (leave a note there to request a change); editing here counts as a manual override. The discover-jobs routine follows this verbatim."
                      : "Optional - leave blank. Once saved, ask the scout on the source's Instructions tab and it will study the landing page and propose crawl instructions for your review."
                  }
                >
                  <Textarea
                    className={inputCls}
                    style={{ minHeight: "120px" }}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    aria-label="Scrape instructions"
                  />
                </Field>

                <Field label="Output fields" hint="Enter or comma to add. What each lead should capture.">
                  <TagEditor
                    value={outputFields}
                    onChange={setOutputFields}
                    placeholder="title, employer, deadline…"
                    ariaLabel="Output fields"
                  />
                  {/* Advisory only - saving is never gated on this (design spec §6.3).
                      Checks the LIVE DRAFT (an unsaved draft has no server-derived
                      contractGaps yet); amber, not the field's normal muted hint. */}
                  {draftContractGaps(outputFields).length > 0 && (
                    <span className="text-[11px] text-amber-400">
                      Add <code>deadline</code> and a direct-link field so Job-required data isn't missing.
                    </span>
                  )}
                </Field>
              </>
            )}

            <Field label="Aliases" hint="Other Source labels finds may already carry, so they join to this source.">
              <TagEditor value={aliases} onChange={setAliases} placeholder="add an alias…" ariaLabel="Aliases" />
            </Field>

            <Field label="Notes">
              <Textarea
                className={inputCls}
                style={{ minHeight: "60px" }}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label="Notes"
              />
            </Field>

            {err && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
                {err}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-edge)] p-4">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[36px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-[36px]"
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Add source"}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
