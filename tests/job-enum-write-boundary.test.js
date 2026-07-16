import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [SCHEMA] Job enum write boundary (t-1783199066683). Job
// track/fit/sector/tailoring/status were accepted as UNVALIDATED free strings
// while the conceptually identical DiscoverySource enums 400 (data-schema §6
// gap 2). The fix adopts the TASK posture - a present-but-invalid enum value
// is SILENTLY IGNORED (never written, never a 400), matching (a) the Job write
// path's own silent-drop of unknown KEYS (WRITABLE_FIELDS) and (b) the pursue
// path's need to keep working over messy legacy workbook rows. This suite
// pins:
//   - PATCH: invalid values dropped, valid values written, the REST of the
//     same body still applies, null/"" still CLEARS a field;
//   - create paths (POST /api/jobs, POST /api/discovery/pursue): invalid
//     values land as blank/defaulted, never a 400;
//   - TOLERANT READ unchanged: a legacy on-disk value is served verbatim;
//   - the pure guard (dropInvalidJobEnums) itself.

let app;
let pure;
let tmpRoot;
let fixture;

const jobMd = (extra = []) =>
  [
    "---", "type: job", "role: Guard Role", "employer: Guard Co",
    "track: b2b_gtm_focused", "fit: strong", "status: lead",
    "sector: private", "tailoring: light", ...extra, "tags: [job]",
    "---", "", "# Guard Role - Guard Co", "", "**Lead with:** x", "",
  ].join("\n");

const JOB = "Guard Role - Guard Co";
const jobFile = () => path.join(fixture, JOB, "Guard Role.md");
const id = encodeURIComponent(JOB);

function writeFixture() {
  fs.rmSync(fixture, { recursive: true, force: true });
  const dir = path.join(fixture, JOB);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobFile(), jobMd(), "utf8");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-enum-guard-"));
  fixture = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(docsDir, { recursive: true }); // empty registry -> provenance path is inert
  writeFixture();
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  const mod = await import("../server/index.js");
  app = mod.app;
  pure = mod;
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => writeFixture());

describe("dropInvalidJobEnums (pure)", () => {
  it("drops invalid enum values, keeps valid ones, passes non-enum keys through", () => {
    const out = pure.dropInvalidJobEnums({
      track: "not_a_track",
      fit: "strong",
      sector: "Municipal", // case matters: the vocabulary is closed and lowercase
      tailoring: "bespoke",
      status: "vibing",
      next_action: "call them",
    });
    expect(out).toEqual({ fit: "strong", next_action: "call them" });
  });

  it("lets null/'' through (clearing a field stays legal) and never mutates its input", () => {
    const input = { track: null, fit: "", sector: "bps" };
    const out = pure.dropInvalidJobEnums(input);
    expect(out).toEqual({ track: null, fit: "", sector: "bps" });
    expect(input.sector).toBe("bps");
  });

  it("drops non-string junk (objects, numbers, arrays) on enum keys", () => {
    expect(pure.dropInvalidJobEnums({ track: 7, fit: { evil: true }, status: ["lead"] })).toEqual({});
  });
});

describe("PATCH /api/jobs/:id enum boundary (invalid ignored, Task posture)", () => {
  it("drops an invalid value while applying the REST of the same body (never a 400)", async () => {
    const res = await request(app)
      .patch(`/api/jobs/${id}`)
      .send({ track: "totally_bogus", fit: "moderate", next_action: "follow up" });
    expect(res.status).toBe(200);
    expect(res.body.track).toBe("b2b_gtm_focused"); // untouched
    expect(res.body.fit).toBe("moderate"); // applied
    expect(res.body.nextAction).toBe("follow up"); // applied
    expect(fs.readFileSync(jobFile(), "utf8")).toContain("track: b2b_gtm_focused");
  });

  it("writes valid values for every guarded field", async () => {
    const res = await request(app).patch(`/api/jobs/${id}`).send({
      track: "public_sector_focused",
      fit: "stretch",
      sector: "municipal",
      tailoring: "heavy",
      status: "queued",
    });
    expect(res.status).toBe(200);
    expect(res.body.track).toBe("public_sector_focused");
    expect(res.body.fit).toBe("stretch");
    expect(res.body.sector).toBe("municipal");
    expect(res.body.tailoring).toBe("heavy");
    expect(res.body.status).toBe("queued");
  });

  it("an invalid status is IGNORED on write - the on-disk value stays, instead of a bogus write coerced to 'lead' on read", async () => {
    await request(app).patch(`/api/jobs/${id}`).send({ status: "queued" });
    const res = await request(app).patch(`/api/jobs/${id}`).send({ status: "Submitted" }); // wrong case = invalid
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued"); // unchanged
    expect(res.body.rawStatus).toBe("queued"); // nothing bogus on disk
    expect(res.body.applied).toBeNull(); // and no applied stamp fired
  });

  it("null still clears a field (the line is removed, not validated)", async () => {
    const res = await request(app).patch(`/api/jobs/${id}`).send({ track: null });
    expect(res.status).toBe(200);
    expect(res.body.track).toBe("");
    expect(fs.readFileSync(jobFile(), "utf8")).not.toContain("track:");
  });
});

describe("create paths (POST /api/jobs, POST /api/discovery/pursue)", () => {
  it("POST /api/jobs: invalid track/fit land blank; invalid sector defaults to private (tailoring: light); never a 400", async () => {
    const res = await request(app).post("/api/jobs").send({
      role: "Messy Role",
      employer: "Messy Co",
      track: "Industry Outreach", // a display LABEL, not a key -> invalid
      fit: "Strong", // wrong case -> invalid
      sector: "Municipal", // wrong case -> invalid -> default private
    });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("");
    expect(res.body.fit).toBe("");
    expect(res.body.sector).toBe("private");
    expect(res.body.tailoring).toBe("light");
  });

  it("POST /api/jobs: valid enums pass through exactly as before", async () => {
    const res = await request(app).post("/api/jobs").send({
      role: "Clean Role",
      employer: "Clean Co",
      track: "aerospace_defence_focused",
      fit: "stretch",
      sector: "federal",
    });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("aerospace_defence_focused");
    expect(res.body.fit).toBe("stretch");
    expect(res.body.sector).toBe("federal");
    expect(res.body.tailoring).toBe("heavy");
  });

  it("pursue with legacy/messy enum values still creates the job (blank fields, NEVER a 400 - old finds stay triageable)", async () => {
    const res = await request(app).post("/api/discovery/pursue").send({
      title: "Legacy Find Role",
      employer: "Legacy Find Co",
      track: "Higher-Ed Generalist", // legacy label in the workbook row
      fit: "good", // legacy free text
      sector: "provincial", // valid - carried
    });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("");
    expect(res.body.fit).toBe("");
    expect(res.body.sector).toBe("provincial");
  });
});

describe("tolerant read is UNCHANGED (this hardens writes only)", () => {
  it("legacy on-disk values are still served verbatim, never rewritten by a read", async () => {
    fs.writeFileSync(
      jobFile(),
      [
        "---", "type: job", "role: Guard Role", "employer: Guard Co",
        "track: Industry Outreach", "fit: Great fit!", "status: shortlisted",
        "sector: Municipal", "tailoring: bespoke", "tags: [job]",
        "---", "", "# Guard Role - Guard Co", "",
      ].join("\n"),
      "utf8"
    );
    const before = fs.readFileSync(jobFile(), "utf8");
    const res = await request(app).get("/api/jobs");
    const j = res.body.find((x) => x.id === JOB);
    expect(j.track).toBe("Industry Outreach"); // verbatim passthrough
    expect(j.fit).toBe("Great fit!");
    expect(j.sector).toBe("Municipal");
    expect(j.tailoring).toBe("bespoke");
    expect(j.status).toBe("lead"); // status alone is read-coerced (existing contract)
    expect(j.rawStatus).toBe("shortlisted");
    expect(fs.readFileSync(jobFile(), "utf8")).toBe(before); // the read wrote nothing
  });
});
