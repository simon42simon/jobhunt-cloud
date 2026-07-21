// SIM-423 (GATE 2 fix). The demo CTA (the always-visible banner AND the tour's
// close panel) must offer THREE links per the demo spec
// (company-os/audit/2026-07-16-rc4-demo-journey-spec.md §4: "the CTA: links
// to Simon's CV, GitHub, and LinkedIn" - also AC7's close-panel checklist),
// not GitHub alone (the v1-only owner decision 2026-07-16 that shipped
// first, now superseded by that spec). ONE shared list so DemoBanner and
// DemoTour's close panel can never drift apart, and one place to swap in the
// real URLs.
//
// All three are real, owner-supplied URLs (2026-07-21). CV is served by this
// app as a static asset (public/cv/ -> dist/cv/ via the Vite build), so the
// link is host-agnostic: the same build resolves it on staging and production
// alike. The public CV variant has the phone number stripped (owner decision);
// email + LinkedIn remain, and the canonical Master CV keeps the phone for real
// job applications. One place to swap these if they ever change.
export const CV_URL = "/cv/simon-kim-cv.pdf";
export const GITHUB_URL = "https://github.com/simon42simon";
export const LINKEDIN_URL = "https://www.linkedin.com/in/simon-sihyeon-kim/";

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
