import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentActionsFor } from "../src/lib/agentActions";
import { STATUS_ORDER } from "../src/lib/constants";
import type { Status } from "../src/types";

// US-4/US-5: the job drawer's Agent actions are DERIVED from status. The two
// core pipeline routines (first-draft-job, finalize-job) always show; the two
// late-stage prep routines are STATUS-GATED - interview-prep only at
// `interview`, offer-prep only at `offer`, neither anywhere else. This is the
// pure gate; the drawer just maps over it (a live click-through is the MAIN
// session's job).

const routines = (status: Status) => agentActionsFor(status).map((a) => a.routine);

describe("agentActionsFor (status -> available agent actions)", () => {
  it("always offers the two core pipeline routines, in order, at every status", () => {
    for (const status of STATUS_ORDER) {
      const list = routines(status);
      expect(list.slice(0, 2)).toEqual(["first-draft-job", "finalize-job"]);
    }
  });

  it("interview shows interview-prep (and NOT offer-prep)", () => {
    const list = routines("interview");
    expect(list).toContain("interview-prep");
    expect(list).not.toContain("offer-prep");
  });

  it("offer shows offer-prep (and NOT interview-prep)", () => {
    const list = routines("offer");
    expect(list).toContain("offer-prep");
    expect(list).not.toContain("interview-prep");
  });

  it("no other status shows either prep routine", () => {
    const others = STATUS_ORDER.filter((s) => s !== "interview" && s !== "offer");
    for (const status of others) {
      const list = routines(status);
      expect(list).not.toContain("interview-prep");
      expect(list).not.toContain("offer-prep");
      expect(list).toHaveLength(2);
    }
  });

  it("the gated action carries the backend label + a stable telemetry event", () => {
    const interview = agentActionsFor("interview").find((a) => a.routine === "interview-prep");
    expect(interview).toMatchObject({ label: "Interview prep (STAR)", event: "interview-prep" });
    const offer = agentActionsFor("offer").find((a) => a.routine === "offer-prep");
    expect(offer).toMatchObject({ label: "Prep offer / negotiation", event: "offer-prep" });
  });
});

// US-6: the follow-up action's gate is NOT status alone - it is the DERIVED
// isFollowUpDue(job) signal (submitted + applied >= 7 days), threaded into the
// seam as ctx.followUpDue so the gate stays pure + testable. The drawer passes
// { followUpDue: isFollowUpDue(job) }; here we drive ctx directly. isFollowUpDue
// is only ever true at `submitted`, so in the real app followUpDue can only be
// true there - the tests exercise that contract.
describe("agentActionsFor with follow-up context (US-6 draft-follow-up gate)", () => {
  it("a submitted + follow-up-due job includes draft-follow-up (after the two core routines)", () => {
    const list = routines("submitted");
    // No context yet: submitted has no status-gated action, so just the core two.
    expect(list).toEqual(["first-draft-job", "finalize-job"]);
    const due = agentActionsFor("submitted", { followUpDue: true }).map((a) => a.routine);
    expect(due).toEqual(["first-draft-job", "finalize-job", "draft-follow-up"]);
  });

  it("a submitted + NOT-follow-up-due job does NOT include draft-follow-up", () => {
    const notDue = agentActionsFor("submitted", { followUpDue: false }).map((a) => a.routine);
    expect(notDue).not.toContain("draft-follow-up");
    expect(notDue).toEqual(["first-draft-job", "finalize-job"]);
  });

  it("omitting the context entirely is back-compatible: no draft-follow-up", () => {
    expect(agentActionsFor("submitted").map((a) => a.routine)).not.toContain("draft-follow-up");
    // The original one-arg call site behavior is unchanged at every status.
    for (const status of STATUS_ORDER) {
      expect(agentActionsFor(status)).toEqual(agentActionsFor(status, undefined));
    }
  });

  it("interview still shows interview-prep (unchanged) and never draft-follow-up", () => {
    const list = routines("interview");
    expect(list).toContain("interview-prep");
    expect(list).not.toContain("draft-follow-up");
  });

  it("the follow-up action carries the backend label + a stable telemetry event", () => {
    const followUp = agentActionsFor("submitted", { followUpDue: true }).find(
      (a) => a.routine === "draft-follow-up",
    );
    expect(followUp).toMatchObject({ label: "Draft follow-up email", event: "draft-follow-up" });
  });

  it("the interview/offer/draft/finalize behavior is identical with vs without the follow-up flag off", () => {
    for (const status of STATUS_ORDER) {
      expect(agentActionsFor(status, { followUpDue: false })).toEqual(agentActionsFor(status));
    }
  });
});

// Part 3: interview-prep REFINE is gated on ctx.interviewPrepDone (a prep draft
// exists to refine), mirroring how Finalize follows Draft - and only at `interview`.
describe("agentActionsFor with interview-prep-refine gate (Part 3)", () => {
  it("interview + interviewPrepDone shows interview-prep-refine right after interview-prep", () => {
    const list = agentActionsFor("interview", { interviewPrepDone: true }).map((a) => a.routine);
    expect(list).toContain("interview-prep-refine");
    expect(list.indexOf("interview-prep-refine")).toBe(list.indexOf("interview-prep") + 1);
  });

  it("interview WITHOUT a prep draft does not show refine", () => {
    expect(
      agentActionsFor("interview", { interviewPrepDone: false }).map((a) => a.routine),
    ).not.toContain("interview-prep-refine");
    expect(agentActionsFor("interview").map((a) => a.routine)).not.toContain("interview-prep-refine");
  });

  it("refine never appears at a non-interview status even if interviewPrepDone is set", () => {
    for (const status of STATUS_ORDER.filter((s) => s !== "interview")) {
      expect(
        agentActionsFor(status, { interviewPrepDone: true }).map((a) => a.routine),
      ).not.toContain("interview-prep-refine");
    }
  });

  it("the refine action carries the backend label + a stable telemetry event", () => {
    const refine = agentActionsFor("interview", { interviewPrepDone: true }).find(
      (a) => a.routine === "interview-prep-refine",
    );
    expect(refine).toMatchObject({ label: "Refine interview prep", event: "interview-prep-refine" });
  });
});

// t-1783650792067: "Merge PDF into one file" is an OPTIONAL post-finalize step
// gated on the DERIVED ctx.mergePdfReady (both rendered PDFs exist in the job
// folder - server toJob), never on status alone: it can surface at ANY status,
// but only when there is actually something to merge, and never by default.
describe("agentActionsFor with merge-pdf context (merge-application-pdf gate)", () => {
  it("mergePdfReady surfaces merge-application-pdf right after the two core routines, at any status", () => {
    for (const status of STATUS_ORDER) {
      const list = agentActionsFor(status, { mergePdfReady: true }).map((a) => a.routine);
      expect(list.slice(0, 3)).toEqual(["first-draft-job", "finalize-job", "merge-application-pdf"]);
    }
  });

  it("without the flag (or with it false) the action never appears", () => {
    for (const status of STATUS_ORDER) {
      expect(agentActionsFor(status).map((a) => a.routine)).not.toContain("merge-application-pdf");
      expect(agentActionsFor(status, { mergePdfReady: false }).map((a) => a.routine)).not.toContain(
        "merge-application-pdf",
      );
    }
  });

  it("composes with the other gates without disturbing them", () => {
    const list = agentActionsFor("interview", {
      mergePdfReady: true,
      interviewPrepDone: true,
    }).map((a) => a.routine);
    expect(list).toEqual([
      "first-draft-job",
      "finalize-job",
      "merge-application-pdf",
      "interview-prep",
      "interview-prep-refine",
    ]);
  });

  it("carries the backend label + a stable telemetry event + a distinct regenLabel", () => {
    const merge = agentActionsFor("ready", { mergePdfReady: true }).find(
      (a) => a.routine === "merge-application-pdf",
    );
    expect(merge).toMatchObject({
      label: "Merge PDF into one file",
      event: "merge-application-pdf",
      regenLabel: "merged application PDF",
    });
  });
});

// t-1783374313180: the job drawer's guarded button used to render the bare word
// "Regenerate" for every done action, so three done actions were visually
// identical. Each action now carries a distinct, specific regenLabel and the
// drawer renders "Regenerate <regenLabel>".
describe("agent-action regenLabel (names the specific Regenerate action)", () => {
  // Gather one instance of every action across the statuses/contexts that surface it.
  const all = [
    ...agentActionsFor("interview", { interviewPrepDone: true, followUpDue: true }),
    ...agentActionsFor("offer"),
    ...agentActionsFor("submitted", { followUpDue: true }),
    ...agentActionsFor("ready", { mergePdfReady: true }),
  ];
  const byRoutine = new Map(all.map((a) => [a.routine, a]));

  it("every action has a non-empty regenLabel", () => {
    for (const a of byRoutine.values()) {
      expect(a.regenLabel, a.routine).toBeTypeOf("string");
      expect(a.regenLabel.trim().length, a.routine).toBeGreaterThan(0);
    }
  });

  it("the regenLabels are all distinct across the guarded Regenerate buttons", () => {
    // interview-prep-refine renders its own label ("Refine interview prep"), NOT
    // "Regenerate <regenLabel>", so it is excluded: only the actions that DO
    // render a regen label must be mutually distinct (the reported ambiguity).
    const labels = [...byRoutine.values()]
      .filter((a) => a.routine !== "interview-prep-refine")
      .map((a) => a.regenLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the two core pipeline actions get specific, non-colliding names", () => {
    expect(byRoutine.get("first-draft-job")!.regenLabel).toBe("CV + cover letter");
    expect(byRoutine.get("finalize-job")!.regenLabel).toBe("finalized CV + cover letter");
  });

  it("the drawer renders the specific name (not the bare word) as text AND accessible title", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/components/JobDetail.tsx", import.meta.url)),
      "utf8",
    );
    // Visible text carries the specific action name.
    expect(src).toContain("`Regenerate ${a.regenLabel}`");
    // The old bare-word visible text is gone (the tooltip-only name is not enough).
    expect(src).not.toContain(': "Regenerate"}');
    // Title (accessible name) stays in sync with the visible text.
    expect(src).toContain("title={isRefine ? a.label : `Regenerate ${a.regenLabel}`}");
  });
});
