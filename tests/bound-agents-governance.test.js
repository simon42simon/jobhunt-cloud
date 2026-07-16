import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Bound-agent guardrail governance (ADR-015 hardening; security Finding 2a)
//
// The routine runner runs each PRODUCT routine AS its owning Career Delivery
// agent via `claude --agent <id>` (server/index.js ROUTINES). That moved
// LOAD-BEARING behavioral rules (never auto-submit, generate-from-facts,
// local-only, personal-Chrome-only / never the maplearmor work browser, data
// sovereignty, no em dashes ...) onto the runtime path from files this repo
// does NOT track - ~/.claude/agents/<id>.md - which are editable outside any
// repo diff or release gate. The runtime already fails CLOSED if an agent id is
// MISSING (`claude --agent <unknown>` exits non-zero). This suite guards the
// other half: DRIFT of an existing bound file's load-bearing CONTENT. It reads
// each bound agent file from ~/.claude/agents (resolved via os.homedir()) and
// FAILS if any required guardrail phrase has been softened away.
//
// Source of truth for the required phrases: tests/fixtures/bound-agents-guardrails.json
// Source of truth for WHICH agents are bound: server/index.js ROUTINES (the
//   `agent` field on scope:job/global product routines). The final describe
//   cross-checks the manifest covers EXACTLY that set.
// ---------------------------------------------------------------------------

const manifestPath = fileURLToPath(
  new URL("./fixtures/bound-agents-guardrails.json", import.meta.url)
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const boundAgents = manifest.boundAgents || {};
const boundAgentIds = Object.keys(boundAgents);

// Resolve a bound agent's global definition file. NB: intentionally NOT a repo
// path - these files live under the user's home, which is the whole point of
// the guard (they are outside the repo's diff/gate).
function agentFilePath(id) {
  return path.join(os.homedir(), ".claude", "agents", `${id}.md`);
}

// Read the file with a CLEAR failure (not a crash) when it is absent.
function readAgentFileOrFail(id) {
  const p = agentFilePath(id);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Bound agent "${id}" is missing its definition file at ${p}. ` +
        `The product routine that runs AS this agent would fail closed at runtime, ` +
        `and its load-bearing guardrails cannot be verified. Restore the file.`
    );
  }
  return fs.readFileSync(p, "utf8");
}

// Literal em dash (U+2014). The org rule is "no em dashes"; every bound file's
// prose is behavioral instruction fed to the model, so a stray em dash both
// breaks the rule and can slip into the user's employer-facing output.
const EM_DASH = "—";

// The agent definition files live OUTSIDE the repo (~/.claude/agents), on the
// owner's machine only - a CI runner can never have them, so the three
// file-READING assertions below are skipped when CI is set (GitHub Actions
// exports CI=true) and run with full force on every local `npm run check` and
// the pre-push hook - which is where this gate is authoritative, since that is
// the machine the files (and the drift risk) actually live on. Manifest
// hygiene and the ROUTINES cross-check still run everywhere, including CI.
// (Main went red on 2026-07-04 exactly because these read /home/runner/.)
const itOnOwnerMachine = process.env.CI ? it.skip : it;

describe("bound-agent guardrail governance", () => {
  it("has a non-empty bound-agent manifest", () => {
    expect(boundAgentIds.length).toBeGreaterThan(0);
  });

  itOnOwnerMachine("every bound agent file exists at ~/.claude/agents/<id>.md", () => {
    for (const id of boundAgentIds) {
      const p = agentFilePath(id);
      expect(fs.existsSync(p), `bound agent file missing: ${p}`).toBe(true);
    }
  });

  // The core drift guard: each required guardrail phrase must still be present.
  describe.each(boundAgentIds)("bound agent: %s", (id) => {
    const entry = boundAgents[id];
    const guardrails = Array.isArray(entry.guardrails) ? entry.guardrails : [];

    it("declares at least one guardrail in the manifest", () => {
      expect(guardrails.length).toBeGreaterThan(0);
    });

    it("compiles every guardrail pattern (manifest hygiene)", () => {
      for (const g of guardrails) {
        expect(
          () => new RegExp(g.pattern, g.flags || ""),
          `guardrail "${g.id}" for "${id}" has an invalid regex: ${g.pattern}`
        ).not.toThrow();
      }
    });

    itOnOwnerMachine.each(guardrails.map((g) => [g.id, g]))(
      "still contains load-bearing guardrail: %s",
      (guardId, g) => {
        const text = readAgentFileOrFail(id);
        const re = new RegExp(g.pattern, g.flags || "");
        expect(
          re.test(text),
          `Guardrail "${guardId}" is MISSING from ~/.claude/agents/${id}.md.\n` +
            `  Expected (regex ${g.flags ? `/${g.pattern}/${g.flags}` : `/${g.pattern}/`}): ${g.description}\n` +
            `  A bound agent's load-bearing rule was softened away. Either restore the ` +
            `rule in the agent file, or - if it was legitimately reworded - update the ` +
            `pattern in tests/fixtures/bound-agents-guardrails.json in the SAME change.`
        ).toBe(true);
      }
    );

    itOnOwnerMachine("contains no literal em dash (org no-em-dash rule)", () => {
      const text = readAgentFileOrFail(id);
      expect(
        text.includes(EM_DASH),
        `~/.claude/agents/${id}.md contains a literal em dash (U+2014). ` +
          `Bound agent prose must use hyphen / comma / colon.`
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-check: the manifest's bound-agent set must EXACTLY equal the set of
// agents bound by the runtime routine table (server/index.js ROUTINES). This
// keeps the manifest honest against what actually runs - a newly-bound product
// routine without a manifest entry (or an orphan manifest entry) fails here.
// JOBHUNT_TEST=1 makes server/index.js skip the port bind + file watcher on
// import (see the guard at the bottom of server/index.js).
// ---------------------------------------------------------------------------
describe("manifest covers exactly the runtime-bound agents (server ROUTINES)", () => {
  let ROUTINES;

  beforeAll(async () => {
    process.env.JOBHUNT_TEST = "1";
    ({ ROUTINES } = await import("../server/index.js"));
  });

  // "source" included so a routine added under a new scope cannot carry an
  // unmanifested agent binding past this guard (2026-07-04 governance audit).
  const PRODUCT_SCOPES = new Set(["job", "global", "source"]);

  it("bound-agent id set == set of `agent` on product routines", () => {
    const runtimeBound = new Set();
    for (const def of Object.values(ROUTINES)) {
      if (PRODUCT_SCOPES.has(def.scope) && def.agent) runtimeBound.add(def.agent);
    }
    expect(runtimeBound.size, "sanity: server has bound product routines").toBeGreaterThan(0);

    const manifestSet = new Set(boundAgentIds);
    // Every runtime-bound agent is covered by the manifest.
    for (const a of runtimeBound) {
      expect(
        manifestSet.has(a),
        `runtime binds routine agent "${a}" but the manifest has no guardrail entry for it ` +
          `(add "${a}" to tests/fixtures/bound-agents-guardrails.json)`
      ).toBe(true);
    }
    // No orphan manifest entries that nothing runs as.
    for (const a of manifestSet) {
      expect(
        runtimeBound.has(a),
        `manifest lists bound agent "${a}" but no product routine runs as it ` +
          `(remove the stale entry or bind a routine to it)`
      ).toBe(true);
    }
  });

  it("each product routine is listed under its owning agent's `routines`", () => {
    for (const [routineId, def] of Object.entries(ROUTINES)) {
      if (!PRODUCT_SCOPES.has(def.scope) || !def.agent) continue;
      const entry = boundAgents[def.agent];
      expect(entry, `manifest missing entry for bound agent "${def.agent}"`).toBeTruthy();
      expect(
        (entry.routines || []).includes(routineId),
        `manifest entry for "${def.agent}" should list routine "${routineId}" in its \`routines\``
      ).toBe(true);
    }
  });
});
