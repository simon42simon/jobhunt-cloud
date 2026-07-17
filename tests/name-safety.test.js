// SIM-393 I1 - the shared filename/path validator (guardian GC-1). These are the
// hostile-name fixtures the guardian's condition-1 names verbatim: `..\..\`,
// absolute-path forms, Windows-reserved device names, control chars, separators,
// basename inequality. The SAME module gates the sync ingest (I1), the upload route
// (I4), and the export client's client-side containment (I5), so this suite is the
// single guard against the rules drifting apart.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { isSafeName, assertSafeName, resolveInside, NAME_MAX_LEN } from "../server/name-safety.js";

const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92); // a literal backslash, kept out of string escapes

describe("isSafeName - accepts legitimate single-component names", () => {
  const good = [
    "CV - Data Analyst.pdf",
    "Cover Letter - Acme.docx",
    "gaps.md",
    "job-description.md",
    "STAR prep.md",
    "application-content.json",
    "résumé (2026-07-17).pdf", // unicode + parens + dated-copy shape
    "a.txt",
  ];
  for (const name of good) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(isSafeName(name)).toBe(true);
      expect(() => assertSafeName(name)).not.toThrow();
    });
  }
});

describe("isSafeName - rejects the hostile-name fixtures (guardian condition 1)", () => {
  const hostile = [
    ["dot-dot traversal (posix)", "../secrets"],
    ["dot-dot traversal (windows)", ".." + BS + ".." + BS + "secrets"],
    ["bare dot-dot", ".."],
    ["bare dot", "."],
    ["embedded dot-dot", "a..b"],
    ["forward-slash separator", "sub/dir/file.md"],
    ["backslash separator", "sub" + BS + "file.md"],
    ["absolute posix path", "/etc/passwd"],
    ["windows drive-absolute", "C:" + BS + "Windows" + BS + "system32"],
    ["windows drive-relative", "c:evil.txt"],
    ["control char (NUL)", "cv" + NUL + ".pdf"],
    ["reserved device CON", "CON"],
    ["reserved device NUL with ext", "NUL.txt"],
    ["reserved device com1", "com1.md"],
    ["reserved device lpt9", "LPT9.pdf"],
    ["empty string", ""],
    ["over the length cap", "x".repeat(NAME_MAX_LEN + 1)],
    ["non-string", 12345],
    ["null", null],
  ];
  for (const [label, name] of hostile) {
    it(`rejects ${label}`, () => {
      expect(isSafeName(name)).toBe(false);
      expect(() => assertSafeName(name)).toThrow(/unsafe/);
    });
  }

  it("assertSafeName throws an httpStatus-400 coded error", () => {
    try {
      assertSafeName("../x");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.httpStatus).toBe(400);
      expect(e.code).toBe("UNSAFE_NAME");
    }
  });

  it("every hostile name also fails basename equality on at least one platform", () => {
    // The load-bearing invariant, cross-checked independently of isSafeName's other
    // rules: a name that traverses is never equal to its own basename.
    for (const bad of ["../x", "a/b", "a" + BS + "b", "/abs", "C:" + BS + "x"]) {
      const equalPosix = path.posix.basename(bad) === bad;
      const equalWin = path.win32.basename(bad) === bad;
      expect(equalPosix && equalWin).toBe(false);
    }
  });
});

describe("resolveInside - containment (guardian condition 1 write-side)", () => {
  const root = path.resolve("/srv/snapshot");

  it("resolves a safe single name inside the root", () => {
    const p = resolveInside(root, "CV - Analyst.pdf");
    expect(p).toBe(path.join(root, "CV - Analyst.pdf"));
  });

  it("resolves a safe nested pair inside the root", () => {
    const p = resolveInside(root, "Data Analyst - Acme Co", "CV.pdf");
    expect(p).toBe(path.join(root, "Data Analyst - Acme Co", "CV.pdf"));
  });

  it("REFUSES a traversal that would escape the root", () => {
    expect(() => resolveInside(root, "..", "..", "etc", "passwd")).toThrow(/escapes/);
    try {
      resolveInside(root, "../../etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.httpStatus).toBe(400);
      expect(e.code).toBe("PATH_ESCAPE");
    }
  });

  it("REFUSES an absolute segment that would jump out of the root", () => {
    // path.resolve treats an absolute segment as a reset, so containment MUST catch it.
    expect(() => resolveInside(root, path.resolve("/etc/passwd"))).toThrow(/escapes/);
  });

  it("REFUSES resolving to the root itself (no write onto the root dir)", () => {
    expect(() => resolveInside(root, ".")).toThrow(/escapes/);
  });
});
