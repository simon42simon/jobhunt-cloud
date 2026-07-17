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

// A stamp offset N days before a fixed anchor date, so the demo history looks
// aged without depending on wall-clock (keeps determinism).
const ANCHOR = Date.UTC(2026, 6, 1); // 2026-07-01
const dayISO = (daysAgo) => new Date(ANCHOR - daysAgo * 86400000).toISOString();
const dateStamp = (daysAgo) => dayISO(daysAgo).slice(0, 10);

// ---- dataset generator ------------------------------------------------------
// Returns a plain, deterministic domain dataset. `seedVersion` (int) pins the RNG.
// `refDate` (optional Date) anchors the lead/queued deadlines 1-5 weeks AHEAD of
// it, so the board reads "due in 12d" instead of "26805d left" (QA BUG-4) while
// staying deterministic: the date is truncated to its UTC day, so every seed/reset
// on the same calendar day is byte-identical, and the nightly reset re-seeds with
// a fresh day before any deadline can lapse into the auto-close sweep. Without
// refDate the deadlines fall back to fixed far-future dates (the hermetic-test
// posture - fully version-pinned, no wall-clock input at all).
export function generate(seedVersion = 1, { refDate } = {}) {
  const refDay = refDate ? Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()) : null;
  const deadlineFor = (i) =>
    refDay
      ? new Date(refDay + (7 + (i % 5) * 7) * 86400000).toISOString().slice(0, 10)
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
    const applied = ["submitted", "interview", "offer", "rejected"].includes(status) ? dateStamp(20 - i) : null;
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

  // Discovery sources (a couple).
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
    },
  ];

  // A believable activity history: a start+done pair per artifact-bearing job, so
  // the run panel + insights render a live-looking timeline.
  const activity = [];
  let runN = 0;
  const pushRun = (job, routine, daysAgo) => {
    const runId = `r-demo-${++runN}`;
    const startTs = dayISO(daysAgo);
    const doneTs = new Date(Date.parse(startTs) + 90000 + runN * 1000).toISOString();
    activity.push({ ts: startTs, kind: "run", runId, routine, label: routine, jobId: job.id, batchId: null, status: "running" });
    activity.push({ ts: doneTs, kind: "run", runId, routine, label: routine, jobId: job.id, batchId: null, status: "done", exitCode: 0 });
  };
  for (const j of jobs) {
    if (!j.artifacts.length) continue;
    // Hero A treatment (spec 3.2): far-along jobs carry the FULL plausible run
    // history (draft then finalize, days apart) so the drawer's activity log and
    // the Insights view read as a system in daily use, not a single event.
    if (["interview", "offer", "submitted"].includes(j.status)) {
      pushRun(j, "first-draft-job", 18 - runN);
      pushRun(j, "finalize-job", 12 - runN);
    } else {
      pushRun(j, j.status === "drafted" ? "first-draft-job" : "finalize-job", 15 - runN);
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

  return { seedVersion: Number(seedVersion || 1), columns, jobs, tasks, requests, sources, activity, chats };
}

// ---- apply the dataset through the Store seam (store-agnostic) ---------------
// Works against any Store (Pg for the cloud demo, File for a test's temp vault).
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
