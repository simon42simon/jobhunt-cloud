import { describe, it, expect } from "vitest";
import {
  ADDRESSED_STATUS_META,
  ATTENTION_TONE_COLOR,
  BRIEF_STATUS_COLOR,
  CHANGE_TYPE_COLOR,
  DOC_TYPE_COLOR,
  FIT_ACCENT,
  GROUP_COLOR,
  LAST_RUN_SIGNAL_META,
  ONBOARDING_STATUS_COLOR,
  PIPELINE_ACCENT,
  PROPOSAL_STATUS_META,
  RISK_SEVERITY_META,
  RUN_STATUS_META,
  STATUS_COLOR,
  TRACK_ACCENT,
  attentionToneColor,
  briefStatusColor,
  changeTypeColor,
  docTypeColor,
  fitAccent,
  groupColor,
  hexA,
  onboardingStatusColor,
  pipelineAccent,
  riskSeverity,
  statusColor,
  trackAccent,
  type RiskSeverity,
} from "../src/lib/statusColors";

// Unit tests for the single shared status/group/type -> color module. Two
// jobs: (1) guard the specific regressions this module was built to fix
// (missing "governance" group, broken-accent fallback, sub-4.5:1 hues), and
// (2) a blanket WCAG AA contrast sweep over every exported color map so a
// future edit that adds an unvetted hex fails the test instead of shipping a
// silent contrast regression - the "guard so it can't silently recur" this
// class of bug needs (see CLAUDE.md's bug-fix rule).

const PANEL = "#111725";
const PANEL2 = "#161e2e";
// The widest alpha any consumer tints these colors' own background with
// (ProjectsView's Avatar uses hexA(c, 0.22)) - the ceiling every color in
// this module is vetted against, per statusColors.ts's own methodology
// comment.
const ALPHAS = [0.12, 0.13, 0.14, 0.15, 0.16, 0.18, 0.2, 0.22];

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  const n = parseInt(clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function srgbToLinear(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA_: string, hexB: string) {
  const l1 = relativeLuminance(hexA_);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(fg: string, alpha: number, bg: string) {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mix = (a: number, bch: number) => Math.round(a * alpha + bch * (1 - alpha));
  const r = mix(f.r, b.r).toString(16).padStart(2, "0");
  const g = mix(f.g, b.g).toString(16).padStart(2, "0");
  const bl = mix(f.b, b.b).toString(16).padStart(2, "0");
  return `#${r}${g}${bl}`;
}

// The worst-case contrast a color hits as small text over its own translucent
// tint (hexA(color, alpha)) laid over a panel, across every alpha this module
// says it is vetted for and both panel tokens.
function worstTintContrast(hex: string): number {
  let worst = Infinity;
  for (const alpha of ALPHAS) {
    for (const panel of [PANEL, PANEL2]) {
      const bg = blend(hex, alpha, panel);
      const c = contrastRatio(hex, bg);
      if (c < worst) worst = c;
    }
  }
  return worst;
}

function allColorMaps(): Record<string, string> {
  const flat: Record<string, string> = {
    ...STATUS_COLOR,
    ...GROUP_COLOR,
    ...ONBOARDING_STATUS_COLOR,
    ...CHANGE_TYPE_COLOR,
    ...DOC_TYPE_COLOR,
    ...BRIEF_STATUS_COLOR,
    ...ATTENTION_TONE_COLOR,
  };
  // Jobs pipeline vocabulary (UX F7, audit-2026-07-04): PIPELINE_ACCENT is
  // keyed by Status, not a plain string map, so it needs its own spread;
  // prefixed so a key collision with another vocabulary can't mask a color.
  for (const [key, hex] of Object.entries(PIPELINE_ACCENT)) {
    flat[`pipeline:${key}`] = hex;
  }
  for (const [key, hex] of Object.entries(TRACK_ACCENT)) {
    flat[`track:${key}`] = hex;
  }
  for (const [key, hex] of Object.entries(FIT_ACCENT)) {
    flat[`fit:${key}`] = hex;
  }
  for (const [key, meta] of Object.entries(ADDRESSED_STATUS_META)) {
    flat[`addressed:${key}`] = meta.color;
  }
  // ADR-011 risk-severity chips REUSE vetted STATUS_COLOR hues; fold them in so
  // the AA sweep provably covers them too (makes statusColors.ts's own comment
  // true - a future edit to a risk tint fails the contrast test, not ships).
  for (const [key, meta] of Object.entries(RISK_SEVERITY_META)) {
    flat[`risk:${key}`] = meta.color;
  }
  // Instruction-proposal chips (DISC-W3) - same reuse-vetted-hues posture as
  // the risk map; folding them in keeps statusColors.ts's coverage claim true.
  for (const [key, meta] of Object.entries(PROPOSAL_STATUS_META)) {
    flat[`proposal:${key}`] = meta.color;
  }
  // Last-run honesty signals (Discovery schema v4) - same reuse-vetted-hues
  // posture; the "Unverified" pill renders this color as its own tinted text.
  for (const [key, meta] of Object.entries(LAST_RUN_SIGNAL_META)) {
    flat[`lastRunSignal:${key}`] = meta.color;
  }
  // Routine-run statuses (RunPanel pill + RunDock chips, t-1783119823228) -
  // replaced RunPanel's private TONE map whose failed/done hues were unvetted.
  for (const [key, meta] of Object.entries(RUN_STATUS_META)) {
    flat[`runStatus:${key}`] = meta.color;
  }
  return flat;
}

describe("statusColors WCAG AA vetting", () => {
  it("every color clears 4.5:1 flat against both panel tokens", () => {
    for (const [key, hex] of Object.entries(allColorMaps())) {
      expect(contrastRatio(hex, PANEL), `${key} (${hex}) vs panel`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, PANEL2), `${key} (${hex}) vs panel-2`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every color clears 4.5:1 as its own tinted-background pill text at every alpha in use (0.12-0.22)", () => {
    for (const [key, hex] of Object.entries(allColorMaps())) {
      expect(worstTintContrast(hex), `${key} (${hex}) worst-case tint contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("statusColor / groupColor fallback", () => {
  it("falls back to the safe muted default, not the raw accent color, for unknown values", () => {
    // The raw --color-accent (#5a5df0) fails AA as text (3.63:1) - the old
    // per-file fallbacks used it directly, so an unrecognized status/group
    // silently rendered illegible text. Guard against that regressing.
    expect(statusColor("some-future-status")).not.toBe("#5a5df0");
    expect(groupColor("some-future-group")).not.toBe("#5a5df0");
    expect(statusColor(undefined)).not.toBe("#5a5df0");
    expect(groupColor(undefined)).not.toBe("#5a5df0");
  });

  it("resolves every required task/project status key", () => {
    const required = [
      "backlog", "todo", "in_progress", "in_review", "done", "canceled",
      "blocked", "paused", "not_started", "planned", "proposed", "triage",
      "later", "archived",
    ];
    for (const status of required) {
      expect(STATUS_COLOR[status], status).toBeTruthy();
    }
  });

  it("resolves the 'governance' org group (previously missing, silently fell back to the broken accent color)", () => {
    expect(GROUP_COLOR.governance).toBeTruthy();
    expect(groupColor("governance")).toBe(GROUP_COLOR.governance);
  });

  it("resolves every documented org group", () => {
    const required = [
      "leadership", "engineering", "design", "quality", "infra", "docs",
      "people", "career-delivery", "governance", "product", "stakeholder",
    ];
    for (const group of required) {
      expect(GROUP_COLOR[group], group).toBeTruthy();
    }
  });
});

describe("pipelineAccent / trackAccent / fitAccent / attentionToneColor (UX F7)", () => {
  it("resolves every job pipeline status", () => {
    const required = [
      "lead", "queued", "drafted", "submitted", "interview", "offer",
      "rejected", "closed",
    ];
    for (const status of required) {
      expect(PIPELINE_ACCENT[status as keyof typeof PIPELINE_ACCENT], status).toBeTruthy();
      expect(pipelineAccent(status)).toBe(PIPELINE_ACCENT[status as keyof typeof PIPELINE_ACCENT]);
    }
  });

  it("resolves every career track", () => {
    const required = [
      "industry_outreach_focused", "higher_ed_generalist_focused", "b2b_gtm_focused",
      "operations_leadership_focused", "public_sector_focused",
      "aerospace_defence_focused", "fire_alarm_focused",
    ];
    for (const track of required) {
      expect(trackAccent(track)).toBeTruthy();
    }
  });

  it("resolves every fit assessment, case-insensitively", () => {
    for (const fit of ["strong", "moderate", "stretch"]) {
      expect(fitAccent(fit)).toBe(FIT_ACCENT[fit]);
      expect(fitAccent(fit.toUpperCase())).toBe(FIT_ACCENT[fit]);
    }
  });

  it("resolves every needs-attention urgency band", () => {
    for (const key of ["overdue", "dueSoon", "followUp", "staleDraft", "staleLead"]) {
      expect(attentionToneColor(key)).toBeTruthy();
    }
  });

  it("falls back to the safe muted default for an unrecognized track/fit/tone, not the raw accent color", () => {
    expect(trackAccent("some-future-track")).not.toBe("#5a5df0");
    expect(trackAccent(undefined)).not.toBe("#5a5df0");
    expect(fitAccent("some-future-fit")).not.toBe("#5a5df0");
    expect(fitAccent(undefined)).not.toBe("#5a5df0");
    expect(attentionToneColor("some-future-tone")).not.toBe("#5a5df0");
    expect(attentionToneColor(undefined)).not.toBe("#5a5df0");
  });

  it("staleDraft/staleLead reuse the exact same hue as the drafted/lead pipeline status", () => {
    expect(ATTENTION_TONE_COLOR.staleDraft).toBe(PIPELINE_ACCENT.drafted);
    expect(ATTENTION_TONE_COLOR.staleLead).toBe(PIPELINE_ACCENT.lead);
  });
});

describe("changeTypeColor / docTypeColor / briefStatusColor / onboardingStatusColor", () => {
  it("resolves every Keep-a-Changelog category", () => {
    for (const name of ["Added", "Changed", "Fixed", "Security", "Removed", "Deprecated"]) {
      expect(changeTypeColor(name)).toBeTruthy();
    }
  });

  it("resolves review/log doc types", () => {
    expect(docTypeColor("review")).toBeTruthy();
    expect(docTypeColor("log")).toBeTruthy();
  });

  it("resolves brief/debrief statuses", () => {
    for (const status of ["shipped", "deferred", "mixed"]) {
      expect(briefStatusColor(status)).toBeTruthy();
    }
  });

  it("resolves onboarding statuses", () => {
    for (const status of ["active", "proposed", "inactive"]) {
      expect(onboardingStatusColor(status)).toBeTruthy();
    }
  });
});

describe("LAST_RUN_SIGNAL_META (Discovery schema v4 run honesty)", () => {
  it("has a label + color for all four signals", () => {
    for (const key of ["leads", "dedup", "quiet", "unverified"] as const) {
      expect(LAST_RUN_SIGNAL_META[key].label).toBeTruthy();
      expect(LAST_RUN_SIGNAL_META[key].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps 'dedup' visually calm (a dedup zero is the scrape WORKING) - only 'unverified' carries the warning hue", () => {
    // The ticket's core distinction: a healthy dedup-heavy run must never share
    // the alarming treatment reserved for a possibly-broken/unverified scrape.
    expect(LAST_RUN_SIGNAL_META.dedup.color).not.toBe(LAST_RUN_SIGNAL_META.unverified.color);
    expect(LAST_RUN_SIGNAL_META.quiet.color).not.toBe(LAST_RUN_SIGNAL_META.unverified.color);
  });
});

describe("hexA", () => {
  it("appends a two-digit alpha suffix", () => {
    expect(hexA("#112233", 1)).toBe("#112233ff");
    expect(hexA("#112233", 0)).toBe("#11223300");
  });

  it("rounds to the nearest hex byte", () => {
    // 0.16 * 255 = 40.8 -> rounds to 41 -> 0x29
    expect(hexA("#abcdef", 0.16)).toBe("#abcdef29");
  });
});

// ---------------------------------------------------------------------------
// Risk severity (ADR-011): the PMBOK likelihood x impact matrix reduced to one
// of three bands, DERIVED (never stored) so a risk chip cannot drift from its
// axes. Pin all nine combinations so the reduction is total and can't silently
// change; the chip renders High for prj-operational-system's real currency risk
// (likelihood medium x impact high).
// ---------------------------------------------------------------------------
describe("riskSeverity (PMBOK likelihood x impact)", () => {
  type Axis = "high" | "medium" | "low";
  const cases: Array<[Axis, Axis, RiskSeverity]> = [
    // both axes elevated -> High
    ["high", "high", "high"],
    ["high", "medium", "high"],
    ["medium", "high", "high"],
    // one elevated / both middling -> Medium
    ["high", "low", "medium"],
    ["low", "high", "medium"],
    ["medium", "medium", "medium"],
    // both low-ish -> Low
    ["medium", "low", "low"],
    ["low", "medium", "low"],
    ["low", "low", "low"],
  ];

  it("maps all nine likelihood x impact combinations to the expected band", () => {
    for (const [likelihood, impact, expected] of cases) {
      expect(riskSeverity(likelihood, impact), `${likelihood} x ${impact}`).toBe(expected);
    }
  });

  it("is symmetric in its two axes (likelihood x impact == impact x likelihood)", () => {
    const axes: Axis[] = ["high", "medium", "low"];
    for (const a of axes) {
      for (const b of axes) {
        expect(riskSeverity(a, b)).toBe(riskSeverity(b, a));
      }
    }
  });

  it("renders prj-operational-system's currency risk (medium x high) as High", () => {
    expect(riskSeverity("medium", "high")).toBe("high");
  });

  it("has a label + a defined color for every severity riskSeverity can return", () => {
    const axes: Axis[] = ["high", "medium", "low"];
    for (const a of axes) {
      for (const b of axes) {
        const sev = riskSeverity(a, b);
        expect(RISK_SEVERITY_META[sev]).toBeDefined();
        expect(RISK_SEVERITY_META[sev].label).toBeTruthy();
        expect(RISK_SEVERITY_META[sev].color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
