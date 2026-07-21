import { describe, it, expect, vi } from "vitest";
import { SSC_HUB_WINDOW, openSscHub, sscHubUrl } from "../src/lib/sscHub";

// SIM-59 (Phase B half B): the in-app Product Hub is retired; deep links hand
// off to the standalone SSC Product Hub. sscHubUrl is the ONE EntityRef->URL
// mapping, and its scheme must stay in lockstep with the hub's hash router
// (SSC/apps/product-hub src/route.ts, pinned there by its route.test.ts):
//   #/<pageKey> | #/tasks/<id> | #/projects/<id>
//
// SIM-426 (GATE 2 fix): the hub base is no longer hardcoded - it is a resolved
// `hubUrl` param (server-declared via GET /api/config's sscHubUrl, null on
// every hosted instance). These tests exercise a resolved local-dev base
// ("http://localhost:5185") to prove the URL SHAPE is unchanged, plus the
// null/no-target no-op posture that hides the affordance on hosted instances.

const HUB = "http://localhost:5185";

describe("sscHubUrl: the EntityRef -> SSC hub URL mapping", () => {
  it("a task lands on its drawer (#/tasks/<id>)", () => {
    expect(sscHubUrl(HUB, { kind: "task", id: "t-1783255872307" })).toBe(
      "http://localhost:5185/#/tasks/t-1783255872307",
    );
  });

  it("a project lands on the filtered Projects page (#/projects/<id>)", () => {
    expect(sscHubUrl(HUB, { kind: "project", id: "prj-connected-execution" })).toBe(
      "http://localhost:5185/#/projects/prj-connected-execution",
    );
  });

  it("a page key lands on that page (the bell's Review decisions)", () => {
    expect(sscHubUrl(HUB, "decisions")).toBe("http://localhost:5185/#/decisions");
    expect(sscHubUrl(HUB, "tasks")).toBe("http://localhost:5185/#/tasks");
  });

  it("no target lands on the hub root (ProductMoved's CTA)", () => {
    expect(sscHubUrl(HUB)).toBe(`${HUB}/`);
  });

  it("URI-encodes the entity id (the hub's parser decodes it back)", () => {
    expect(sscHubUrl(HUB, { kind: "task", id: "a/b c" })).toBe(
      "http://localhost:5185/#/tasks/a%2Fb%20c",
    );
  });

  it("resolves against whatever base the server declared, not a hardcoded host", () => {
    expect(sscHubUrl("https://hub.example.internal", "decisions")).toBe(
      "https://hub.example.internal/#/decisions",
    );
  });
});

describe("openSscHub: one shared named window, brought forward", () => {
  it("opens via window.open into the ssc-hub named window and focuses it", () => {
    const focus = vi.fn();
    const open = vi.fn(() => ({ focus }));
    vi.stubGlobal("window", { open });
    try {
      openSscHub(HUB, { kind: "task", id: "t-1" });
      expect(open).toHaveBeenCalledWith("http://localhost:5185/#/tasks/t-1", SSC_HUB_WINDOW);
      expect(focus).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("survives a popup-blocked open (window.open returns null)", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    try {
      expect(() => openSscHub(HUB, "decisions")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the named window is stable (tab reuse contract)", () => {
    expect(SSC_HUB_WINDOW).toBe("ssc-hub");
  });

  // SIM-426: no hub configured (every hosted instance) - a hard no-op, never a
  // guessed/fallback URL. This is what makes the hosted "no localhost link"
  // acceptance bar hold even if a caller forgets to hide the affordance.
  it("null/undefined hubUrl (hosted, no hub configured) is a hard no-op", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    try {
      openSscHub(null, "decisions");
      openSscHub(undefined, { kind: "task", id: "t-1" });
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
