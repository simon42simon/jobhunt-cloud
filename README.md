# Jobhunt Command Center

An AI-assisted job-hunt pipeline that runs the whole search as one loop: **discover** roles,
**tailor** a CV and cover letter to each posting, **track** every application on a Kanban board,
and **prep** for interviews and offers. It is built local-first (your data stays on your machine)
and ships a cloud-deployable image with a public, fictional-data demo.

> **This repository is a portfolio demo.** It is seeded with **fictional** people, employers, and
> applications - there is no real personal or job-search data anywhere in this repo or its history.
> The point is to show the engineering, not to expose a real job search.

## What it does (30-second version)

Job hunting is a pipeline that most people run in a spreadsheet and their inbox. This app turns it
into a real product:

- **Discover** - pull postings from configurable sources into a triage queue.
- **Tailor** - AI agents draft a CV and cover letter grounded strictly in your own facts (never
  fabricated), ATS-optimized per posting.
- **Track** - a live Kanban board (`lead -> queued -> drafted -> submitted -> interview -> offer`)
  with drag-to-change-status, a weekly-target ring, and a full activity timeline.
- **Prep** - generate STAR stories, a tailored interview prep sheet, and offer-comparison analysis
  when a role reaches the interview/offer stage.

## Architecture

The app is a React + TypeScript single-page UI over an Express API, with a **pluggable storage
seam** so the exact same code runs two very different ways:

```
        React + Vite SPA  (Kanban, triage, detail drawers, run panel)
                     |  /api  (+ Server-Sent Events for live reload)
                     v
             Express API server
                     |
            Store interface  (one logical data-operation boundary)
              /                         \
        FileStore                      PgStore
   (local: Markdown files              (cloud: vanilla Postgres
    are canonical, byte-identical       is canonical for that
    edits back to disk)                 single instance)
```

- **Storage seam (the headline design).** Every data operation goes through a single `Store`
  interface. `FileStore` keeps Markdown-frontmatter files as the source of truth on your laptop and
  writes surgical, byte-identical one-line edits back (so it stays in sync with any editor or git).
  `PgStore` implements the identical interface against vanilla Postgres for a cloud instance. **One
  store per deployment, never two** - the two are never authoritative for the same data at once. A
  single parameterized contract test suite runs against **both** stores, so they cannot drift.
- **Hybrid agent runner (data-sovereignty by construction).** In the cloud, the server holds an
  **outbound-only queue**; a small runner on the trusted laptop *polls* it over HTTPS, runs the
  generation locally against private facts, and posts back only the generated output. The cloud
  never opens a connection into the laptop and never sees the raw personal facts - the privacy
  gradient is structural, not a promise.
- **Demo mode.** `APP_MODE=demo` boots against a separate Postgres seeded from curated **fictional**
  lists, replays pre-recorded agent transcripts instead of spending model tokens, and resets itself
  on a schedule - a real end-to-end UX with zero real data and zero spend. A boot assertion
  fails-closed if a demo process can see anything real.
- **One image, three deployments.** A single Docker image serves laptop (FileStore), private cloud
  (PgStore), and public demo (PgStore + fictional), differentiated purely by 12-factor env.

See `docs/data-schema.md` for the full entity/field/writer map and `docs/changelog.md` for the build
history. Product architecture decisions are recorded as an ADR log.

## The data-safety design story

This is the part worth three minutes of a technical reader's time. The app is designed for **data
sovereignty** from the ground up:

- **Nothing auto-submits.** The app drafts materials and emails; a human always reviews and sends.
  Agents can edit files but can never submit an application or contact an employer.
- **Facts stay local.** Personal facts and the master CV never leave the machine, even in the cloud
  topology - only generated outputs move, and only outbound from the laptop.
- **Byte-identical writes.** Local edits are surgical frontmatter patches (EOL/BOM preserved), so
  the app is a safe co-editor alongside your own tools - it never rewrites a file it did not need to.
- **Loopback-first.** The local server binds `127.0.0.1` by default; exposing it anywhere is an
  explicit, authenticated opt-in.
- **Never deletes.** The data contract forbids destructive operations on the store.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind v4, a small shadcn/ui-based design system (vendored) |
| Backend | Node.js, Express, Server-Sent Events for live reload |
| Storage | Markdown + YAML frontmatter (local) / vanilla PostgreSQL via `node-pg-migrate` (cloud) |
| Auth | Argon2id passphrase hash, stateless HMAC session cookies, feature-flagged |
| Tests | Vitest + supertest; a parameterized store-contract suite that runs against both backends |
| Packaging | Multi-stage Dockerfile (non-root, healthcheck), GitHub Actions gate + deploy-on-tag |

## How it's built

- **One gate:** `npm run check` (typecheck + the full Vitest suite + lint + a secret scan) is the
  single release gate; CI runs the same gate on every push and PR.
- **Tested at the seam:** the store-contract suite proves `FileStore` and `PgStore` behave
  identically, and a differential test compares them over a fixture dataset.
- **Decisions are recorded:** architecture choices live as an ADR log rather than tribal knowledge.

## Run it locally

```bash
npm install               # first time
cp config.example.json config.local.json   # then set jobsDir/dataDir to local paths
npm run dev               # Express API on :8787, Vite UI on :5180
```

`npm run dev` runs the file bridge (`server/index.js`) and the web UI together. With no cloud env
set, it defaults to `FileStore` - files on disk are canonical.

## Run it as a container

```bash
docker build -t jobhunt-cloud .
docker run -p 8787:8787 \
  -e STORE_BACKEND=pg -e DATABASE_URL=postgres://... \
  -e APP_MODE=demo \
  jobhunt-cloud
```

The image runs database migrations as a release step before the server boots, exposes a `/healthz`
liveness probe, and honours a platform-injected `PORT`. See `DEPLOYMENT.md` for the full env matrix.

## License

MIT - see `LICENSE`. Portfolio project by Simon Kim.
