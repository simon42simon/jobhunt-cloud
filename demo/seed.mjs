// RC-3 / SIM-87 I6 - deterministic FICTIONAL demo seed (design 5.1, guardian G9).
//
// STRUCTURAL isolation, not a promise (design 5.4 axis 3): this generator has NO
// read path to any real store. It imports nothing from server/store.js, reads no
// file under JOBS_DIR / ops/facts, and touches no env-provided path. Its ONLY
// inputs are the bundled fictional lists below + a fixed RNG seed. So the dataset
// it produces cannot contain real vault data by construction - the
// forbidden-substrings guard (demo/guard.mjs) then PROVES it, over the seed AND
// the canned transcripts AND the pre-baked artifacts (MF-11).
//
// DETERMINISTIC: a fixed seed (SEED_VERSION) makes the demo reproducible and
// reviewable - the same board every reset, so a nightly TRUNCATE + reseed lands
// byte-for-byte identical content.
//
// STORE-AGNOSTIC: generate() returns a plain domain dataset; applySeed(store, ds)
// writes it THROUGH the Store seam, so it populates a PgStore (cloud demo) and a
// FileStore (a test's temp vault) identically. That is what lets the guard +
// determinism tests run with zero database.

// ---- deterministic RNG (mulberry32) ----------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- curated FICTIONAL lists (invented; no real person or employer) ---------
const FIRST_NAMES = ["Ada", "Bram", "Cleo", "Dex", "Esme", "Ford", "Gita", "Hollis", "Ines", "Juno", "Kai", "Lior", "Mira", "Nero", "Opal", "Pax"];
const LAST_NAMES = ["Vale", "Quill", "Rho", "Sable", "Thorne", "Umber", "Vesper", "Wren", "Yarrow", "Zeph", "Marlow", "Ostrander"];
const EMPLOYERS = [
  "Northwind Analytics", "Blue Harbor Robotics", "Meridian Public Trust", "Kestrel Aerospace",
  "Lantern Health Collective", "Granite Peak Municipal", "Solstice B2B Cloud", "Ironwood Logistics",
  "Verdant Fire & Safety", "Halcyon University", "Tidewater Provincial Agency", "Cobalt Field Systems",
];
const ROLES = [
  "Operations Analyst", "GTM Program Manager", "Public Sector Advisor", "Systems Engineer",
  "Field Safety Coordinator", "Higher-Ed Program Lead", "Revenue Operations Manager", "Logistics Planner",
];
// These MATCH the app's real enum vocabularies (they are non-PII schema values, not
// personal data) so createJob's dropInvalidJobEnums keeps them.
const TRACKS = [
  "industry_outreach_focused", "higher_ed_generalist_focused", "b2b_gtm_focused",
  "operations_leadership_focused", "public_sector_focused", "aerospace_defence_focused", "fire_alarm_focused",
];
const SECTORS = ["private", "municipal", "provincial", "federal", "bps", "nonprofit"];
const FITS = ["strong", "moderate", "stretch"];

// The PM-spec funnel (audit/2026-07-16-rc4-demo-journey-spec.md section 3.1):
// ~23 jobs shaped like a real search - wide at the top, narrow at the bottom,
// every status column populated (an all-green board reads as fake; the two
// rejected + two closed are the "honest losses" the archive toggle shows).
const FUNNEL = [
  ["lead", 5],
  ["queued", 3],
  ["drafted", 2],
  ["ready", 2],
  ["submitted", 4],
  ["interview", 2],
  ["offer", 1],
  ["rejected", 2],
  ["closed", 2],
];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// A stamp offset N days before an anchor date, so the demo history looks aged.
// The HERMETIC default anchor is fixed (2026-07-01: no wall-clock input at all,
// so tests are fully version-pinned). The LIVE demo passes `refDate` (boot /
// nightly-reset time) instead, truncated to its UTC day: relative dates then
// read "2d ago", the Insights velocity chart shows movement in the current
// weeks, and the seed stays deterministic - every seed/reset on the same
// calendar day is byte-identical (SIM-390 item 5; same pattern as the
// deployed demo's BUG-4 deadline fix).
const ANCHOR = Date.UTC(2026, 6, 1); // 2026-07-01 (hermetic default)
function anchorMsOf(refDate) {
  if (!refDate) return ANCHOR;
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Number.isFinite(ms) ? ms : ANCHOR;
}

// ---- dataset generator ------------------------------------------------------
// Returns a plain, deterministic domain dataset. `seedVersion` (int) pins the RNG;
// `refDate` (optional Date) anchors every relative date to that calendar day
// (omitted = the fixed hermetic anchor). Deadlines additionally keep the BUG-4
// posture: with refDate they land 1-5 weeks AHEAD of it (so the board reads
// "due in 12d", and the nightly reset re-seeds with a fresh day before any
// deadline can lapse into the auto-close sweep); without refDate they fall back
// to fixed far-future dates (the hermetic-test posture - fully version-pinned,
// no wall-clock input at all, and the sweep can never eat the funnel).
export function generate(seedVersion = 1, { refDate = null } = {}) {
  const anchorMs = anchorMsOf(refDate);
  const dayISO = (daysAgo) => new Date(anchorMs - daysAgo * 86400000).toISOString();
  const dateStamp = (daysAgo) => dayISO(daysAgo).slice(0, 10);
  const deadlineFor = (i) =>
    refDate
      ? new Date(anchorMs + (7 + (i % 5) * 7) * 86400000).toISOString().slice(0, 10)
      : `2099-12-${String(1 + (i % 28)).padStart(2, "0")}`;
  const rng = mulberry32(1000 + Number(seedVersion || 1));

  // Expand the funnel into a flat, deterministic status list (23 jobs).
  const statusList = FUNNEL.flatMap(([status, n]) => Array.from({ length: n }, () => status));

  const jobs = [];
  const usedIds = new Set();
  for (let i = 0; i < statusList.length; i++) {
    const role = pick(rng, ROLES);
    let employer = pick(rng, EMPLOYERS);
    let id = `${role} - ${employer}`;
    // Keep ids unique (createJob rejects a duplicate slug).
    let guard = 0;
    while (usedIds.has(id) && guard++ < EMPLOYERS.length) {
      employer = pick(rng, EMPLOYERS);
      id = `${role} - ${employer}`;
    }
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const status = statusList[i];
    const sector = pick(rng, SECTORS);
    // Every track appears at least twice (spec 3.1: track filters + the Insights
    // breakdown must look alive) - round-robin the first 2 passes, then random.
    const track = i < TRACKS.length * 2 ? TRACKS[i % TRACKS.length] : pick(rng, TRACKS);
    // Fit skews strong/moderate near the top of the funnel (a real user doesn't
    // queue jobs they don't fit); one deliberate stretch lands via the rng tail.
    const fit = ["lead", "queued"].includes(status) ? pick(rng, ["strong", "strong", "moderate"]) : pick(rng, FITS);
    // Applied dates spread across the last ~2.5 weeks so the Insights velocity
    // chart shows movement in the CURRENT weeks instead of stalling two-plus
    // weeks back (SIM-390 item 5 / journey-spec 3.3). SIM-424: the actual value
    // is backfilled below (in the activity-history pass), derived from this
    // SAME job's own finalize-job run date - it used to be computed here from
    // `i` (this loop's funnel index), independently of the finalize run date
    // computed later from an unrelated running counter, so the two could
    // invert ("Finalized application" landing AFTER "Applied", occasionally
    // even after the anchor day). null here is a placeholder for "needs one".
    const applied = null;
    // Pre-baked FICTIONAL artifacts for jobs that have progressed far enough.
    const person = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    const artifacts = [];
    const notes = [];
    if (["drafted", "ready", "submitted", "interview", "offer", "rejected"].includes(status)) {
      // .pdf so the readiness derivation (hasCV/hasCoverLetter want a docx/pdf named
      // cv/cover) lights up, exactly like a real rendered application. The bytes are
      // fictional demo content, not a real PDF - the app never parses them.
      artifacts.push({
        name: `${person} - CV - ${role}.pdf`,
        mime: "application/pdf",
        text:
          `%PDF-1.4 (fictional demo)\n# ${person}\n\n## ${role} - ${employer} (FICTIONAL DEMO)\n\n` +
          `- Led a cross-functional team of ${3 + (i % 5)} at a fictional prior employer.\n` +
          `- Improved a made-up metric by ${10 + (i % 40)}%.\n\n` +
          `_This is invented sample data for the public demo; no real person or record._\n`,
      });
      artifacts.push({
        name: `${person} - Cover Letter - ${employer}.pdf`,
        mime: "application/pdf",
        text:
          `%PDF-1.4 (fictional demo)\nDear Hiring Team at ${employer},\n\n` +
          `I am excited to apply for the ${role} role. This letter is fictional demo content.\n\n` +
          `Sincerely,\n${person}\n`,
      });
      // Realistic-reading (still fully fictional) gap Q&A - Beat 2 of the demo
      // tour narrates this page, so literal filler undercuts AC5's "none reads
      // as placeholder" (QA low-severity note).
      notes.push({
        name: "gaps.md",
        content:
          `# Gaps\n\n` +
          `- Q: The posting asks for direct budget ownership; the CV shows shared program budgets only.\n` +
          `- A: Owned the tooling line (~$120k) inside a shared program budget and ran its quarterly re-forecast solo - fictional example written for this demo.\n\n` +
          `- Q: The ${role} posting names a certification the CV does not carry.\n` +
          `- A: Equivalent coursework completed in 2025; certification exam scheduled - fictional demo answer, no real credential implied.\n`,
      });
      notes.push({
        name: "job-description.md",
        content: `# ${role} at ${employer}\n\nFictional posting text for the demo. Responsibilities and requirements are invented.\n`,
      });
    }
    jobs.push({
      id,
      role,
      employer,
      track,
      fit,
      status,
      sector,
      // Always AHEAD of refDate (or far-future without one) so the lazy auto-close
      // sweep can never eat the top of the funnel; see deadlineFor above (BUG-4).
      deadline: status === "lead" || status === "queued" ? deadlineFor(i) : null,
      link: `https://demo.example.test/postings/${i + 1}`,
      source: "demo-seed",
      applied,
      artifacts,
      notes,
    });
  }

  // Task board (a handful).
  const columns = ["backlog", "todo", "in_progress", "done"];
  const tasks = [];
  for (let i = 0; i < 6; i++) {
    tasks.push({
      id: `t-demo-${i + 1}`,
      title: `Demo task ${i + 1}: ${pick(rng, ["review a lead", "prep an interview", "tune a source", "follow up", "draft an application", "compare offers"])}`,
      status: columns[i % columns.length],
      priority: ["low", "medium", "high"][i % 3],
      type: "task",
      created: dateStamp(30 - i),
      ...(i % 4 === 3 ? { completed: dateStamp(2), } : {}),
    });
  }

  // Intake ledger (a couple of verbatim asks).
  const requests = [
    {
      id: "r-demo-1",
      text: "Find me 3 operations roles in the public sector this week.",
      source: "chatbot",
      created: dateStamp(9),
      ts: dayISO(9),
      spawned: { tasks: ["t-demo-1"], projects: [] },
    },
    {
      id: "r-demo-2",
      text: "Draft applications for my two strongest leads.",
      source: "session",
      created: dateStamp(4),
      ts: dayISO(4),
      spawned: { tasks: ["t-demo-5"], projects: [] },
    },
  ];

  // Discovery sources - WITH run history (SIM-390 item 5 / journey-spec 3.4).
  // Without lastRunAt + runs every source pill read "Never run" and the console
  // looked abandoned. The run records are shaped exactly like the finalize
  // path's (normalizeRun keeps startedAt/durationMs/outcome/counters/trigger),
  // and the timestamps are anchor-relative so a refDate-seeded demo reads
  // "Ran 2d ago · 6 found" while staying deterministic.
  const sourceRun = (daysAgo, n, { leadsFound, leadsNew, candidatesReviewed, trigger }) => ({
    runId: `r-demo-src-${n}`,
    startedAt: dayISO(daysAgo),
    durationMs: 240000 + n * 30000,
    outcome: "succeeded",
    leadsFound,
    leadsNew,
    candidatesReviewed,
    alreadyTracked: Math.max(0, candidatesReviewed - leadsFound),
    filteredOut: 0,
    trigger,
  });
  const sources = [
    {
      id: "demo-board-1",
      name: "Demo Public Board",
      type: "board",
      sector: "municipal",
      active: "yes",
      urls: ["https://demo.example.test/board"],
      cadence: "weekly",
      instructions: "Fictional demo source. Never fetched in demo mode.",
      outputFields: ["title", "employer"],
      aliases: [],
      tracks: [],
      lastRunAt: dayISO(2),
      runs: [
        sourceRun(9, 1, { leadsFound: 4, leadsNew: 3, candidatesReviewed: 11, trigger: "scheduled" }),
        sourceRun(2, 2, { leadsFound: 6, leadsNew: 4, candidatesReviewed: 14, trigger: "scheduled" }),
      ],
    },
    {
      id: "demo-employer-1",
      name: "Northwind Analytics Careers",
      type: "employer",
      sector: "private",
      active: "yes",
      urls: ["https://demo.example.test/northwind"],
      cadence: "manual",
      instructions: "Fictional demo source.",
      outputFields: ["title"],
      aliases: [],
      tracks: [],
      lastRunAt: dayISO(5),
      runs: [sourceRun(5, 3, { leadsFound: 2, leadsNew: 2, candidatesReviewed: 3, trigger: "manual" })],
    },
    {
      id: "demo-portal-1",
      name: "Tidewater Provincial Careers Portal",
      type: "board",
      sector: "provincial",
      active: "yes",
      urls: ["https://demo.example.test/tidewater-portal"],
      cadence: "weekly",
      instructions: "Fictional demo source. Never fetched in demo mode.",
      outputFields: ["title", "employer", "deadline"],
      aliases: [],
      tracks: [],
      lastRunAt: dayISO(3),
      runs: [sourceRun(3, 4, { leadsFound: 3, leadsNew: 2, candidatesReviewed: 7, trigger: "scheduled" })],
    },
  ];

  // Seeded discovery FINDS (SIM-390 item 5 / journey-spec 3.4: "the Discovery
  // page is not blank"). Shaped like the workbook's discoveries rows (the
  // Discovery/Triage UI's `Discovery` type). Served by the server's demo-mode
  // readDiscovery branch - deliberately NOT written through the store seam
  // (there is no finds store method; the demo derives them from this generator
  // on read, exactly as deterministic as the rest of the seed). All fictional.
  const findRow = (daysAgo, n, { title, employer, sector, track, sourceIdx, decision, tracked = false }) => ({
    "Date Found": dateStamp(daysAgo),
    Title: title,
    Employer: employer,
    Sector: sector,
    Track: track,
    Fit: pick(rng, FITS),
    Tailoring: pick(rng, ["light", "medium", "heavy"]),
    Deadline: dateStamp(-(10 + n)), // ahead of the anchor, like the job deadlines
    Location: "Demoville (fictional)",
    Source: sources[sourceIdx].name,
    Link: `https://demo.example.test/finds/${n}`,
    Decision: decision,
    Notes: "Fictional demo find.",
    tracked,
    sourceId: sources[sourceIdx].id,
  });
  const finds = [
    findRow(1, 1, { title: "Operations Analyst", employer: "Granite Peak Municipal", sector: "municipal", track: "operations_leadership_focused", sourceIdx: 0, decision: "" }),
    findRow(2, 2, { title: "Logistics Planner", employer: "Ironwood Logistics", sector: "private", track: "operations_leadership_focused", sourceIdx: 0, decision: "" }),
    findRow(2, 3, { title: "Field Safety Coordinator", employer: "Verdant Fire & Safety", sector: "private", track: "fire_alarm_focused", sourceIdx: 0, decision: "maybe" }),
    findRow(3, 4, { title: "Public Sector Advisor", employer: "Tidewater Provincial Agency", sector: "provincial", track: "public_sector_focused", sourceIdx: 2, decision: "" }),
    findRow(3, 5, { title: "Systems Engineer", employer: "Kestrel Aerospace", sector: "federal", track: "aerospace_defence_focused", sourceIdx: 2, decision: "pursue", tracked: true }),
    findRow(5, 6, { title: "Revenue Operations Manager", employer: "Northwind Analytics", sector: "private", track: "b2b_gtm_focused", sourceIdx: 1, decision: "" }),
    findRow(5, 7, { title: "GTM Program Manager", employer: "Solstice B2B Cloud", sector: "private", track: "b2b_gtm_focused", sourceIdx: 1, decision: "skip" }),
    findRow(9, 8, { title: "Higher-Ed Program Lead", employer: "Halcyon University", sector: "bps", track: "higher_ed_generalist_focused", sourceIdx: 0, decision: "" }),
  ];

  // A believable activity history: a start+done pair per artifact-bearing job, so
  // the run panel + insights render a live-looking timeline.
  //
  // SIM-424: dates are scheduled per GROUP (hero-treatment vs solo) off a small
  // bounded index, not a single global monotonic counter subtracted from a
  // fixed ceiling. The old `18/12/15 - runN` scheme used ONE counter shared by
  // every artifact-bearing job (13 of them, 20 pushes total) - by the time it
  // reached the later jobs in funnel order (interview, offer, rejected),
  // `12 - runN` and `15 - runN` had gone NEGATIVE, i.e. `dayISO` landed AFTER
  // the anchor day (a "finalize" run dated into the future). Meanwhile
  // `applied` was computed separately from `i` (the funnel-position index),
  // uncorrelated with the run schedule - so on Hero A (and, unnoticed until
  // now, the other later hero/rejected jobs) "Finalized application" could
  // land after "Applied", sometimes by a lot. Fixed two ways: (1) each job's
  // run date now comes from its own small per-group index against a fixed
  // ceiling well clear of zero, so it can never go negative; (2) `applied`
  // (backfilled here, was `null` above) is derived from THIS SAME job's own
  // finalize-job date, a fixed 2-day gap later, so the timeline always reads
  // draft -> finalize -> apply, in that order, on every job that carries one.
  const activity = [];
  let runN = 0;
  const pushRun = (job, routine, daysAgo) => {
    const runId = `r-demo-${++runN}`;
    const startTs = dayISO(daysAgo);
    const doneTs = new Date(Date.parse(startTs) + 90000 + runN * 1000).toISOString();
    activity.push({ ts: startTs, kind: "run", runId, routine, label: routine, jobId: job.id, batchId: null, status: "running" });
    activity.push({ ts: doneTs, kind: "run", runId, routine, label: routine, jobId: job.id, batchId: null, status: "done", exitCode: 0 });
  };
  let heroIdx = 0; // hero (draft+finalize) treatment: submitted/interview/offer - 7 max
  let soloIdx = 0; // single-run treatment: drafted/ready/rejected - 6 max
  for (const j of jobs) {
    if (!j.artifacts.length) continue;
    // Hero A treatment (spec 3.2): far-along jobs carry the FULL plausible run
    // history (draft then finalize, days apart) so the drawer's activity log and
    // the Insights view read as a system in daily use, not a single event.
    // Bounded schedule (7 hero jobs max): draft 24..12 days ago (2-day steps,
    // always positive), a fixed 6-day draft->finalize gap, then (every hero
    // status carries an applied date) a fixed 2-day finalize->apply gap.
    if (["interview", "offer", "submitted"].includes(j.status)) {
      const draftDaysAgo = 24 - heroIdx * 2;
      const finalizeDaysAgo = draftDaysAgo - 6;
      pushRun(j, "first-draft-job", draftDaysAgo);
      pushRun(j, "finalize-job", finalizeDaysAgo);
      j.applied = dateStamp(finalizeDaysAgo - 2);
      heroIdx++;
    } else {
      // Solo treatment (drafted/ready/rejected): one run. Bounded schedule (6
      // solo jobs max): 15..5 days ago (2-day steps, always positive).
      // Rejected also carries an applied date, a fixed 2-day gap after its
      // (sole) finalize run.
      const runDaysAgo = 15 - soloIdx * 2;
      pushRun(j, j.status === "drafted" ? "first-draft-job" : "finalize-job", runDaysAgo);
      if (j.status === "rejected") j.applied = dateStamp(runDaysAgo - 2);
      soloIdx++;
    }
  }

  // A per-job chat transcript for the first artifact-bearing job.
  const chats = {};
  const chatJob = jobs.find((j) => j.artifacts.length);
  if (chatJob) {
    chats[chatJob.id] = [
      { role: "user", text: `What makes me a fit for ${chatJob.role}?` },
      { role: "assistant", text: "Fictional demo answer: your invented sample experience aligns well." },
    ];
  }

  return {
    seedVersion: Number(seedVersion || 1),
    // The anchor day (YYYY-MM-DD) every relative date is computed from - the
    // refDate's UTC day, or the fixed hermetic anchor. Exposed for tests.
    anchor: dateStamp(0),
    columns,
    jobs,
    tasks,
    requests,
    sources,
    finds,
    activity,
    chats,
  };
}

// ---- apply the dataset through the Store seam (store-agnostic) ---------------
// Works against any Store (Pg for the cloud demo, File for a test's temp vault).
// NOTE: ds.finds is deliberately NOT applied here - there is no finds method on
// the store seam; the demo serves them straight from generate() via the
// demo-mode readDiscovery branch in server/index.js (SIM-390 item 5).
export function applySeed(store, ds) {
  // Jobs + their artifacts/notes.
  for (const j of ds.jobs) {
    let created;
    try {
      created = store.createJob({
        role: j.role,
        employer: j.employer,
        track: j.track,
        fit: j.fit,
        status: j.status,
        sector: j.sector,
        deadline: j.deadline || undefined,
        link: j.link,
        source: j.source,
      });
    } catch (e) {
      if (e && e.httpStatus === 409) continue; // idempotent-ish: skip a dup slug
      throw e;
    }
    const id = created.id;
    if (j.applied) {
      try {
        store.updateJobFields(id, { applied: j.applied });
      } catch {
        /* best-effort */
      }
    }
    for (const note of j.notes || []) {
      try {
        store.writeJobNote(id, note.name, note.content);
      } catch {
        /* best-effort */
      }
    }
    for (const a of j.artifacts || []) {
      try {
        store.saveJobArtifact(id, a.name, a.mime, Buffer.from(a.text, "utf8"));
      } catch {
        /* best-effort */
      }
    }
  }

  store.saveTasks({ columns: ds.columns, tasks: ds.tasks });
  store.saveRequests({ requests: ds.requests });
  store.saveSources({ sources: ds.sources });
  store.saveChats(ds.chats);
  for (const rec of ds.activity) {
    store.appendActivity(rec);
  }
}
