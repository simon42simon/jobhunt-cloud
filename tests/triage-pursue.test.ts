import { describe, expect, it } from "vitest";
import { pursueLabel } from "../src/components/TriageInbox";

// Pursue = queue + draft (t-1783655444456): the old strong-fit-only fast path
// (ops audit F5) is retired. Every pursued find now lands in Queued AND kicks
// off its first agent action (first-draft-job) - see pursueFind in lib/pursue.
// pursueLabel is what survives here: the button copy that discloses the draft
// the click starts (unit, no DOM - same posture as the other pure UI helpers).
describe("pursueLabel", () => {
  it("discloses that Pursue queues the job and starts the draft", () => {
    expect(pursueLabel()).toBe("Pursue → Draft");
  });
});
