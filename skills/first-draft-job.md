# Skill: first-draft-job

Phase 1 of an application. Turn a raw job posting into a filed first draft: pick the track, build the folder, generate a tailored CV and cover letter (**.docx only** - PDF is deferred to finalize-job), and leave a gaps page for Simon to answer. Pairs with [`finalize-job`](finalize-job.md) (Phase 2): after Simon fills in the `<Role> gaps.md` page, finalize-job folds his answers into the facts store and regenerates the documents into submission-ready shape.

```
first-draft-job  ->  Simon fills the gaps page  ->  finalize-job  ->  Simon submits
```

- Owner: application-writer (Career Delivery)
- Created: 2026-06-16 · Converted: 2026-07-10 (S11, v2 template; content unchanged, updated 2026-07-06 baseline) · Updated: 2026-07-16 (t-1784258203647: gaps page promoted to an explicit required step - single-job runs were skipping it) · Updated: 2026-07-23 (SIM-597: re-homed to jobhunt-cloud `skills/`; facts read from the facts API, facts-stable blocks ride the track-pack cache - see "Facts + track-pack access")
- Review date: 2026-08-14
- Maturity: Level 3 (daily runs via routine-runner, 8/8 exit 0 on 2026-07-10 evidence; the org's closest L4 candidate)
- Supersedes: `company-os/skills/jobhunt/first-draft-job.md` (pointer there; decision `company-os/decisions/2026-07-23-jobhunt-skills-to-app-repo.md`) · `professional-development` vault `ops/routines/first-draft-job.md` (pointer there)
- Runtime binding: routine-runner ROUTINES key `first-draft-job` (scope job, agent application-writer, opus/high; batch runs drop to sonnet/medium per the documented carve-out; prompt `run first-draft-job for "<folder>"`). All relative paths below resolve from the runner's configured local workspace root (`ops/agent-runner.mjs`'s `workspaceDir` - the parent of `JOBHUNT_JOBS_DIR`/`config.local.json` `jobsDir`) - NOT assumed to be the OneDrive `professional-development` vault (that vault is frozen and cut out of the jobhunt product loop entirely per the 2026-07-23 cord-cut decision, SIM-614/`company-os/decisions/2026-07-23-vault-cord-cut.md`). (Was named `job-application` until 2026-06-29.)

## Facts + track-pack access (SIM-597, 2026-07-23)

Facts live in **jobhunt-cloud's own store** (Postgres in prod; owner decision 2026-07-23 - this is Simon's semi-public professional data, not third-party data), NOT in vault YAML. Access both APIs with the runner credentials:

- **Credentials:** a runner-dispatched job inherits `RUNNER_TOKEN` + `RUNNER_CLOUD_URL` in its environment (`ops/agent-runner.mjs` spawns with the runner's env). A local spawn (chat session on the laptop) falls back to `~/.ssc-secrets/secrets.env`: token = `JOBHUNT_RUNNER_TOKEN`, URL = `RUNNER_CLOUD_URL`. Never print the token.
- **Facts (dual-auth, SIM-597 ruling):** `GET $RUNNER_CLOUD_URL/api/facts` with `Authorization: Bearer $RUNNER_TOKEN` -> `{ ok, facts: { resume, professional_experience, cover_letter } }`, each `{ kind, doc, updatedAt }` - `doc` is the same structure the old `ops/facts/*.yaml` held, as JSON. Per-kind: `GET /api/facts/:kind` (404 = never set - STOP and tell Simon; never draft from empty facts).
- **Track-pack cache (the reuse machinery - this is the ≥30%-cheaper mechanism, SIM-544/420):** at draft time, BEFORE building any facts-stable block (CV skeleton, achievement pool, cover-letter openings/hero phrases):
  1. `GET /api/track-packs/<track>?agentJobId=<runner-claimed job id>` (bearer; pass `agentJobId` whenever runner-dispatched - it is how run-economics correlates hits).
  2. **200** -> reuse `pack.blocks` verbatim for the facts-stable sections; skip regenerating them. Only the posting-tailored layer (keyword/ATS alignment, summary tailoring, achievement selection/ordering, the letter's posting-specific middle) is generated fresh.
  3. **404** -> build the facts-stable blocks from the facts API as below, then `PUT /api/track-packs/<track>` with `{ styleDigest, blocks }` so the NEXT job on this track hits.
  4. **501 `TRACK_PACK_STORE_UNAVAILABLE`** -> build fresh like a 404 but do NOT PUT; report it as a real anomaly, not an expected miss.
- **`styleDigest`** (ruling on SIM-544): the generation-recipe fingerprint - first 12 hex of sha256 of THIS skill file's content at run time (`python -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()[:12])" <this file>`). A recipe/style change then distinguishes stale packs; the server treats it as opaque.
- **Facts editing rules** (migrated from the vault `ops/facts/README.md` per the 2026-07-23 cord-cut decision, SIM-614 - this is now the canonical copy; the vault README is history only):
  - **One canonical fact, one place.** If a number changes (quota %, applicant count, ...), update it via `PUT /api/facts/:kind`, never inside a generated CV/cover letter directly.
  - **Track new wins in the facts store first.** Don't add a bullet directly to a generated CV variant; add it to the `professional_experience` doc under the right job + track (`PUT /api/facts/professional_experience`), then regenerate.
  - **Hero stats** are the numbers worth repeating in cover letters and headlines - keep the list short (3-5 per job).
  - **Quote integrity.** Achievements are written verb + object + quantified outcome; keep that voice when adding.

## Trigger
When Simon says **"run first-draft-job"** / "first draft this posting" / "generate this posting" / "make the CV and cover letter for this", or the app launches it for a job folder. The job usually already exists as a `Jobs/<Role> - <Employer>/` folder with `status: queued` (scouted, boxes ticked). It can also be a fresh posting (PDF/URL) pasted directly in chat.

## Inputs
- The posting - either an existing queued `Jobs/<role>/` job, or pasted in chat.
- If a posting is missing the **company/org name** or **role title** (some pasted blurbs are vague), ask before creating the folder.
- If you are genuinely torn between two tracks for a posting, state both and ask before generating.
- Context to gather:
  - The posting itself (the source of truth for title, employer, requirements, addressee, deadline).
  - Facts kind `resume` (facts API, see "Facts + track-pack access") - titles, summaries, technical expertise, languages, education, training, involvement (per track).
  - Facts kind `professional_experience` - per-job achievements bucketed by track, plus `hero_stats` and the Maple Armor `status_note` (load-bearing honesty rules).
  - Facts kind `cover_letter` - openings, the three paragraph blocks, closing, hero phrases, current research engagements (per track).
  - This file's "Facts + track-pack access" section above - the editing/usage rules that govern the facts content (migrated off the vault README, SIM-614).
  - `wiki/projects/job-search-2026.md` - the project this application rolls up to.

## Steps
1. **Find the work.** Jobs live in `Jobs/<Role> - <Employer>/`. Candidates are folders whose `<Role>.md` card has `status: lead` or `queued` (from discovery / scouting). Or process a posting Simon pastes in chat. If nothing qualifies and nothing was pasted, ask and stop. Process each independently through steps 2-11.
   - **Batch criteria (default when Simon says "run for due-this-week / all available"):** generate for **every private-sector job (`sector: private`) - these have no deadline, so apply ASAP** - PLUS every public job (`sector` in municipal / provincial / federal / bps / nonprofit) whose `deadline` is **within this week** (skip past-deadline ones). Use the card's `sector` and `deadline` frontmatter.
   - **Deadline over -> pass it (Simon's rule, 2026-06-30).** If a posting's `deadline` is **before today**, skip it: do not draft, finalize, or submit. The deadline date itself still counts as open (a job closing today is in play). If an already-drafted job's deadline passes unsubmitted, set its card to `status: closed` with a one-line "deadline passed YYYY-MM-DD" note so it drops off the actionable list. Treat `rolling` / blank / `open until filled` as always-open.
2. **Read the posting (pull from discovery first).** Each job folder already holds the posting reference from discovery:
   - Read `Jobs/<role>/job-description.md`. If it has the full posting, use it. If it is still a **stub** (just link + metadata), **fetch the full posting** from the saved `link` (`WebFetch`; `.pdf` via `Read`, `.docx` via `read_docx.py`) and paste it into `job-description.md` so it is saved for next time. For walled links (LinkedIn/Indeed), use the Google-cached/snippet content you can get and note that it is partial.
   - **Deadline:** take it from the card / `job-description.md`. If missing, it should have been captured at discovery - re-check the posting (fetch) for a closing date. **Private-sector jobs have no deadline -> treat as ASAP** (do not block on a deadline). Only public jobs gate on the this-week deadline.
   Extract: **job title**, **company/org**, location/mode, key requirements and keywords, the addressee, and any deadline.
3. **Pick the track.** Map the posting to exactly one:
   - `industry_outreach_focused` (preferred) - higher-ed industry outreach, partnerships, commercialization, ecosystem/program officer, Mitacs/OCI/OVIN/VPRI, knowledge mobilization. Differentiator: translates across researcher and industry worlds.
   - `higher_ed_generalist_focused` (breadth/security) - admissions, recruitment, program coordination, student advising, records, front-line/admin. Differentiator: institutional-system fluency (Quercus, StarRez, ACORN, Power Automate) + FIPPA/EDIOO/SafeTALK.
   - `b2b_gtm_focused` (industry option) - GTM, partnerships, business ops at a company/startup; an ops+sales+product blend, not a pure quota-carrying rep.
   - `operations_leadership_focused` - business operations / special projects / chief-of-staff; ops not sales (Maple Armor ops + BYLOCL ERP).
   - `public_sector_focused` - government program / policy / partnerships / operations; competency / STAR framing, bilingual + EDI + records governance.
   - `aerospace_defence_focused` - aerospace / space / defence industry BD + partnerships (KARI + AmplifiedSpace + CS; leans aerospace/space).
   - `fire_alarm_focused` - fire alarm / fire protection / life-safety / emergency-lighting industry, whole ecosystem (manufacturer, distributor/ESD, electrical contractor, integrator, engineering firm); Simon's current industry (Maple Armor).
   When close, the `job-description-analyzer` skill can score the fit. State the chosen track and a one-line reason to Simon as you go. (Track = which facts to use; the posting's **sector** is separate and only sets tailoring effort.)
4. **Folder.** If the job was scouted it already has a `Jobs/<Role> - <Employer>/` folder - use it. For a fresh posting, create `Jobs/<Role> - <Employer>/` (folder name = `<Role> - <Employer>`, e.g. `Program Officer - University of Toronto`; strip Windows-illegal characters `\ / : * ? " < > |` and trailing dots/spaces; collapse doubled spaces). Note the folder NEVER moves after this - status changes are frontmatter-only.
5. **Posting.** Make sure the posting PDF is in that folder (keep its filename; if it was pasted text, save it as `job-description.md`).
6. **Generate the CV.** Build from the facts for the chosen track - do not invent content, do not copy a prior generated CV. **Track-pack first (SIM-597):** run the cache protocol in "Facts + track-pack access" - on a HIT, take the facts-stable blocks from `pack.blocks` and only generate the posting-tailored layer; on a MISS, build the blocks below from the facts API, then PUT the pack:
   - Header: name + contact from the `resume` facts. The real CV format has **no headline/title line** under the name; positioning goes in the summary. **Never** put "Account Manager" on output (see Maple Armor `status_note`); the Maple Armor `position` is "Special Project Lead / Executive Assistant to the President".
   - Summary = `personal_info.summaries[track]`.
   - Experience: each job newest-first, using `achievements[track]`. Reorder/prioritize bullets to surface the posting's keywords first; you may drop the weakest bullet for length, but never add a bullet that is not in the facts. Aim to fill **two full pages**: lengthen the experience section with more relevant bullets and roles rather than leaving a half-empty second page.
   - Then `technical_expertise`, `languages`, `education`, `training_and_certifications`.
   - **Consulting umbrella (default).** Group the concurrent advisory engagements (KARI + AmplifiedSpace + the current Fintech startup) under ONE experience entry: "Commercialization and Business Development Consultant" (or "...and Partnerships Consultant" for `industry_outreach_focused`), company "Independent Consulting", duration **"December 2022 - Present"**, one client-labeled bullet each (lead with the client name). This turns the 2024-2025 overlap into one intentional, current consulting practice. Keep AmplifiedSpace prominent (it was full-time-level). On content-heavy CVs, merge KARI+AmplifiedSpace into one bullet to hold two pages. See the `professional_experience` facts -> `metadata.consulting_grouping_convention`.
   - **Involvement-as-experience (default).** Render `involvement` as experience-style entries (position / organization / bullets, 11pt, NO dates) - not a flat bullet list - especially current/substantive roles (AEROTEC Global Partnership Coordinator; Qonference+QueerTech merged; Researcher for `industry_outreach_focused`; BITS). The renderer prints any involvement object like an experience entry automatically.
   - **AI + automation enablement hook.** When the posting rewards it, foreground Simon's "AI application pipeline" strength (applies AI + workflow automation to streamline operations) with the governance qualifiers (FIPPA / records governance, data safety, EDI, sustainability, workplace-learning) in the summary, a skills line, and 1-2 bullets.
   - **Fill two pages (80-100% of page 2).** The CV should fill close to two full pages; lengthen experience/involvement bullets rather than leaving page 2 half-empty. The renderer warns if it is not exactly 2 pages.
   - Honesty guards: keep SI Alarms / ExcelPro as **originated / structured / advanced** pipeline (never "closed/delivered"); disclose the AmplifiedSpace/KARI concurrency per `overlap_note`.
   - Capture the tailored CV (summary, reordered per-job bullets, skills, education, languages, training, involvement) in the `cv` block of `application-content.json` (schema in the header of `ops/scripts/render_application.py`). The `resume-tailor` skill is a good driver for the tailoring; keep it truthful to the facts. There is no headline line; tune positioning via the summary. Foreground the cross-track emphasis (process optimization / administration / workflow automation / AI + AI agents) when the posting rewards it. See [[cv-cover-letter-workflow]].
7. **Generate the cover letter.** From the `cover_letter` facts for the chosen track (on a track-pack HIT the openings/hero-phrase blocks come from `pack.blocks`; only the posting-specific middle is fresh):
   - Opening = `openings[track]` with `{role}`, `{institution}`, `{years}`, `{areas}` filled from the posting.
   - Body = `paragraph_2_higher_ed_block[track]`, `paragraph_3_beyond_higher_ed_block[track]`, `paragraph_4_differentiator_and_edi_block[track]`.
   - For `industry_outreach_focused`, weave in a relevant item from `current_research_engagements` if it fits the posting.
   - Closing = `closings.default` (fill `{role-specific strengths}` / `{institution}`) + `closings.signature`.
   - Address to the named hiring manager if the posting gives one, else "Dear Hiring Committee". Tighten to roughly one page.
   - Capture the filled letter in the `cover_letter` block of `application-content.json` (`paragraphs` = opening, p2, p3, p4, closing). The `cover-letter-generator` skill can draft the prose.
8. **Render the documents (.docx only).** Set `outdir`, `cv_basename` (`Simon Kim - CV - <Job Title>`), and `cl_basename` in the JSON, then run with `--no-pdf`:
   `python ops/scripts/render_application.py "Jobs/<Role> - <Employer>/application-content.json" --no-pdf`
   It writes the CV and cover letter as `.docx` (python-docx) in Simon's real format (Times New Roman, ruled ALL-CAPS headings; see [[cv-cover-letter-workflow]] for the spec). **No PDF at first draft** - finalize-job renders the submission PDFs after Simon answers the gaps page (this also keeps the batch fast and frees MS Word). The PDF-based page guard (CV = 2 pp) therefore runs at finalize; aim for two full pages by content. To revise, edit the JSON and re-run; it overwrites in place.
9. **Create the gaps page (required on EVERY run, single or batch).** Write `Jobs/<Role> - <Employer>/<Role> gaps.md` - the page Simon fills in, and finalize-job's primary input. A first draft without it silently stalls the pipeline: Simon has nothing to answer, so finalize never fires (bug t-1784258203647: single-job runs skipped this because it was only described under Batch mode). If a usable gaps page already exists from a gaps-first scout pass, keep it - never overwrite Simon's ticks. Content: 4-8 prioritized tick-boxes for the specific things the posting wants that are NOT yet in the facts store (skills, systems, volumes, examples), most valuable first, each with a short hint of why it matters. Format:
   ```markdown
   # <Job Title> - <Employer> (<dept if known>) : gaps

   _Tick anything you have; add a number or one word if useful, skip the rest. finalize-job will fold your answers into the facts store and regenerate._

   - [ ] <specific skill / system / volume the posting wants that is not in the facts>
   - [ ] <...>

   **Anything else relevant? ->**
   ```
   `ops/scripts/check_consistency.py` (check D) flags any `status: drafted` job whose folder lacks this file.
10. **Update the job file** (`Jobs/<Role> - <Employer>/<Role>.md`). If the job was scouted, this file already exists with `type: job` frontmatter + tick-boxes: flip `status: queued` -> `drafted` and append the application notes (why-this-track, fit, honest gaps) below the checklist. **Leave `applied:` blank** - it is NOT a draft field. `applied` is the application-sent date and is stamped only when Simon actually submits and flips the status to `submitted` (the app stamps it automatically on that transition; data contract: applied on a pre-application status is a bug - it makes the app show "Applied" for a job never submitted). For a fresh (un-scouted) posting, create `<Role>.md` from the output template below. This file IS the Job Tracker card - nothing else to do for tracking.
11. **Record it.** Add a `log.md` entry by hand when the run warrants it, and an action item to `workspaces/daily/ops/dashboard.md` (Professional-dev section) if a follow-up is pending (e.g. "review + submit"), prefixed with the relevant wiki link. The Job Tracker updates itself from the job file's `status` - no script to run, no folder to move, no table to maintain. (`finalize_application.py`, `sync_tracker.py`, `gen_job_dashboard.py` are all retired.)
12. **Summarize in chat.** For each posting: title, employer, track chosen (+ why), folder path, and the files generated (the two `.docx` + gaps page + job file). Flag anything that needs Simon's eyes (missing fact, close-call track, honest gap, deadline).

## Output
Each job lives in `Jobs/<Role> - <Employer>/` (one folder per job, never moved). When drafted it contains:
```
<original posting file>                       # the posting PDF (or job-description.md if pasted)
<Role>.md                                     # THE job file: type:job frontmatter + checklist + notes = the tracker card
Simon Kim - CV - <Role>.docx                  # .docx only at first draft; finalize-job adds the .pdf
Simon Kim - Cover Letter - <Role>.docx
<Role> gaps.md                                # REQUIRED: the tick-box page Simon answers; finalize-job's primary input
application-content.json                      # the tailored facts the renderer used
```

The job file `<Role>.md` (frontmatter makes it the live Job Tracker card - Bases reads `type: job` files directly, no card to generate):
```markdown
---
type: job
role: <Job Title>
employer: <Company>
track: <industry_outreach_focused | higher_ed_generalist_focused | b2b_gtm_focused | operations_leadership_focused | public_sector_focused | aerospace_defence_focused | fire_alarm_focused>
fit: <strong | moderate | stretch>
status: drafted        # queued -> drafted -> submitted -> interview -> offer -> rejected / closed
deadline: <YYYY-MM-DD or blank>
applied:               # LEAVE BLANK at draft. Stamped only when Simon submits (status -> submitted); it is the application-sent date, not the draft date.
tags: [job]
---

# <Job Title> - <Company>

- Why this track: <1-2 sentences tied to the posting>
- Source posting: <filename / URL>
- Location / mode: <if stated>
- Addressed to: <name + title, or "Hiring Committee" if unknown>
- Fit / gaps: <anything to flag - missing facts, close-call track, custom tailoring, honest gaps>
```

## Batch mode (gaps-first)
When processing many postings at once, do a scout pass first: for each posting create `Jobs/<Role> - <Employer>/` with a `<Role>.md` job file (status: queued; proposed track, current-facts fit, what to lead with) plus a `<Role> gaps.md` page of prioritized "what I do not know about you" tick-boxes, and the posting PDF. Generate the first-draft CV + cover letter so there is something concrete to react to. Simon then reviews the gaps pages and answers them, and [`finalize-job`](finalize-job.md) (Phase 2) folds his answers into the facts store and regenerates the documents. Full flow + template in [[cv-cover-letter-workflow]].

### Batch SOP for 10+ jobs (learned 2026-06-30; see [[batch-job-generation-lessons]])
A 30+ job run hit the Claude session limit and a silent render bug. Run large batches this way:
1. **Drop expired postings first.** Apply the "deadline over -> pass it" rule above before doing any work; order the rest **deadline-first** so the urgent ones are safe if the run is interrupted.
2. **Docx-only.** Render every first draft with `--no-pdf` (`"pdf": false`) - no MS Word, much faster, and avoids COM contention across parallel work. PDFs come at finalize.
3. **Delegate per track, render per job.** Fan out sub-agents (roughly one per track / 4-6 jobs) so the heavy per-job tailoring stays out of the main context. Tell each agent to **render each job before starting the next**, so a death mid-run leaves completed jobs intact. Give each agent the routine + the "Facts + track-pack access" block (credentials + cache protocol) + an example finished folder.
4. **Verify on disk - do not trust "done."** After the agents report, count the actual `.docx` per folder (a save can fail silently on long Windows paths; `render_application.py` now guards this but still check). Re-render any folder that has `application-content.json` but no docx.
5. **Central bookkeeping is yours, not the agents'.** Sub-agents must NOT touch `log.md`, the dashboard, `index.md`, or the xlsx (concurrent writes corrupt them). Do those yourself once, at the end.
6. **Session-limit awareness.** If the run is large, expect the limit; postings already fetched into `job-description.md` survive a restart, so resume from there. The cloud/scheduled runner CANNOT write this local OneDrive vault, so generation must stay local; if Simon wants to stagger, queue the remaining batches in a file (e.g. `ops/outputs/deferred-firstdraft-batches.md`) and fire them on his go.

## Quality bar
- **No gaps page, no draft.** A job is not `status: drafted` until its `<Role> gaps.md` exists beside the docs (step 9); `check_consistency.py` check D enforces this.
- **Facts are the only source.** If the posting needs a fact you do not have, do not invent it; note the gap in the job's `<Role>.md` and tell Simon to add it (via a profile-refresh run or `PUT /api/facts/:kind`), then regenerate.
- **No em dashes** anywhere, including inside generated CVs and cover letters.
- **Windows filenames**: sanitize the folder and file names; OneDrive will choke on illegal characters.
- **One posting, one track.** Do not blend tracks in a single CV.
- **Status, not folders.** A job's stage is its `status` frontmatter, not its location; the `Jobs/<role>/` folder never moves. Never recreate `Not Applied/`, `Queue Review/`, or `Applied/`.
- **Quota/title honesty**: respect the Maple Armor `status_note` and the AmplifiedSpace/KARI `overlap_note` every time.
- Both `.docx` exist on disk after the run; the CV aims at two full pages; `applied:` left blank.

## Related
- [`finalize-job`](finalize-job.md) (Phase 2), [[job-search-2026]], [[cv-cover-letter-workflow]]
- Facts API kinds `resume` / `professional_experience` / `cover_letter` (jobhunt-cloud `server/facts-lib.js`); this file's "Facts editing rules" (migrated off the vault README, SIM-614)
- Skills: `resume-tailor`, `cover-letter-generator`, `job-description-analyzer`, `resume-ats-optimizer`, `docx`, `pdf`
