// RC-3 / SIM-87 I8 - Dockerfile + .dockerignore validated BY CONSTRUCTION (no Docker
// on this machine). Locks the design's runtime invariants: non-root, NO Python in
// the final image, a healthcheck, and the node-pg-migrate release step; and that the
// .dockerignore keeps local secrets / live data out of the build context.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");

// Split the Dockerfile into stages by `FROM ... AS <name>`.
function stage(name) {
  const stages = dockerfile.split(/^FROM .*$/m);
  const names = [...dockerfile.matchAll(/^FROM .* AS (\S+)/gm)].map((m) => m[1]);
  const idx = names.indexOf(name);
  return idx >= 0 ? stages[idx + 1] : "";
}

describe("Dockerfile runtime invariants", () => {
  it("is multi-stage (builder + proddeps + runtime)", () => {
    for (const s of ["builder", "proddeps", "runtime"]) {
      expect(dockerfile).toContain(` AS ${s}`);
    }
  });

  it("the FINAL runtime stage runs as a NON-ROOT user", () => {
    const runtime = stage("runtime");
    expect(/useradd/.test(runtime)).toBe(true);
    expect(/^USER app$/m.test(runtime)).toBe(true);
    // USER app must come before the CMD (no root at runtime)
    expect(runtime.indexOf("USER app")).toBeLessThan(runtime.indexOf("CMD"));
  });

  it("the FINAL runtime stage installs NO Python (finds come from discovery_finds, not discovery.py)", () => {
    const runtime = stage("runtime");
    expect(/apt-get install[^\n]*python/i.test(runtime)).toBe(false);
    expect(/python3/.test(runtime)).toBe(false);
  });

  it("declares a HEALTHCHECK hitting /healthz", () => {
    expect(/HEALTHCHECK/.test(dockerfile)).toBe(true);
    expect(dockerfile).toContain("/healthz");
  });

  it("runs the node-pg-migrate release step before the server (start:prod)", () => {
    expect(dockerfile).toContain("start:prod");
  });

  it("ships the PLACEHOLDER config, never the real committed config.json", () => {
    expect(dockerfile).toContain("config.example.json ./config.json");
  });
});

describe(".dockerignore keeps secrets + live data out of the image", () => {
  for (const p of [".env.local", "config.local.json", "demo/forbidden.local.json", "docs/tasks.yaml", "cookies.txt", ".git", "tests"]) {
    it(`excludes ${p}`, () => {
      expect(dockerignore.split(/\r?\n/).map((l) => l.trim())).toContain(p);
    });
  }
});

describe("start:prod script wires migrate before boot", () => {
  it("package.json start:prod runs migrate then the server", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["start:prod"]).toContain("ops/migrate.mjs");
    expect(pkg.scripts["start:prod"]).toContain("server/index.js");
    // node-pg-migrate must be a RUNTIME dep (the container migrate step needs it)
    expect(pkg.dependencies["node-pg-migrate"]).toBeTruthy();
    expect(pkg.devDependencies["node-pg-migrate"]).toBeUndefined();
  });
});
