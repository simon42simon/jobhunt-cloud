import { describe, it, expect, vi } from "vitest";
import { SSC_HUB_URL, SSC_HUB_WINDOW, openSscHub, sscHubUrl } from "../src/lib/sscHub";

// SIM-59 (Phase B half B): the in-app Product Hub is retired; deep links hand
// off to the standalone SSC Product Hub. sscHubUrl is the ONE EntityRef->URL
// mapping, and its scheme must stay in lockstep with the hub's hash router
// (SSC/apps/product-hub src/route.ts, pinned there by its route.test.ts):
//   #/<pageKey> | #/tasks/<id> | #/projects/<id>

describe("sscHubUrl: the EntityRef -> SSC hub URL mapping", () => {
  it("a task lands on its drawer (#/tasks/<id>)", () => {
    expect(sscHubUrl({ kind: "task", id: "t-1783255872307" })).toBe(
      "http://localhost:5185/#/tasks/t-1783255872307",
    );
  });

  it("a project lands on the filtered Projects page (#/projects/<id>)", () => {
    expect(sscHubUrl({ kind: "project", id: "prj-connected-execution" })).toBe(
      "http://localhost:5185/#/projects/prj-connected-execution",
    );
  });

  it("a page key lands on that page (the bell's Review decisions)", () => {
    expect(sscHubUrl("decisions")).toBe("http://localhost:5185/#/decisions");
    expect(sscHubUrl("tasks")).toBe("http://localhost:5185/#/tasks");
  });

  it("no target lands on the hub root (ProductMoved's CTA)", () => {
    expect(sscHubUrl()).toBe(`${SSC_HUB_URL}/`);
  });

  it("URI-encodes the entity id (the hub's parser decodes it back)", () => {
    expect(sscHubUrl({ kind: "task", id: "a/b c" })).toBe(
      "http://localhost:5185/#/tasks/a%2Fb%20c",
    );
  });
});

describe("openSscHub: one shared named window, brought forward", () => {
  it("opens via window.open into the ssc-hub named window and focuses it", () => {
    const focus = vi.fn();
    const open = vi.fn(() => ({ focus }));
    vi.stubGlobal("window", { open });
    try {
      openSscHub({ kind: "task", id: "t-1" });
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
      expect(() => openSscHub("decisions")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the named window is stable (tab reuse contract)", () => {
    expect(SSC_HUB_WINDOW).toBe("ssc-hub");
  });
});
