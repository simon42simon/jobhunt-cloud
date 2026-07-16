import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// SIM-68 (2026-07-14): smoke test for the start-app channel selector, closing the M2
// lesson from the v0.38.0 board-outage postmortem. That outage was a PARSE failure in an
// earlier version of the selector (a literal "(...)" in a `set` value inside a nested
// if-block): cmd.exe aborted the block before CHANNEL was ever bound, and no test caught
// it - the app fell over on a promote. v0.38.1 rewrote it as a flat goto form; SIM-68
// extracts that form into ops\scripts\choose-channel.cmd (which start-app.cmd now `call`s,
// so the LIVE serving path runs this exact code) and pins its behavior here.
//
// A pure static/lint check could not have caught the v0.38.0 bug - it was a RUNTIME parse
// failure - so these tests EXECUTE the real .cmd under cmd.exe across all 5 outcomes and
// assert the resolved CHANNEL + JOBHUNT_SERVE_BUILT. Fixtures are throwaway dirs in the OS
// temp dir; the selector is pure selection (it never launches, binds a port, or touches a
// process), so this can never disturb the live app on :5180/:8787.

const SELECTOR = path.resolve(__dirname, "..", "ops", "scripts", "choose-channel.cmd");

// cmd-only launcher; skip cleanly off Windows rather than fail (the .cmd is inert there).
const onWindows = process.platform === "win32";

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "choose-channel-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Build a fixture worktree. Each marker the selector probes is created only when asked, so
// a case can omit exactly the file whose absence it means to test.
function makeWorktree(name, { pkg = false, vite = false, dist = false, serverHasBuilt = null } = {}) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  if (pkg) writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
  if (vite) {
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "vite.cmd"), "@echo off\r\n");
  }
  if (dist) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html>");
  }
  if (serverHasBuilt !== null) {
    mkdirSync(path.join(dir, "server"), { recursive: true });
    // The selector greps server/index.js for the literal "JOBHUNT_SERVE_BUILT".
    writeFileSync(
      path.join(dir, "server", "index.js"),
      serverHasBuilt ? "if (process.env.JOBHUNT_SERVE_BUILT) serveBuilt();\n" : "app.listen(8787);\n"
    );
  }
  return dir;
}

// Run the real selector under cmd.exe with the fixture dirs injected via env, exactly as
// start-app.cmd feeds it. APP_LOG is stripped so the selector's fallback branches never
// write to a real log path (they are `if defined APP_LOG`-guarded). Returns the parsed
// CHANNEL kind + JOBHUNT_SERVE_BUILT.
function runSelector(mainDir, stableDir) {
  const env = { ...process.env, MAIN_DIR: mainDir, STABLE_DIR: stableDir, SSC_ROOT: tmpRoot };
  delete env.APP_LOG;
  const res = spawnSync("cmd", ["/c", SELECTOR], { env, encoding: "utf8" });
  expect(res.status, `selector exited ${res.status}; stderr: ${res.stderr}`).toBe(0);
  const out = res.stdout;
  const channelLine = out.split(/\r?\n/).find((l) => l.startsWith("CHANNEL="));
  const builtLine = out.split(/\r?\n/).find((l) => l.startsWith("JOBHUNT_SERVE_BUILT="));
  // Both lines MUST be present: a parse failure of the v0.38.0 class would leave CHANNEL
  // unbound and skip the emit, so their mere presence is itself the regression guard.
  expect(channelLine, `no CHANNEL= line in output:\n${out}`).toBeTruthy();
  expect(builtLine, `no JOBHUNT_SERVE_BUILT= line in output:\n${out}`).toBeTruthy();
  const channel = channelLine.slice("CHANNEL=".length).trim();
  return {
    channel,
    kind: channel.split(" ")[0], // stable-built | stable-dev | dev-fallback
    serveBuilt: builtLine.slice("JOBHUNT_SERVE_BUILT=".length).trim(),
  };
}

describe.runIf(onWindows)("start-app channel selector (choose-channel.cmd) - SIM-68", () => {
  it("case 1 - stable-built: stable has vite + dist + a built-serve server -> stable-built, JOBHUNT_SERVE_BUILT=1", () => {
    const main = makeWorktree("main", { pkg: true });
    const stable = makeWorktree("stable", { pkg: true, vite: true, dist: true, serverHasBuilt: true });

    const { kind, serveBuilt } = runSelector(main, stable);

    expect(kind).toBe("stable-built");
    expect(serveBuilt).toBe("1");
  });

  it("case 2 - stable-dev (nodist): stable has vite but NO dist\\index.html -> stable-dev, no built flag", () => {
    const main = makeWorktree("main", { pkg: true });
    const stable = makeWorktree("stable", { pkg: true, vite: true, dist: false, serverHasBuilt: true });

    const { kind, serveBuilt } = runSelector(main, stable);

    expect(kind).toBe("stable-dev");
    expect(serveBuilt).toBe(""); // never serve a nonexistent build
  });

  it("case 3 - stable-dev (oldserver): dist present but server/index.js lacks the built-serve string -> stable-dev, no built flag", () => {
    const main = makeWorktree("main", { pkg: true });
    const stable = makeWorktree("stable", { pkg: true, vite: true, dist: true, serverHasBuilt: false });

    const { kind, serveBuilt } = runSelector(main, stable);

    expect(kind).toBe("stable-dev");
    expect(serveBuilt).toBe("");
  });

  it("case 4 - dev-fallback (cc_broken): stable has package.json but vite is missing -> dev-fallback, no built flag", () => {
    const main = makeWorktree("main", { pkg: true });
    const stable = makeWorktree("stable", { pkg: true, vite: false });

    const { kind, serveBuilt } = runSelector(main, stable);

    expect(kind).toBe("dev-fallback");
    expect(serveBuilt).toBe("");
  });

  it("case 5 - dev-fallback: no stable worktree (no package.json) -> dev-fallback, no built flag", () => {
    const main = makeWorktree("main", { pkg: true });
    const stable = makeWorktree("stable", {}); // empty dir, no package.json

    const { kind, serveBuilt } = runSelector(main, stable);

    expect(kind).toBe("dev-fallback");
    expect(serveBuilt).toBe("");
  });

  it("dev-fallback names the MAIN dir, stable channels name the STABLE dir (data stays canonical in main)", () => {
    const main = makeWorktree("main", { pkg: true });
    const builtStable = makeWorktree("stable", { pkg: true, vite: true, dist: true, serverHasBuilt: true });

    expect(runSelector(main, builtStable).channel).toContain(builtStable);
    expect(runSelector(main, makeWorktree("bare", {})).channel).toContain(main);
  });
});
