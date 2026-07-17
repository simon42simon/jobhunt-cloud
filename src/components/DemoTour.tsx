import { useEffect, useMemo, useState } from "react";
import type { Job } from "../types";
import {
  anchorSelector,
  calloutFor,
  findHeroes,
  nextStep,
  TOUR_MEMORY_KEY,
  type TourMemory,
  type TourStep,
} from "../lib/demoTour";

// The demo-mode guided tour (RC-4 / SIM-88): a non-blocking first-run choice,
// three dismissible spotlight callouts anchored to LIVE elements, and a close
// panel. The single load-bearing rule (spec U1): nothing here ever blocks the
// app - no backdrop, no aria-modal, no click interception. The spotlight is
// pointer-events:none chrome AROUND the real element; the callout is a small
// card that owns only its own pixels. A visitor who clicks anywhere else gets
// the app's normal behavior. Beat 3's spectacle is the EXISTING run panel
// animating a canned replay - this component adds no animation of its own.
// Rendered by App only when appMode === "demo"; real mode never mounts it.

// Session memory, best-effort like App's view memory (a blocked storage just
// means the first-run choice reappears - never an error).
function loadMemory(): TourMemory | null {
  try {
    const v = window.sessionStorage.getItem(TOUR_MEMORY_KEY);
    if (v === "dismissed" || v === "completed") return v;
  } catch {
    /* storage unavailable - treat as first run */
  }
  return null;
}
function saveMemory(v: TourMemory) {
  try {
    window.sessionStorage.setItem(TOUR_MEMORY_KEY, v);
  } catch {
    /* best-effort */
  }
}

type Rect = { top: number; left: number; width: number; height: number };

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

// Track the anchor element's viewport rect while a beat shows - fully
// EVENT-DRIVEN (QA idle finding): a debounced MutationObserver catches the
// anchor appearing/vanishing (the drawer mounting after the invited click, a
// filter hiding a card), capture-phase scroll + resize catch it moving. No
// polling interval and no rAF loop, so a quiet page actually reaches idle; the
// ring's movement is animated by the .demo-spotlight CSS transition alone.
function useAnchorRect(selector: string | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    let last: Rect | null = null;
    let scrolledAt = 0; // last scrollIntoView for THIS selector (0 = not yet)
    let timer = 0;
    const offscreen = (r: DOMRect) =>
      r.right < 0 || r.left > window.innerWidth || r.bottom < 0 || r.top > window.innerHeight;
    const measure = () => {
      const el = document.querySelector(selector);
      if (el) {
        // QA BUG-2: bring the anchor into view DETERMINISTICALLY - instantly
        // (behavior:"auto"; a smooth scroll can be cancelled mid-flight and
        // strand the anchor off-viewport), centered on the horizontal axis
        // (the board scrolls sideways and a hero card can sit a full viewport
        // off to either edge). Fires on first sight of the anchor, and AGAIN
        // if a later layout/scroll pushed it fully off-viewport - so the
        // callout can never narrate an invisible element.
        const now = Date.now();
        if (scrolledAt === 0 || (offscreen(el.getBoundingClientRect()) && now - scrolledAt > 600)) {
          scrolledAt = now;
          el.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
        }
      }
      const r = el?.getBoundingClientRect() ?? null;
      const next = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
      if (!sameRect(last, next)) {
        last = next;
        setRect(next);
      }
    };
    // Trailing debounce: a mutation/scroll burst costs ONE layout read after it
    // settles, and nothing at all runs while the page is quiet.
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 80);
    };
    measure();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    // Scroll events are rAF-timed - a hidden tab suppresses them - so re-measure
    // when the tab comes back to the foreground and the ring snaps to truth.
    document.addEventListener("visibilitychange", schedule);
    return () => {
      window.clearTimeout(timer);
      mo.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [selector]);
  return rect;
}

const CALLOUT_W = 300;

// Place the callout NEXT TO the anchor, never over it: below when there is
// room, flipped above when the bottom edge is tight, and tucked inside the
// top-left for a viewport-scale anchor (beat 1's whole board). No anchor found
// (hero filtered off the board) degrades to a fixed top-center card - the copy
// still reads, nothing breaks.
function calloutStyle(rect: Rect | null): React.CSSProperties {
  if (!rect) return { top: 96, left: "50%", transform: "translateX(-50%)" };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampLeft = (l: number) => Math.min(Math.max(l, 8), Math.max(8, vw - CALLOUT_W - 8));
  if (rect.height > vh * 0.5) return { top: rect.top + 16, left: clampLeft(rect.left + 16) };
  if (rect.top + rect.height + 220 < vh)
    return { top: rect.top + rect.height + 10, left: clampLeft(rect.left) };
  return { top: Math.max(8, rect.top - 10), left: clampLeft(rect.left), transform: "translateY(-100%)" };
}

// Shared button classes, matching the app's control idiom (44px tap targets on
// small screens, natural height on desktop).
const primaryBtn =
  "inline-flex min-h-[44px] items-center rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 sm:min-h-0";
const quietBtn =
  "inline-flex min-h-[44px] items-center rounded-md border border-[var(--color-edge)] px-2.5 py-1.5 text-[12px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0";
const monoTag =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]";

export function DemoTour({
  jobs,
  selectedJob,
  replaySignal,
  onEnsureBoard,
  onCloseDrawer,
}: {
  jobs: Job[];
  selectedJob: string | null;
  // Bumped by the banner's "Replay tour" (U1: re-launchable on demand, even
  // after a dismissal). App forces the Jobs board view before bumping.
  replaySignal: number;
  // Called when the tour starts from its own buttons, so beat 1's anchor (the
  // board) is actually on screen even if the visitor wandered to another view.
  onEnsureBoard: () => void;
  // App's closeJob: Next-ing into a card-anchored beat closes a STALE drawer
  // (e.g. Hero A's, left open from beat 2) so the next hero card is clickable
  // in one click, not hidden behind the previous drawer's backdrop.
  onCloseDrawer: () => void;
}) {
  const [step, setStep] = useState<TourStep | null>(() => (loadMemory() ? null : "choice"));
  // A beat advance WAITING for a stale drawer to actually unmount (QA BUG-1):
  // the target step is parked here instead of rendered immediately, so a
  // card-anchored beat can never mis-anchor into (or under) a drawer that is
  // still on its way out. Completed by the effect below.
  const [pending, setPending] = useState<TourStep | null>(null);
  const heroes = useMemo(() => findHeroes(jobs), [jobs]);

  useEffect(() => {
    if (replaySignal > 0) {
      setPending(null);
      setStep("beat1");
    }
  }, [replaySignal]);

  // Complete a parked advance once the drawer is GONE (or is the target hero's
  // own). If the drawer refuses to die - QA's zombie: route state drifted from
  // the URL, so the first close was a silent no-op - RE-ISSUE the close (
  // navigate() is now self-healing on a same-hash assignment, lib/router) and
  // after a short grace force the advance anyway, so the tour can never hang.
  useEffect(() => {
    if (!pending) return;
    const target =
      pending === "beat2" ? heroes.heroA?.id : pending === "beat3" ? heroes.heroB?.job.id : null;
    if (!selectedJob || selectedJob === target) {
      setStep(pending);
      setPending(null);
      return;
    }
    const retry = window.setTimeout(onCloseDrawer, 250);
    const force = window.setTimeout(() => {
      onCloseDrawer();
      setStep(pending);
      setPending(null);
    }, 1200);
    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(force);
    };
  }, [pending, selectedJob, heroes, onCloseDrawer]);

  // Reaching the close panel IS completion (AC4's end state) - remember it
  // immediately so a reload from here never re-prompts the first-run choice.
  useEffect(() => {
    if (step === "close") saveMemory("completed");
  }, [step]);

  // Hooks above any early return. The selector is null outside the 3 beats.
  const isBeat = step === "beat1" || step === "beat2" || step === "beat3";
  const selector = isBeat && step ? anchorSelector(step, heroes, selectedJob) : null;
  const rect = useAnchorRect(selector);

  // Nothing to point at until the board has jobs (the cold open paints the
  // seeded board first; the choice rides in beside it, never before it).
  if (!step || jobs.length === 0) return null;

  function dismiss() {
    saveMemory("dismissed");
    setPending(null);
    setStep(null);
  }
  function start() {
    onEnsureBoard();
    setPending(null);
    setStep("beat1");
  }
  // Advance one beat. If the NEXT beat anchors a hero's board card while some
  // OTHER job's drawer is still open (beat 2's Hero A, typically), close it and
  // PARK the advance until the drawer has actually unmounted (QA BUG-1) -
  // otherwise the invited click lands on the old drawer's backdrop instead of
  // the spotlighted card. Never closes a drawer already showing the target.
  function advance(from: "beat1" | "beat2" | "beat3") {
    const to = nextStep(from, heroes);
    const staleDrawer =
      (to === "beat2" && !!selectedJob && selectedJob !== heroes.heroA?.id) ||
      (to === "beat3" && !!selectedJob && selectedJob !== heroes.heroB?.job.id);
    if (staleDrawer) {
      onCloseDrawer();
      setPending(to);
    } else {
      setStep(to);
    }
  }

  if (step === "choice") {
    return (
      <section
        aria-label="Demo tour"
        className="fixed bottom-4 left-4 z-[60] w-[min(320px,calc(100vw-2rem))] rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <span className={monoTag}>Guided tour</span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0 sm:px-1"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text)]">
          Three stops, under three minutes: the pipeline, the generated materials, the agent at
          work.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" onClick={start} className={primaryBtn}>
            Take the 3-min tour
          </button>
          <button type="button" onClick={dismiss} className={quietBtn}>
            Explore on my own
          </button>
        </div>
      </section>
    );
  }

  if (step === "close") {
    return (
      <section
        aria-label="Demo tour"
        className="fixed bottom-4 left-4 z-[60] w-[min(340px,calc(100vw-2rem))] rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 shadow-2xl"
      >
        <span className={monoTag}>Tour done</span>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text)]">
          Discover, draft, finalize, track - that is the whole loop, and none of it is gated.
          Everything on the board is clickable.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setStep(null)} className={primaryBtn}>
            Explore on your own
          </button>
          <button type="button" onClick={start} className={quietBtn}>
            Replay tour
          </button>
        </div>
        {/* The CTA also lives in the always-visible banner (AC7) - repeated
            here because the close panel is where an earned click happens. */}
        <a
          href="https://github.com/simon42simon"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex min-h-[44px] items-center text-[11px] text-[var(--color-accent-text)] underline decoration-[var(--color-edge)] underline-offset-2 hover:decoration-[var(--color-accent-text)] sm:min-h-0"
        >
          Built by Simon Kim · GitHub ↗
        </a>
      </section>
    );
  }

  // One of the 3 beats: quiet accent ring around the live anchor (U5 - a
  // highlight state on the existing token, not a new visual) + a small card.
  const callout = calloutFor(step, heroes, selectedJob);
  return (
    <>
      {rect && (
        <div
          className="demo-spotlight"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
          aria-hidden="true"
        />
      )}
      <section
        aria-label={callout.tag}
        className="fixed z-[60] w-[min(300px,calc(100vw-2rem))] rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 shadow-2xl"
        style={calloutStyle(rect)}
      >
        <span className={monoTag}>{callout.tag}</span>
        <div className="mt-1 text-[13px] font-semibold text-[var(--color-text)]">
          {callout.title}
        </div>
        {/* polite live region: the beat-2/3 copy switches when the invited
            click opens the drawer, and that switch should announce itself. */}
        <p aria-live="polite" className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
          {callout.body}
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <button type="button" onClick={() => advance(step)} className={primaryBtn}>
            {callout.next}
          </button>
          {/* Visible "Skip tour" at every step (U1) - never just a corner X. */}
          <button type="button" onClick={dismiss} className={quietBtn}>
            Skip tour
          </button>
        </div>
      </section>
    </>
  );
}
