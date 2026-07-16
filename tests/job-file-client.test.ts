import { describe, it, expect } from "vitest";
import { isServerDesktopClient, jobFileUrl } from "../src/components/JobDetail";

// Client half of the remote-honest Files buttons (t-1783201094679). The drawer
// picks per client: on the server's own desktop (page loaded over loopback) a
// tap keeps shell-opening via POST /api/open; anywhere else (phone over the
// tailnet) it links to the guarded reader so the bytes land on THIS device.
// Pure predicates, imported straight from the component (the charts-a11y
// pattern) - no DOM needed.

describe("isServerDesktopClient", () => {
  it("treats loopback hostnames as the server's own desktop", () => {
    expect(isServerDesktopClient("localhost")).toBe(true);
    expect(isServerDesktopClient("127.0.0.1")).toBe(true);
    expect(isServerDesktopClient("::1")).toBe(true);
    expect(isServerDesktopClient("[::1]")).toBe(true);
    expect(isServerDesktopClient("LOCALHOST")).toBe(true); // hostnames are case-insensitive
  });

  it("treats any non-loopback host as remote (tailnet, LAN, anything)", () => {
    expect(isServerDesktopClient("galena.tail30b7b8.ts.net")).toBe(false);
    expect(isServerDesktopClient("192.168.0.12")).toBe(false);
    expect(isServerDesktopClient("")).toBe(false);
  });
});

describe("jobFileUrl", () => {
  it("URL-encodes both the job id and the file name", () => {
    expect(jobFileUrl("Alpha Role - Alpha Co", "Simon Kim - CV - Alpha Role.docx")).toBe(
      "/api/jobs/Alpha%20Role%20-%20Alpha%20Co/files/Simon%20Kim%20-%20CV%20-%20Alpha%20Role.docx"
    );
  });

  it("a traversal-shaped name cannot produce a path separator in the URL", () => {
    const url = jobFileUrl("Alpha Role - Alpha Co", "../outside.txt");
    expect(url).toContain("..%2Foutside.txt"); // "/" is encoded - the server sees ONE segment
    expect(url.split("/files/")[1]).not.toContain("/");
  });
});
