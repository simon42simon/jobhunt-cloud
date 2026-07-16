import { afterEach, describe, expect, it, vi } from "vitest";
import type { Discovery } from "../src/types";

// Pursue = queue + draft (t-1783655444456). pursueFind is the one canonical
// pursue used by BOTH surfaces (Triage inbox + source drawer Leads tab): it
// creates the job straight in "queued" and then best-effort launches the first
// agent action (first-draft-job), reporting that run back for the dock. These
// tests pin the two load-bearing guarantees: it always requests "queued", and
// a failed draft launch NEVER undoes the pursue.

// Mock the api module so no real fetch happens - we assert on the calls.
const pursueDiscovery = vi.fn();
const runRoutine = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    pursueDiscovery: (...args: unknown[]) => pursueDiscovery(...args),
    runRoutine: (...args: unknown[]) => runRoutine(...args),
  },
}));

const { pursueFind, PURSUE_DRAFT_ROUTINE } = await import("../src/lib/pursue");

function find(over: Partial<Discovery> = {}): Discovery {
  return {
    "Date Found": "2026-07-01",
    Title: "Partnerships Lead",
    Employer: "Acme",
    Sector: "private",
    Track: "b2b_gtm_focused",
    Tailoring: "light",
    Deadline: "",
    Location: "",
    Source: "",
    Link: "",
    Decision: "",
    Notes: "",
    tracked: false,
    ...over,
  };
}

afterEach(() => {
  pursueDiscovery.mockReset();
  runRoutine.mockReset();
});

describe("pursueFind", () => {
  it("creates the job in 'queued' (never 'lead'), whatever the fit", async () => {
    pursueDiscovery.mockResolvedValue({ id: "Partnerships Lead - Acme" });
    runRoutine.mockResolvedValue({ runId: "r1", label: "Draft CV + cover letter" });

    for (const Fit of ["strong", "moderate", "stretch", ""]) {
      pursueDiscovery.mockClear();
      await pursueFind(find({ Fit }));
      expect(pursueDiscovery).toHaveBeenCalledTimes(1);
      expect(pursueDiscovery.mock.calls[0][0]).toMatchObject({ status: "queued" });
    }
  });

  it("launches the first draft for the created job and reports the run", async () => {
    pursueDiscovery.mockResolvedValue({ id: "Partnerships Lead - Acme" });
    runRoutine.mockResolvedValue({ runId: "r7", label: "Draft CV + cover letter" });
    const onRunStarted = vi.fn();

    const job = await pursueFind(find({ Fit: "strong" }), onRunStarted);

    expect(job).toEqual({ id: "Partnerships Lead - Acme" });
    expect(runRoutine).toHaveBeenCalledWith(PURSUE_DRAFT_ROUTINE, "Partnerships Lead - Acme");
    expect(onRunStarted).toHaveBeenCalledWith({ runId: "r7", label: "Draft CV + cover letter" });
  });

  it("still returns the job when the draft launch fails (best-effort, no undo)", async () => {
    pursueDiscovery.mockResolvedValue({ id: "Partnerships Lead - Acme" });
    runRoutine.mockRejectedValue(new Error("too many routines running"));
    const onRunStarted = vi.fn();

    const job = await pursueFind(find({ Fit: "strong" }), onRunStarted);

    expect(job).toEqual({ id: "Partnerships Lead - Acme" });
    expect(onRunStarted).not.toHaveBeenCalled();
  });

  it("passes a real posting link through and drops a placeholder one", async () => {
    pursueDiscovery.mockResolvedValue({ id: "x" });
    runRoutine.mockResolvedValue({ runId: "r", label: "l" });

    await pursueFind(find({ Link: "https://acme.example/jobs/1" }));
    expect(pursueDiscovery.mock.calls[0][0]).toMatchObject({ link: "https://acme.example/jobs/1" });

    pursueDiscovery.mockClear();
    await pursueFind(find({ Link: "n/a" }));
    expect(pursueDiscovery.mock.calls[0][0].link).toBeUndefined();
  });
});
