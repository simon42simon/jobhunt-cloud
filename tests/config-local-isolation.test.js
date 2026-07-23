// SIM-605 - a bare `npm test` on the laptop was RED (~70 failures) because the
// gitignored config.local.json (SIM-541 runner-provisioning residue) points
// dataDir at the live vault, whose real auth.json silently enables auth
// inside any test that forgot to set JOBHUNT_DATA_DIR/JOBHUNT_DOCS_DIR -
// proven environmental (the same files passed once DATA_DIR was isolated).
// Fix: loadConfig() never even considers config.local.json under
// JOBHUNT_TEST=1, regardless of whether the file exists on disk.
//
// Exercises the REAL exported loadConfig() with a mocked fs - never writes an
// actual config.local.json into the repo root, which would race every other
// test file importing server/index.js in parallel.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_PATH = path.join(ROOT, "config.local.json");
const BASE_PATH = path.join(ROOT, "config.json");

const FAKE_LOCAL_CONFIG = JSON.stringify({ jobsDir: "C:\\Users\\sihye\\ssc-brain\\data\\jobhunt\\Jobs", dataDir: "C:\\Users\\sihye\\ssc-brain\\data\\jobhunt" });

let loadConfig;
let realConfigText;

beforeAll(async () => {
  process.env.JOBHUNT_TEST = "1";
  ({ loadConfig } = await import("../server/index.js"));
  realConfigText = fs.readFileSync(BASE_PATH, "utf8"); // the committed placeholder, for comparison
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Wraps existsSync/readFileSync so ONLY the config.local.json path is faked -
// every other call (the rest of the app's own boot-time reads) passes through
// to the real filesystem untouched.
function mockLocalConfigPresent() {
  const realExists = fs.existsSync.bind(fs);
  const realRead = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation((p) => (p === LOCAL_PATH ? true : realExists(p)));
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => (p === LOCAL_PATH ? FAKE_LOCAL_CONFIG : realRead(p, enc)));
}

describe("SIM-605 loadConfig test isolation", () => {
  it("under JOBHUNT_TEST=1, config.local.json is NEVER read even when it exists on disk", () => {
    mockLocalConfigPresent();
    process.env.JOBHUNT_TEST = "1";
    const cfg = loadConfig();
    expect(cfg.jobsDir).not.toBe("C:\\Users\\sihye\\ssc-brain\\data\\jobhunt\\Jobs");
    expect(cfg).toEqual(JSON.parse(realConfigText)); // reads config.json, not the mocked local file
  });

  it("outside test mode, config.local.json still wins when present (existing behavior preserved)", () => {
    mockLocalConfigPresent();
    const prior = process.env.JOBHUNT_TEST;
    delete process.env.JOBHUNT_TEST;
    try {
      const cfg = loadConfig();
      expect(cfg.jobsDir).toBe("C:\\Users\\sihye\\ssc-brain\\data\\jobhunt\\Jobs");
    } finally {
      process.env.JOBHUNT_TEST = prior;
    }
  });

  it("under JOBHUNT_TEST=1 with no config.local.json at all, behavior is unchanged (config.json)", () => {
    process.env.JOBHUNT_TEST = "1";
    const cfg = loadConfig();
    expect(cfg).toEqual(JSON.parse(realConfigText));
  });
});
