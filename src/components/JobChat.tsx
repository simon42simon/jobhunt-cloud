import { useEffect, useRef, useState } from "react";
import type React from "react";
import { api } from "../api";
import type { ChatMessage } from "../types";
import { MarkdownLite } from "./MarkdownLite";
import { Textarea } from "ssc-ui";

// Labels for the "Run this" button on an assistant-suggested action (Part 4).
// Mirrors the agent-action / ROUTINES labels the job page already uses.
const ROUTINE_LABEL: Record<string, string> = {
  "first-draft-job": "Draft CV + cover letter",
  "finalize-job": "Finalize application",
  "interview-prep": "Interview prep",
  "interview-prep-refine": "Refine interview prep",
  "offer-prep": "Prep offer / negotiation",
  "draft-follow-up": "Draft follow-up email",
};

// Per-job assistant chat pinned to the bottom of the job drawer (Part 4). The
// assistant is READ-ONLY server-side; when it recommends a guarded action, the
// "Run this" button routes through onRunSuggested, which reuses the SAME guarded
// path (confirm modal / direct run) as the action buttons - the human confirms.
//
// SIM-425: on demo/hosted the assistant is a `claude` CLI spawn that does not
// exist in the deployed image, so it is gated off entirely - server-side (the
// POST route returns an honest disabled response instead of spawning it) and
// here client-side (a visitor never sees a working compose box to begin with).
// `demoMode` mirrors DemoBanner/DemoTour's own appMode === "demo" check.
export function JobChat({
  jobId,
  onRunSuggested,
  demoMode = false,
}: {
  jobId: string;
  onRunSuggested: (routine: string) => void;
  demoMode?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .getJobChat(jobId)
      .then((r) => alive && (setMessages(r.messages), setLoaded(true)))
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Keep the newest message in view as the transcript grows / while thinking.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending || demoMode) return; // demo: no compose box reaches here, but guard anyway
    setErr(null);
    setSending(true);
    // Optimistic user bubble so the input clears and the message shows instantly.
    setMessages((m) => [...m, { role: "user", content: text, ts: new Date().toISOString() }]);
    setInput("");
    try {
      const r = await api.postJobChat(jobId, text);
      // SIM-425: a disabled response (demo/hosted) carries the transcript
      // UNCHANGED, no fake reply - drop the optimistic bubble back to what the
      // server actually holds rather than leaving an unanswered user message.
      setMessages(r.messages);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="shrink-0 border-t border-[var(--color-edge)] px-5 py-4">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Ask about this job
      </div>
      <p className="mb-2.5 text-[11px] leading-relaxed text-[#7a869d]">
        A read-only assistant that answers from this job's files. It can suggest a rerun or a fix - you
        confirm it. It never edits or sends anything.
      </p>
      {demoMode && (
        <p
          role="status"
          className="mb-2.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-2 text-[12px] leading-relaxed text-[#7a869d]"
        >
          The live assistant is turned off in the hosted demo.
        </p>
      )}
      <div ref={listRef} className="mb-2 flex max-h-[320px] flex-col gap-2 overflow-y-auto">
        {loaded && messages.length === 0 && (
          <p className="text-[12px] text-[#7a869d]">
            No messages yet. Ask a question, or say what's wrong with a generated doc.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-lg border px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text)] ${
              m.role === "user"
                ? "self-end border-[var(--color-accent)] bg-[var(--color-panel-2)]"
                : "self-start border-[var(--color-edge)] bg-[var(--color-panel-2)]"
            }`}
          >
            {/* Tolerant render (SIM-599 / t-1784782689793): a transcript message
                with a missing/malformed `content` (e.g. a stored payload written
                under another key) renders as an empty bubble - MarkdownLite
                calls .replace on its text, so an undefined here crashed the
                whole app (the drawer mounts outside <main>'s ErrorBoundary). */}
            {m.role === "assistant" ? (
              <MarkdownLite text={m.content ?? ""} />
            ) : (
              <span className="whitespace-pre-wrap">{m.content ?? ""}</span>
            )}
            {m.suggestedAction && ROUTINE_LABEL[m.suggestedAction.routine] && (
              <button
                onClick={() => onRunSuggested(m.suggestedAction!.routine)}
                className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-amber-500/40 bg-[var(--color-panel)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-amber-400"
              >
                <span className="text-amber-300" aria-hidden>
                  ↻
                </span>{" "}
                Run this: {ROUTINE_LABEL[m.suggestedAction.routine]}
              </button>
            )}
          </div>
        ))}
        {sending && <p className="self-start text-[12px] text-[#7a869d]">Assistant is thinking...</p>}
      </div>
      {err && <div className="mb-2 text-[11px] text-rose-400">{err}</div>}
      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={demoMode ? "Assistant unavailable in the hosted demo" : "Ask about this job, or say what to fix..."}
          rows={2}
          className="flex-1 px-3 py-2 text-[13px]"
          aria-label="Message the job assistant"
          disabled={demoMode}
        />
        <button
          onClick={send}
          disabled={demoMode || sending || !input.trim()}
          aria-disabled={demoMode || sending || !input.trim()}
          className="min-h-[44px] rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0"
        >
          Send
        </button>
      </div>
    </div>
  );
}
