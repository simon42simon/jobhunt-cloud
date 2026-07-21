// SIM-423 (GATE 2 fix). The demo CTA (the always-visible banner AND the tour's
// close panel) must offer THREE links per the demo spec
// (company-os/audit/2026-07-16-rc4-demo-journey-spec.md §4: "the CTA: links
// to Simon's CV, GitHub, and LinkedIn" - also AC7's close-panel checklist),
// not GitHub alone (the v1-only owner decision 2026-07-16 that shipped
// first, now superseded by that spec). ONE shared list so DemoBanner and
// DemoTour's close panel can never drift apart, and one place to swap in the
// real URLs.
//
// GitHub is a verified real URL (the pre-existing v1 CTA target). CV and
// LinkedIn are NOT configured anywhere in this repo or the wider workspace
// (`ops/facts/resume.yaml` carries a literal `linkedin: '' # to fill` -
// checked before writing this). Rather than silently GUESS a personal
// profile URL (which could point a visitor at the wrong page, or someone
// else's profile, presented as if verified), these two are clearly-marked
// PLACEHOLDER urls pending the real ones - flagged as a finding in the GATE 2
// fix report, not guessed. Swap the two placeholder constants below for the
// real URLs when Simon supplies them; no other file needs to change.
export const CV_URL = "https://example.com/simon-kim-cv"; // PLACEHOLDER - swap for the real CV link
export const GITHUB_URL = "https://github.com/simon42simon";
export const LINKEDIN_URL = "https://example.com/simon-kim-linkedin"; // PLACEHOLDER - swap for the real LinkedIn URL

export interface DemoCtaLink {
  label: string;
  href: string;
}

// Render order matches the spec's own phrasing ("CV, GitHub, and LinkedIn").
export const DEMO_CTA_LINKS: readonly DemoCtaLink[] = [
  { label: "CV", href: CV_URL },
  { label: "GitHub", href: GITHUB_URL },
  { label: "LinkedIn", href: LINKEDIN_URL },
];
