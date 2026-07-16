import { describe, expect, it } from "vitest";
import { barsSummary, velocityWeekName, velocitySummary } from "../src/components/InsightsView";
import { progressValueText } from "../src/lib/roadmapDerive";

// D8 - the Insights bar/funnel/velocity charts and the Roadmap progress meter
// were div-only (no role/aria), so a screen reader got loose visible numerals
// instead of a chart. Each chart container now exposes ONE text alternative
// (role="img" + aria-label, or role="progressbar" + aria-valuetext) built by
// these pure helpers. This suite proves the alternative text actually carries
// the whole chart's meaning - every datum, in order, with its value - which is
// exactly what an assistive-tech user now hears. Layer: unit (no DOM, same
// node-env posture as statusColors / notifications-ui tests): the helpers are
// the accessible name; if they name every datum, the container does too.

describe("barsSummary (funnel / by-track / by-sector charts)", () => {
  // Mirrors InsightsView's real funnelRows shape (from STATUS_LABEL + counts).
  const funnel = [
    { label: "Lead", count: 3 },
    { label: "Queued", count: 2 },
    { label: "Drafted", count: 1 },
    { label: "Submitted", count: 4 },
    { label: "Interview", count: 1 },
    { label: "Offer", count: 0 },
  ];

  it("names the chart and every stage with its count, in order", () => {
    expect(barsSummary("Pipeline funnel", funnel)).toBe(
      "Pipeline funnel: Lead 3, Queued 2, Drafted 1, Submitted 4, Interview 1, Offer 0"
    );
  });

  it("drops no datum - every row's label AND count survive into the alt text", () => {
    const summary = barsSummary("By track", funnel);
    for (const r of funnel) {
      expect(summary).toContain(`${r.label} ${r.count}`);
    }
  });

  it("keeps a zero-count stage audible (not silently omitted like the visual '')", () => {
    // The bar renders {r.count || ""} - blank for 0 - but the AT user must still
    // learn Offer is 0, not that the stage is missing.
    expect(barsSummary("Pipeline funnel", funnel)).toContain("Offer 0");
  });

  it("degrades to an explicit empty alt rather than a dangling 'caption:'", () => {
    expect(barsSummary("By sector", [])).toBe("By sector: no data");
  });
});

describe("velocityWeekName (speech-friendly axis labels)", () => {
  it("expands the compact visual labels so a reader hears real words", () => {
    expect(velocityWeekName("this wk")).toBe("this week");
    expect(velocityWeekName("-1w")).toBe("1 week ago"); // singular
    expect(velocityWeekName("-3w")).toBe("3 weeks ago"); // plural
    expect(velocityWeekName("-7w")).toBe("7 weeks ago");
  });

  it("passes through anything it does not recognize (never throws / blanks)", () => {
    expect(velocityWeekName("unexpected")).toBe("unexpected");
  });
});

describe("velocitySummary (applications-per-week chart)", () => {
  // InsightsView builds 8 weeks oldest-first; here a compact 3-week sample.
  const weeks = [
    { label: "-2w", count: 1 },
    { label: "-1w", count: 0 },
    { label: "this wk", count: 3 },
  ];

  it("states the window, the running total, and each week's value", () => {
    expect(velocitySummary(weeks)).toBe(
      "Applications per week, last 3 weeks, 4 total: 2 weeks ago 1, 1 week ago 0, this week 3"
    );
  });

  it("total equals the sum of the per-week counts", () => {
    const summary = velocitySummary(weeks);
    const sum = weeks.reduce((s, w) => s + w.count, 0);
    expect(summary).toContain(`${sum} total`);
  });
});

describe("progressValueText (Roadmap phase progress meter)", () => {
  it("reads as N of M items done with the percentage", () => {
    expect(progressValueText(3, 5)).toBe("3 of 5 items done (60%)");
  });

  it("pluralizes the unit correctly", () => {
    expect(progressValueText(1, 1)).toBe("1 of 1 item done (100%)");
    expect(progressValueText(0, 2)).toBe("0 of 2 items done (0%)");
  });

  it("never divides by zero on an item-less phase", () => {
    expect(progressValueText(0, 0)).toBe("0 of 0 items done (0%)");
  });

  it("rounds the percentage the same way the visible label does", () => {
    // 1/3 -> 33% in both the meter text and the visible '{pct}%'.
    expect(progressValueText(1, 3)).toBe("1 of 3 items done (33%)");
  });
});
