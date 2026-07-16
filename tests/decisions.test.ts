import { describe, it, expect } from "vitest";
import {
  OWNER_DECISION_LABEL,
  PARKED_LABEL,
  buildDeferComment,
  buildResolveWrite,
  decisionDetailBlocks,
  isParkedForOwner,
  isParkedTitle,
  labelsAfterResolve,
  latestDeferredOn,
  parkingNote,
  parseParkingNote,
  recommendedOptionKey,
  selectParkedDecisions,
  stripParkedPrefix,
} from "../src/lib/decisions";
import type { Task } from "../src/types";

// A well-formed "PARKED FOR OWNER" note, matching the autonomous-session
// template (folded so the OPTIONS lines stay on their own lines, as the served
// YAML does). Used across the parser tests below.
const TEMPLATE = `PARKED FOR OWNER (charter T3)

WHAT IT IS: Whether to move the vault sync off OneDrive to a git-only path.
WHY PARKED: Genuine product-direction fork - hard to undo either way.
OPTIONS:
  A) Keep OneDrive sync - zero migration, but a cloud dependency
  B) Git-only, drop OneDrive - clean history, needs a one-time move
RECOMMENDED DEFAULT: B) Git-only - the clean history is worth the one-time move.
WHAT I DID MEANWHILE: Left OneDrive in place and kept working on the reversible default.
HOW TO RESOLVE: Reply A / B on this ticket.`;

// Unit tests for the pure filter behind the Parked owner-decision inbox
// (US-1, t-1783317937079). Node-env style (no DOM/React), matching
// tests/intake.test.ts - this project has no component-render test layer by
// design. The lib is the single source of truth the view AND the hub count
// badge both consume, so these assertions pin the exact convention.

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t-1000",
    title: "Decide the thing",
    detail: "PARKED FOR OWNER\nWhy this needs you: ...",
    epic: "general",
    priority: "high",
    status: "triage",
    created: "2026-07-06",
    labels: [OWNER_DECISION_LABEL, PARKED_LABEL],
    ...over,
  };
}

describe("isParkedForOwner (ADR-020 union: parked label OR [PARKED] title)", () => {
  it("is true on the canonical parked label alone (non-terminal), any order, extra labels ok", () => {
    expect(isParkedForOwner(mkTask({ labels: [PARKED_LABEL], title: "no marker" }))).toBe(true);
    expect(isParkedForOwner(mkTask({ labels: [PARKED_LABEL, OWNER_DECISION_LABEL] }))).toBe(true);
    expect(isParkedForOwner(mkTask({ labels: ["bug", OWNER_DECISION_LABEL, "qa-report", PARKED_LABEL] }))).toBe(true);
  });

  it("is true on a '[PARKED]' title alone - the live drop bug: owner-decision + [PARKED] title, NO parked label", () => {
    // This is exactly the contacts/referrals US-9 and Apify tickets that the old
    // BOTH-labels rule silently excluded. The union surfaces them.
    expect(
      isParkedForOwner(mkTask({ labels: [OWNER_DECISION_LABEL, "userstory"], title: "[PARKED] Product direction: contacts layer?" })),
    ).toBe(true);
    // Even with no labels at all, the title marker alone qualifies (fail-open).
    expect(isParkedForOwner(mkTask({ labels: undefined, title: "[PARKED] decide this" }))).toBe(true);
    expect(isParkedForOwner(mkTask({ labels: [], title: "  [parked] case-insensitive + leading ws" }))).toBe(true);
  });

  it("is false when NEITHER signal is present (no parked label AND no [PARKED] title)", () => {
    expect(isParkedForOwner(mkTask({ labels: [OWNER_DECISION_LABEL], title: "Decide the thing" }))).toBe(false);
    expect(isParkedForOwner(mkTask({ labels: ["bug", "qa-report"], title: "Decide the thing" }))).toBe(false);
    expect(isParkedForOwner(mkTask({ labels: [], title: "Decide the thing" }))).toBe(false);
    expect(isParkedForOwner(mkTask({ labels: undefined, title: "Decide the thing" }))).toBe(false);
  });

  it("is false when a park signal is present but the ticket is terminal (done/canceled)", () => {
    // A resolved decision should drop off the inbox regardless of a lingering marker.
    expect(isParkedForOwner(mkTask({ status: "done" }))).toBe(false);
    expect(isParkedForOwner(mkTask({ status: "canceled" }))).toBe(false);
    expect(isParkedForOwner(mkTask({ status: "done", labels: [], title: "[PARKED] but resolved" }))).toBe(false);
  });

  it("stays true for other non-terminal columns (backlog/todo/in_progress/in_review)", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review"]) {
      expect(isParkedForOwner(mkTask({ status }))).toBe(true);
    }
  });
});

describe("isParkedTitle / stripParkedPrefix", () => {
  it("detects the [PARKED] marker case-insensitively and tolerant of leading whitespace", () => {
    expect(isParkedTitle("[PARKED] x")).toBe(true);
    expect(isParkedTitle("  [parked] x")).toBe(true);
    expect(isParkedTitle("Decide the thing")).toBe(false);
    expect(isParkedTitle(undefined)).toBe(false);
    expect(isParkedTitle("")).toBe(false);
  });

  it("strips the leading marker and leaves an unmarked title byte-identical", () => {
    expect(stripParkedPrefix("[PARKED] Product direction: contacts layer?")).toBe("Product direction: contacts layer?");
    expect(stripParkedPrefix("[parked]  extra space")).toBe("extra space");
    expect(stripParkedPrefix("Decide the thing")).toBe("Decide the thing");
    expect(stripParkedPrefix("")).toBe("");
  });
});

describe("latestDeferredOn", () => {
  it("returns the newest 'Owner deferred on DATE' comment date, or null when never deferred", () => {
    const task = mkTask({
      comments: [
        { author: "cto", ts: "2026-07-06T00:00:00.000Z", body: "some note" },
        { author: "owner", ts: "2026-07-06T01:00:00.000Z", body: "Owner deferred on 2026-07-05 - not ready." },
        { author: "owner", ts: "2026-07-06T02:00:00.000Z", body: "Owner deferred on 2026-07-06." },
      ],
    });
    expect(latestDeferredOn(task)).toBe("2026-07-06");
    expect(latestDeferredOn(mkTask({ comments: [] }))).toBeNull();
    expect(latestDeferredOn(mkTask({ comments: undefined }))).toBeNull();
    expect(latestDeferredOn(mkTask({ comments: [{ author: "owner", ts: "x", body: "unrelated" }] }))).toBeNull();
  });
});

describe("selectParkedDecisions", () => {
  it("keeps only parked tickets and sorts them newest-first", () => {
    const tasks: Task[] = [
      mkTask({ id: "t-100", created: "2026-07-01" }), // parked, oldest
      mkTask({ id: "t-300", created: "2026-07-05", labels: ["bug"] }), // not parked
      mkTask({ id: "t-200", created: "2026-07-04" }), // parked, newest
      mkTask({ id: "t-150", created: "2026-07-03", status: "done" }), // parked labels but done
    ];
    expect(selectParkedDecisions(tasks).map((t) => t.id)).toEqual(["t-200", "t-100"]);
  });

  it("breaks a same-day (created) tie by id DESC (epoch-based ids are chronological)", () => {
    const tasks: Task[] = [
      mkTask({ id: "t-1783317937079", created: "2026-07-06" }),
      mkTask({ id: "t-1783317999999", created: "2026-07-06" }),
    ];
    expect(selectParkedDecisions(tasks).map((t) => t.id)).toEqual([
      "t-1783317999999",
      "t-1783317937079",
    ]);
  });

  it("does not mutate the input array", () => {
    const tasks = [mkTask({ id: "t-1" }), mkTask({ id: "t-2", labels: ["bug"] })];
    const snapshot = tasks.map((t) => t.id);
    selectParkedDecisions(tasks);
    expect(tasks.map((t) => t.id)).toEqual(snapshot);
  });

  it("returns an empty list when nothing is parked", () => {
    expect(selectParkedDecisions([mkTask({ labels: ["bug"] })])).toEqual([]);
    expect(selectParkedDecisions([])).toEqual([]);
  });
});

describe("parkingNote", () => {
  it("returns the detail block when present", () => {
    const note = parkingNote(mkTask({ detail: "PARKED FOR OWNER\nline two" }));
    expect(note).toBe("PARKED FOR OWNER\nline two");
  });

  it("falls back to the latest comment body when detail is empty", () => {
    const task = mkTask({
      detail: "   ",
      comments: [
        { author: "cto", ts: "2026-07-06T00:00:00.000Z", body: "first" },
        { author: "cto", ts: "2026-07-06T01:00:00.000Z", body: "PARKED FOR OWNER: latest" },
      ],
    });
    expect(parkingNote(task)).toBe("PARKED FOR OWNER: latest");
  });

  it("returns an empty string when neither detail nor a comment carries a note", () => {
    expect(parkingNote(mkTask({ detail: "", comments: [] }))).toBe("");
    expect(parkingNote(mkTask({ detail: "", comments: undefined }))).toBe("");
  });
});

describe("parseParkingNote", () => {
  it("parses every section of a well-formed template", () => {
    const p = parseParkingNote(TEMPLATE);
    expect(p).not.toBeNull();
    expect(p!.whatItIs).toBe("Whether to move the vault sync off OneDrive to a git-only path.");
    expect(p!.whyParked).toBe("Genuine product-direction fork - hard to undo either way.");
    expect(p!.recommendedDefault).toBe("B) Git-only - the clean history is worth the one-time move.");
    expect(p!.whatIDidMeanwhile).toBe("Left OneDrive in place and kept working on the reversible default.");
    expect(p!.howToResolve).toBe("Reply A / B on this ticket.");
    expect(p!.raw).toBe(TEMPLATE);
  });

  it("parses OPTIONS rows into key/text/tradeoff, splitting on the first ' - '", () => {
    const opts = parseParkingNote(TEMPLATE)!.options;
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ key: "A", text: "Keep OneDrive sync", tradeoff: "zero migration, but a cloud dependency" });
    expect(opts[1]).toEqual({ key: "B", text: "Git-only, drop OneDrive", tradeoff: "clean history, needs a one-time move" });
  });

  it("ignores the leading PARKED FOR OWNER banner and any pre-header prose", () => {
    // The banner line must not leak into any field.
    const p = parseParkingNote(TEMPLATE)!;
    expect(p.whatItIs).not.toMatch(/PARKED FOR OWNER/);
  });

  it("tolerates '- A)' / '* B)' option prefixes and a missing tradeoff", () => {
    const note = `OPTIONS:\n- A) Do the thing\n* B) Do the other thing - it costs more`;
    const opts = parseParkingNote(note)!.options;
    expect(opts[0]).toEqual({ key: "A", text: "Do the thing", tradeoff: undefined });
    expect(opts[1]).toEqual({ key: "B", text: "Do the other thing", tradeoff: "it costs more" });
  });

  it("is case-insensitive on headers and uppercases option keys", () => {
    const note = `what it is: a thing\noptions:\n  a) lower-case option`;
    const p = parseParkingNote(note)!;
    expect(p.whatItIs).toBe("a thing");
    expect(p.options[0].key).toBe("A");
  });

  it("degrades missing sections to undefined but stays non-null", () => {
    const note = `WHAT IT IS: only this section\nHOW TO RESOLVE: reply here`;
    const p = parseParkingNote(note)!;
    expect(p).not.toBeNull();
    expect(p.whatItIs).toBe("only this section");
    expect(p.howToResolve).toBe("reply here");
    expect(p.whyParked).toBeUndefined();
    expect(p.recommendedDefault).toBeUndefined();
    expect(p.options).toEqual([]);
  });

  it("returns null for a non-template note or empty detail (generic fallback)", () => {
    expect(parseParkingNote("Just a plain note with no recognized headers.")).toBeNull();
    expect(parseParkingNote("")).toBeNull();
    expect(parseParkingNote("PARKED FOR OWNER (charter T3)\n\nsome prose but no sections")).toBeNull();
  });

  it("preserves internal newlines in a multi-line section body", () => {
    const note = `WHAT IT IS: line one\nline two\nline three\nWHY PARKED: spend`;
    const p = parseParkingNote(note)!;
    expect(p.whatItIs).toBe("line one\nline two\nline three");
    expect(p.whyParked).toBe("spend");
  });
});

describe("recommendedOptionKey", () => {
  it("points at the option named in RECOMMENDED DEFAULT (leading 'B)')", () => {
    expect(recommendedOptionKey(parseParkingNote(TEMPLATE)!)).toBe("B");
  });

  it("matches a bare leading letter like 'A for now'", () => {
    const note = `OPTIONS:\n  A) do nothing\n  B) build it\nRECOMMENDED DEFAULT: A for now, promote to B later`;
    expect(recommendedOptionKey(parseParkingNote(note)!)).toBe("A");
  });

  it("returns undefined when there are no options or nothing lines up", () => {
    const noOpts = parseParkingNote(`WHAT IT IS: a thing\nRECOMMENDED DEFAULT: B`)!;
    expect(recommendedOptionKey(noOpts)).toBeUndefined();
    const noMatch = parseParkingNote(`OPTIONS:\n  A) x\nRECOMMENDED DEFAULT: none of these, write your own`)!;
    expect(recommendedOptionKey(noMatch)).toBeUndefined();
  });
});

describe("labelsAfterResolve", () => {
  it("drops 'parked' and keeps every other label (owner-decision stays)", () => {
    expect(labelsAfterResolve([OWNER_DECISION_LABEL, PARKED_LABEL, "userstory"])).toEqual([
      OWNER_DECISION_LABEL,
      "userstory",
    ]);
  });

  it("is a no-op set-minus when 'parked' is absent, and tolerates undefined", () => {
    expect(labelsAfterResolve([OWNER_DECISION_LABEL])).toEqual([OWNER_DECISION_LABEL]);
    expect(labelsAfterResolve(undefined)).toEqual([]);
  });
});

describe("buildResolveWrite", () => {
  const task = mkTask({ labels: [OWNER_DECISION_LABEL, PARKED_LABEL, "userstory"] });

  it("Choose: owner comment names the chosen option, labels lose 'parked', status todo", () => {
    const opt = { key: "B", text: "Git-only, drop OneDrive" };
    const w = buildResolveWrite(task, { kind: "choose", option: opt });
    expect(w.comment).toEqual({ author: "owner", body: "Owner decision: chose Option B - Git-only, drop OneDrive." });
    expect(w.labels).toEqual([OWNER_DECISION_LABEL, "userstory"]);
    expect(w.labels).not.toContain(PARKED_LABEL);
    expect(w.status).toBe("todo");
  });

  it("Approve with a recommended text vs without", () => {
    expect(buildResolveWrite(task, { kind: "approve", recommended: "Git-only" }).comment.body).toBe(
      "Owner decision: approved the recommended default - Git-only.",
    );
    expect(buildResolveWrite(task, { kind: "approve" }).comment.body).toBe("Owner decision: approved.");
  });

  it("Resolve with note: verbatim body; 'no follow-up' sets status done", () => {
    const todo = buildResolveWrite(task, { kind: "note", body: "My own call." });
    expect(todo.comment.body).toBe("My own call.");
    expect(todo.status).toBe("todo");
    const done = buildResolveWrite(task, { kind: "note", body: "Done and dusted.", done: true });
    expect(done.status).toBe("done");
  });

  it("omits `title` when the title has no [PARKED] marker (no redundant unchanged write)", () => {
    // `task` here is titled "Decide the thing" - unmarked.
    expect("title" in buildResolveWrite(task, { kind: "approve" })).toBe(false);
  });

  it("strips the [PARKED] marker into `title` on resolve, so a still-open (todo) decision leaves the inbox", () => {
    const parkedTask = mkTask({
      labels: [OWNER_DECISION_LABEL, PARKED_LABEL, "userstory"],
      title: "[PARKED] Product direction: add a contacts layer?",
    });
    const w = buildResolveWrite(parkedTask, { kind: "note", body: "Stay applications-only for now." });
    expect(w.title).toBe("Product direction: add a contacts layer?");
    expect(w.labels).not.toContain(PARKED_LABEL);
    // status is still non-terminal (todo), so the title strip is what removes it
    // from the union inbox - isParkedForOwner sees no parked label AND no marker.
    expect(w.status).toBe("todo");
    expect(isParkedForOwner({ ...parkedTask, labels: w.labels, title: w.title! })).toBe(false);
  });
});

describe("buildDeferComment", () => {
  it("records a dated owner comment and keeps it non-resolving (parked stays)", () => {
    expect(buildDeferComment("2026-07-06")).toEqual({ author: "owner", body: "Owner deferred on 2026-07-06." });
    expect(buildDeferComment("2026-07-06", "not ready yet")).toEqual({
      author: "owner",
      body: "Owner deferred on 2026-07-06 - not ready yet.",
    });
  });
});

// A realistic, multi-PART note mirroring the LIVE contacts/referrals decision
// (t-1783318105121): a multi-line WHY PARKED paragraph, three A/B/C options, and
// a multi-line RECOMMENDED DEFAULT with reasoning. These fixtures pin that the
// detail surface can render EVERYTHING untruncated - the exact gap the fix
// closes (the card showed WHY PARKED only as a one-line chip and never showed
// the RECOMMENDED DEFAULT reasoning at all).
const LONG_TEMPLATE = `PARKED FOR OWNER (charter T3)

WHAT IT IS: Whether to build a contacts/referrals data layer alongside the vault's job files.

WHY PARKED: Genuine product-direction fork. Either choice is defensible and hard
to undo: a contacts store is a real feature users expect, but it is a second data
shape, and it enlarges the product's surface well beyond 'a view over job files.'

OPTIONS:
  A) Stay applications-only for now - zero new data shape and zero scope creep
  B) Add a lightweight contacts register - fits the read-over-YAML pattern, but a real multi-session build
  C) Full CRM layer - most capable, but the largest and least reversible

RECOMMENDED DEFAULT: A for now (do nothing), promote to B only if a real
referral-tracking need shows up in use.

WHAT I DID MEANWHILE: Chose the reversible default (A: built nothing for US-9).

HOW TO RESOLVE: Reply A / B / C (or 'defer') on this ticket.`;

describe("parseParkingNote multi-line robustness (nothing truncated)", () => {
  it("keeps the FULL multi-line WHY PARKED and RECOMMENDED DEFAULT bodies", () => {
    const p = parseParkingNote(LONG_TEMPLATE)!;
    // The whole paragraph, not the 48-char chip snippet the card used.
    expect(p.whyParked).toContain("second data");
    expect(p.whyParked).toContain("view over job files");
    // The reasoning the card never rendered anywhere.
    expect(p.recommendedDefault).toContain("promote to B only if a real");
    expect(p.recommendedDefault).toContain("referral-tracking need");
  });

  it("parses all three A/B/C options", () => {
    const opts = parseParkingNote(LONG_TEMPLATE)!.options;
    expect(opts.map((o) => o.key)).toEqual(["A", "B", "C"]);
  });

  it("APPENDS a wrapped option continuation line instead of dropping it", () => {
    // The old `.filter(match)` silently discarded any non-"X)" line in OPTIONS,
    // truncating a multi-line option. The continuation must now survive.
    const note = `OPTIONS:\n  A) Keep OneDrive sync\n     zero migration, but a cloud dependency\n  B) Git-only`;
    const opts = parseParkingNote(note)!.options;
    expect(opts).toHaveLength(2);
    expect(opts[0].key).toBe("A");
    expect(`${opts[0].text} ${opts[0].tradeoff ?? ""}`).toContain("zero migration, but a cloud dependency");
    expect(opts[1].key).toBe("B");
  });
});

describe("decisionDetailBlocks (the complete detail content model)", () => {
  it("emits every prose section in template order with FULL bodies, plus the options block", () => {
    const blocks = decisionDetailBlocks(parseParkingNote(LONG_TEMPLATE));
    const order = blocks.map((b) => (b.kind === "section" ? b.label : "OPTIONS"));
    expect(order).toEqual([
      "What it is",
      "Why parked",
      "OPTIONS",
      "Recommended default",
      "What I did meanwhile",
      "How to resolve",
    ]);
    const why = blocks.find((b) => b.kind === "section" && b.label === "Why parked");
    expect(why && why.kind === "section" && why.body).toContain("view over job files");
    const rec = blocks.find((b) => b.kind === "section" && b.label === "Recommended default");
    expect(rec && rec.kind === "section" && rec.body).toContain("promote to B only if a real");
    const opts = blocks.find((b) => b.kind === "options");
    expect(opts && opts.kind === "options" && opts.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(opts && opts.kind === "options" && opts.recommendedKey).toBe("A");
  });

  it("omits sections that are absent (no empty blocks)", () => {
    const blocks = decisionDetailBlocks(parseParkingNote(`WHAT IT IS: only this\nHOW TO RESOLVE: reply here`));
    expect(blocks.map((b) => (b.kind === "section" ? b.label : "OPTIONS"))).toEqual([
      "What it is",
      "How to resolve",
    ]);
  });

  it("returns [] for a null (non-template) parse - the view falls back to the raw note", () => {
    expect(decisionDetailBlocks(null)).toEqual([]);
    expect(decisionDetailBlocks(parseParkingNote("just a plain note, no headers"))).toEqual([]);
  });
});

describe("buildResolveWrite dismiss (close a decision without choosing an option)", () => {
  it("records an owner 'dismissed' comment, drops parked, strips the marker, and cancels the ticket", () => {
    const task = mkTask({
      labels: [OWNER_DECISION_LABEL, PARKED_LABEL, "userstory"],
      title: "[PARKED] Decide the thing",
    });
    const w = buildResolveWrite(task, { kind: "dismiss" });
    expect(w.comment).toEqual({
      author: "owner",
      body: "Owner decision: dismissed - closed without choosing an option.",
    });
    expect(w.labels).not.toContain(PARKED_LABEL);
    expect(w.labels).toContain(OWNER_DECISION_LABEL);
    expect(w.status).toBe("canceled");
    expect(w.title).toBe("Decide the thing");
    // Terminal status alone takes it off the union inbox (belt-and-braces with
    // the label drop + marker strip).
    expect(isParkedForOwner({ ...task, labels: w.labels, title: w.title!, status: w.status! })).toBe(false);
  });
});
