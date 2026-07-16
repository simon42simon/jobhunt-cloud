import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normDate,
  yamlScalar,
  parseLeadWith,
  parseFront,
  parseFrontmatter,
  sanitizeForPath,
  isInsideJobsDir,
  updateFrontmatter,
  sanitizeId,
  appendJsonl,
  buildOpenCommand,
  ensureArrays,
} from "../server/lib.js";

describe("normDate", () => {
  it("keeps a date-only string literal", () => {
    expect(normDate("2026-06-23")).toBe("2026-06-23");
  });
  it("formats a Date from UTC parts (no timezone shift)", () => {
    expect(normDate(new Date(Date.UTC(2026, 5, 23)))).toBe("2026-06-23");
  });
  it("passes non-date text through", () => {
    expect(normDate("1-yr contract")).toBe("1-yr contract");
  });
  it("maps null/empty to null", () => {
    expect(normDate(null)).toBeNull();
    expect(normDate("")).toBeNull();
    expect(normDate(undefined)).toBeNull();
  });
});

describe("yamlScalar", () => {
  it("leaves plain tokens unquoted", () => {
    expect(yamlScalar("lead")).toBe("lead");
    expect(yamlScalar("2026-06-23")).toBe("2026-06-23");
  });
  it("quotes values with structural characters", () => {
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("tag, other")).toBe('"tag, other"');
  });
  it("quotes leading - or ? and trims-risky whitespace", () => {
    expect(yamlScalar("- x")).toBe('"- x"');
    expect(yamlScalar(" leading")).toBe('" leading"');
  });
  it("escapes inner quotes", () => {
    expect(yamlScalar('he said "hi"')).toBe('"he said \\"hi\\""');
  });
  it("empty -> empty quotes", () => {
    expect(yamlScalar("")).toBe('""');
    expect(yamlScalar(null)).toBe('""');
  });
});

describe("parseLeadWith", () => {
  it("extracts the lead-with line", () => {
    expect(parseLeadWith("intro\n**Lead with:** translate research\nmore")).toBe("translate research");
  });
  it("returns empty when absent", () => {
    expect(parseLeadWith("no lead here")).toBe("");
  });
});

describe("sanitizeForPath", () => {
  it("strips illegal filename characters and collapses spaces", () => {
    expect(sanitizeForPath("a/b:c")).toBe("abc");
    expect(sanitizeForPath("Manager  (X)")).toBe("Manager (X)");
  });
});

// Shape guard for id-typed task references (project / milestone / owner /
// delegated_by / wbs). It STRIPS disallowed characters (it does not hyphenate
// whitespace), lowercases, trims, and maps an empty result to null - so a
// reference can never smuggle in a path or YAML-structure character.
describe("sanitizeId", () => {
  it("passes a clean kebab/dotted id through unchanged", () => {
    expect(sanitizeId("prj-eng-pm-layer")).toBe("prj-eng-pm-layer");
    expect(sanitizeId("prj-eng-pm-layer-m1")).toBe("prj-eng-pm-layer-m1");
    expect(sanitizeId("1.2.3")).toBe("1.2.3");
  });

  it("lowercases and removes whitespace (does not hyphenate it)", () => {
    expect(sanitizeId("  CTO  ")).toBe("cto");
    expect(sanitizeId("Software Architect")).toBe("softwarearchitect");
  });

  it("strips disallowed special characters", () => {
    expect(sanitizeId("Bad Owner!@#")).toBe("badowner");
    expect(sanitizeId("a/b\\c:d")).toBe("abcd");
  });

  it("maps an empty or all-stripped value to null (never an empty string)", () => {
    expect(sanitizeId("")).toBeNull();
    expect(sanitizeId("   ")).toBeNull();
    expect(sanitizeId("!@#")).toBeNull();
    expect(sanitizeId(null)).toBeNull();
    expect(sanitizeId(undefined)).toBeNull();
  });
});

// parseFrontmatter is the shared helper behind the docs browser's `meta`
// extension (GET /api/docs, GET /api/doc/*; docs/product-hub-ia-v2.md section
// 7 B2). Distinct from parseFront (job frontmatter, always expected to
// exist): a doc's frontmatter is OPTIONAL, so "no fence" (meta: null) and "an
// empty fence" (meta: {}) are deliberately different results.
// Regression: a leading UTF-8 BOM must not hide a job's frontmatter. Two real
// job files (UTMCIP BDO, Assistant to the Chair) vanished from the dashboard
// because a BOM made gray-matter miss the `---` fence, so `type: job` was never
// seen and the whole folder was silently dropped.
describe("parseFront (BOM tolerance)", () => {
  const fm = ["---", "type: job", "role: BOM Role", "status: submitted", "---", "", "# body"].join("\n");

  it("parses frontmatter even when the file starts with a UTF-8 BOM", () => {
    const parsed = parseFront("﻿" + fm);
    expect(parsed?.data?.type).toBe("job");
    expect(parsed?.data?.status).toBe("submitted");
  });

  it("still parses a normal (no-BOM) file identically", () => {
    expect(parseFront(fm)?.data?.type).toBe("job");
  });
});

describe("parseFrontmatter (optional doc frontmatter)", () => {
  it("parses meta and strips the frontmatter block from the body", () => {
    const raw = [
      "---",
      "type: review",
      "agent: people-enablement",
      "recs: 6",
      "date: 2026-07-01",
      "---",
      "",
      "# Weekly enablement review",
      "",
      "body content here",
    ].join("\n");
    const { meta, body } = parseFrontmatter(raw);
    expect(meta).toEqual({ type: "review", agent: "people-enablement", recs: 6, date: "2026-07-01" });
    expect(body.trim()).toBe("# Weekly enablement review\n\nbody content here");
    expect(body).not.toContain("---");
    expect(body).not.toContain("agent: people-enablement");
  });

  it("returns meta: null and the raw string, untouched, for a doc with no frontmatter", () => {
    const raw = "# Just a doc\n\nNo frontmatter here.\n";
    expect(parseFrontmatter(raw)).toEqual({ meta: null, body: raw });
  });

  it("does not coerce a YYYY-MM-DD date to a JS Date (JSON-schema engine, like job frontmatter)", () => {
    const raw = ["---", "date: 2026-07-01", "---", "", "body"].join("\n");
    const { meta } = parseFrontmatter(raw);
    expect(meta.date).toBe("2026-07-01");
    expect(typeof meta.date).toBe("string");
  });

  it("gives an empty fenced block an empty object, not null (the file DID open with a fence)", () => {
    const raw = ["---", "---", "", "body only"].join("\n");
    const { meta, body } = parseFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body.trim()).toBe("body only");
  });
});

describe("isInsideJobsDir", () => {
  const base = path.join(os.tmpdir(), "jobs-root");
  it("accepts a path inside the dir", () => {
    expect(isInsideJobsDir(base, path.join(base, "Role - Co"))).toBeTruthy();
  });
  it("rejects a path outside the dir", () => {
    expect(isInsideJobsDir(base, path.join(base, "..", "evil"))).toBeFalsy();
  });
});

// /api/open shell safety: the OS-open command is built as an execFile { cmd,
// args } argv pair, NOT an exec shell string. The target is always a standalone
// argv element, so cmd.exe / the shell never re-parses the path as shell syntax.
describe("buildOpenCommand", () => {
  it("returns an execFile argv (not a shell string) with the target as a lone arg on win32", () => {
    const target = "C:\\Users\\x\\Jobs\\Role - Co\\CV.docx";
    const { cmd, args } = buildOpenCommand("win32", target);
    expect(cmd).toBe("cmd");
    expect(args).toEqual(["/c", "start", "", target]);
    // the target is its own argv element, never concatenated into another arg
    expect(args[args.length - 1]).toBe(target);
  });

  it("passes a shell-metacharacter path through verbatim as ONE arg (no interpolation/escaping)", () => {
    const nasty = 'C:\\Jobs\\A & B "x" `y` $z\\CV.docx';
    const { cmd, args } = buildOpenCommand("win32", nasty);
    expect(cmd).toBe("cmd");
    // every arg is either a fixed token or EXACTLY the target - nothing quotes,
    // escapes, or splits it, so there is no shell re-parsing surface at all.
    expect(args).toEqual(["/c", "start", "", nasty]);
  });

  it("uses `open` on darwin and `xdg-open` elsewhere, with the target as a lone arg", () => {
    expect(buildOpenCommand("darwin", "/p/f.pdf")).toEqual({ cmd: "open", args: ["/p/f.pdf"] });
    expect(buildOpenCommand("linux", "/p/f.pdf")).toEqual({ cmd: "xdg-open", args: ["/p/f.pdf"] });
  });

  // The same builder reveals a FOLDER, not just a file (t-1783481685241): a
  // directory path is a plain path arg, so `start ""`/`open`/`xdg-open` open the
  // OS file manager AT that folder. No separate folder-open builder exists.
  it("reveals a folder path with the same argv shape (no trailing separator, one arg)", () => {
    const folder = "C:\\Users\\x\\Jobs\\Role - Co";
    expect(buildOpenCommand("win32", folder)).toEqual({ cmd: "cmd", args: ["/c", "start", "", folder] });
    expect(buildOpenCommand("darwin", "/p/Jobs/Role - Co")).toEqual({ cmd: "open", args: ["/p/Jobs/Role - Co"] });
    expect(buildOpenCommand("linux", "/p/Jobs/Role - Co")).toEqual({ cmd: "xdg-open", args: ["/p/Jobs/Role - Co"] });
  });
});

// YAML read-endpoint normalization: a partial hand-edit that drops an expected
// array key must yield [] not undefined, so a downstream .map/.filter can't throw.
describe("ensureArrays", () => {
  it("defaults a MISSING key to []", () => {
    expect(ensureArrays({ version: 1 }, ["projects", "milestones"])).toEqual({
      version: 1,
      projects: [],
      milestones: [],
    });
  });

  it("keeps a present array unchanged and BY REFERENCE (shape preserved when data is present)", () => {
    const projects = [{ id: "p1" }];
    const out = ensureArrays({ version: 1, projects }, ["projects", "milestones"]);
    expect(out.projects).toBe(projects); // same reference, not a copy
    expect(out.milestones).toEqual([]);
    expect(out.version).toBe(1);
  });

  it("replaces a present-but-non-array value (malformed edit) with []", () => {
    expect(ensureArrays({ roles: "oops" }, ["roles"]).roles).toEqual([]);
  });

  it("tolerates null / non-object input by returning an object with the defaulted keys", () => {
    expect(ensureArrays(null, ["phases"])).toEqual({ phases: [] });
    expect(ensureArrays(undefined, ["phases"])).toEqual({ phases: [] });
  });

  it("does not mutate the input object", () => {
    const input = { version: 1 };
    ensureArrays(input, ["projects"]);
    expect(input).toEqual({ version: 1 });
  });
});

// appendJsonl is the ONE writer for the activity log: used by the server's
// routine runner and by ops/activity-log-append.mjs so both share the same
// on-disk format. A failure here must never break a load-bearing write path -
// callers treat it as best-effort - but the written lines must be valid JSON
// with a ts stamp so the GET /api/activity reader can always parse them.
describe("appendJsonl", () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-jsonl-"));
    file = path.join(dir, "activity.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("creates the file, writes one JSON line, and stamps ts when the record omits it", () => {
    appendJsonl(file, { kind: "run", runId: "r1", status: "running" });

    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.kind).toBe("run");
    expect(rec.runId).toBe("r1");
    expect(rec.status).toBe("running");
    // ts must be a valid ISO-8601 string (round-trips through Date)
    expect(typeof rec.ts).toBe("string");
    expect(new Date(rec.ts).toISOString()).toBe(rec.ts);
  });

  it("appends on a second call, does not overwrite the first line", () => {
    appendJsonl(file, { kind: "run", status: "running" });
    appendJsonl(file, { kind: "run", status: "done" });

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).status).toBe("running");
    expect(JSON.parse(lines[1]).status).toBe("done");
  });

  it("creates parent directories that do not yet exist", () => {
    const nested = path.join(dir, "sub", "deep", "activity.jsonl");

    appendJsonl(nested, { kind: "delegation" });

    expect(fs.existsSync(nested)).toBe(true);
    expect(JSON.parse(fs.readFileSync(nested, "utf8").trim()).kind).toBe("delegation");
  });

  it("preserves a caller-supplied ts instead of stamping a fresh one", () => {
    const ts = "2026-01-15T10:00:00.000Z";

    appendJsonl(file, { ts, kind: "run" });

    const rec = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(rec.ts).toBe(ts);
  });
});

describe("updateFrontmatter (the load-bearing write)", () => {
  let file;
  const original = [
    "---",
    "type: job",
    "role: Test Role",
    "status: lead",
    "tags: [job]",
    "---",
    "",
    "# Test Role - Co",
    "",
    "**Lead with:** something",
    "",
  ].join("\n");

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-")), "job.md");
    fs.writeFileSync(file, original, "utf8");
  });
  afterEach(() => {
    try {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {}
  });

  it("replaces an existing scalar line and leaves the body byte-identical", () => {
    updateFrontmatter(file, { status: "queued" });
    const out = fs.readFileSync(file, "utf8");
    expect(out).toContain("status: queued");
    expect(out).not.toContain("status: lead");
    // body after the closing --- is untouched
    expect(out.split("---")[2]).toBe(original.split("---")[2]);
  });

  it("is a byte-identical round-trip (lead -> queued -> lead)", () => {
    updateFrontmatter(file, { status: "queued" });
    updateFrontmatter(file, { status: "lead" });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("strips a leading BOM and still updates the field (no double frontmatter)", () => {
    fs.writeFileSync(file, "﻿" + original, "utf8"); // BOM-prefixed job file
    updateFrontmatter(file, { status: "submitted" });
    const out = fs.readFileSync(file, "utf8");
    expect(out.charCodeAt(0)).not.toBe(0xfeff); // BOM gone
    expect(out.startsWith("---\n")).toBe(true); // single, valid fence
    expect(out.indexOf("---")).toBe(out.lastIndexOf("---", 5)); // no stray second opening fence
    expect(parseFront(out)?.data?.status).toBe("submitted");
  });

  it("inserts a missing key before the closing fence", () => {
    updateFrontmatter(file, { applied: "2026-06-30" });
    const out = fs.readFileSync(file, "utf8");
    expect(out).toContain("applied: 2026-06-30");
    // inserted inside the frontmatter block, before the body
    expect(out.indexOf("applied:")).toBeLessThan(out.indexOf("# Test Role"));
  });

  it("deletes a key when value is null", () => {
    updateFrontmatter(file, { applied: "2026-06-30" });
    updateFrontmatter(file, { applied: null });
    expect(fs.readFileSync(file, "utf8")).not.toContain("applied:");
  });

  it("ignores non-writable keys", () => {
    updateFrontmatter(file, { role: "HACKED" });
    expect(fs.readFileSync(file, "utf8")).toContain("role: Test Role");
  });

  it("throws on a file with no frontmatter", () => {
    const bad = path.join(path.dirname(file), "bad.md");
    fs.writeFileSync(bad, "no frontmatter here", "utf8");
    expect(() => updateFrontmatter(bad, { status: "queued" })).toThrow();
  });
});

// 63 of the 112 real job files use CRLF line endings. The old implementation
// split on /\r?\n/ and rejoined with "\n", so a single-field status change
// rewrote every line ending in the file - a whole-file git diff, not the
// promised surgical one-line diff / byte-identical body. This locks the fix:
// the dominant EOL is detected from the raw bytes and preserved on write.
describe("updateFrontmatter CRLF preservation", () => {
  let file;
  // A CRLF file: 13 segments -> 12 CRLF pairs, ending with a trailing CRLF.
  const crlfLines = [
    "---",
    "type: job",
    "role: CRLF Role",
    "status: lead",
    "tags: [job]",
    "---",
    "",
    "# CRLF Role - Co",
    "",
    "**Lead with:** something",
    "",
    "## Notes",
    "",
  ];
  const original = crlfLines.join("\r\n");

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jh-crlf-")), "job.md");
    fs.writeFileSync(file, original, "utf8");
  });
  afterEach(() => {
    try {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {}
  });

  it("preserves every CRLF and changes only the targeted field line", () => {
    const before = fs.readFileSync(file, "utf8");
    const crlfBefore = (before.match(/\r\n/g) || []).length;
    expect(crlfBefore).toBeGreaterThanOrEqual(10); // 12, well above the ">= 10" floor

    updateFrontmatter(file, { status: "queued" });

    const after = fs.readFileSync(file, "utf8");
    // Same count of CRLF pairs, and NO bare LF (LF not preceded by CR) crept in.
    expect((after.match(/\r\n/g) || []).length).toBe(crlfBefore);
    expect((after.match(/(?<!\r)\n/g) || []).length).toBe(0);

    // Line-by-line diff: exactly one line differs, and it is the status line.
    const a = before.split("\r\n");
    const b = after.split("\r\n");
    expect(b.length).toBe(a.length);
    const changed = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
    expect(changed).toHaveLength(1);
    expect(a[changed[0]]).toBe("status: lead");
    expect(b[changed[0]]).toBe("status: queued");
  });
});
