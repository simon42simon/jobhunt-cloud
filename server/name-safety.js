// SIM-393 I1 - the ONE shared filename / path-component validation module.
//
// Guardian condition GC-1 (design 2026-07-17-sim393-vault-cloud-dataflow-design.md,
// "Guardian review", condition 1): filename/path-component validation MUST live in a
// SINGLE shared module so the rules cannot drift between the surfaces that use them:
//   - server-side sync ingest (the /api/sync/* routes, I1)
//   - the in-app upload route (I4)
//   - the laptop-side export CLIENT (I5), which treats every cloud-supplied name as
//     UNTRUSTED (legacy rows, migration-era rows, the compromised-cloud case) and
//     must contain each write CLIENT-SIDE - server-side ingest validation does not
//     satisfy that client-side duty.
//
// Everything here is PURE + importable so tests exercise it without a socket, a DB,
// or the filesystem. The functions never read/write anything; `resolveInside`
// resolves + asserts containment against a root path string only (no fs access).
//
// The rule set (guardian condition 1 verbatim): a name is safe iff it is a single
// path COMPONENT - basename equality (`path.basename(name) === name`), with no
// `..` segment, no control chars, no absolute-path forms, no path separators, no
// Windows-reserved device name, non-empty, and within a length cap. These names
// later become LAPTOP filenames via the export snapshot, so Windows-reserved device
// names are rejected even on a POSIX server.

import path from "node:path";

// A conservative cap. 255 is the common single-component filename limit on ext4 /
// NTFS / APFS; a job artifact name never approaches it.
export const NAME_MAX_LEN = 255;

// Windows reserved device names (case-insensitive), with or without an extension:
// `NUL`, `NUL.txt`, `com1.md` etc. all resolve to the device on Windows.
// CONIN$/CONOUT$ (the console input/output pseudo-devices) included per the
// guardian's 2026-07-17 deploy-gate re-check.
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul", "conin$", "conout$",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// Control chars (C0 range U+0000..U+001F plus DEL U+007F). These can truncate
// names, spoof extensions, or inject terminal escapes into logs.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

// The device-name check strips a SINGLE trailing extension, since `NUL.txt` is
// still the NUL device on Windows.
function isWindowsReserved(name) {
  const stem = name.slice(0, name.length - path.extname(name).length).toLowerCase();
  return WINDOWS_RESERVED.has(stem) || WINDOWS_RESERVED.has(name.toLowerCase());
}

// True iff `name` is a single, safe path component. Rejects (guardian condition 1):
//   - non-strings, empty, or over the length cap
//   - `.` / `..` and ANY occurrence of `..` (traversal, belt-and-suspenders)
//   - control chars (C0 / DEL)
//   - path separators of EITHER OS (`/` or `\`) so a POSIX server also refuses the
//     names that would traverse once written on a Windows laptop
//   - Windows drive-absolute forms (`C:\...`, `c:foo`) and leading-slash absolutes
//   - anything whose `path.basename` differs from itself (the load-bearing equality)
//   - Windows-reserved device names
export function isSafeName(name) {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > NAME_MAX_LEN) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("..")) return false;
  if (CONTROL_CHARS_RE.test(name)) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false; // windows drive form (with or without slash)
  // basename equality on BOTH separators: compute against a posix + win32 view so a
  // backslash-bearing name is rejected on a posix host too (already caught above,
  // but this keeps the load-bearing invariant explicit and total).
  if (path.posix.basename(name) !== name) return false;
  if (path.win32.basename(name) !== name) return false;
  // Windows trailing dot/space aliasing (guardian 2026-07-17): win32 silently
  // strips trailing dots and spaces, so "file.txt." / "file.txt " alias
  // "file.txt" once written on the laptop - two distinct cloud names, one
  // laptop file (a clobber primitive). Reject the aliasing forms outright.
  if (/[. ]$/.test(name)) return false;
  if (isWindowsReserved(name)) return false;
  return true;
}

// Throw a 400-coded error when `name` is unsafe (server ingest uses this so a bad
// name is a client error, never a 500). The message never echoes control bytes.
export function assertSafeName(name, label = "name") {
  if (!isSafeName(name)) {
    const e = new Error(`unsafe ${label}`);
    e.httpStatus = 400;
    e.code = "UNSAFE_NAME";
    throw e;
  }
  return name;
}

// Resolve `segments` under `root` and ASSERT the result stays strictly inside it
// (guardian condition 1's `resolveInside`-style containment). Pure string math on
// resolved absolute paths - no filesystem access. Throws when the target is the
// root itself or escapes it. The export client (I5) calls this before EVERY write
// so a poisoned cloud name cannot become an arbitrary-write primitive on the laptop.
export function resolveInside(root, ...segments) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    const e = new Error("path escapes the containment root");
    e.httpStatus = 400;
    e.code = "PATH_ESCAPE";
    throw e;
  }
  return target;
}
