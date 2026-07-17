// Guardian deploy-gate re-check (2026-07-17): REQUIRE_EMBEDDED_PG=1 must turn an
// embedded-Postgres provisioning failure into a HARD suite failure instead of the
// silent describe.skip that let every PG leg go vacuously green while a broken
// migration shipped. pgUnavailable is the single decision point (both startCluster
// and provisionPgBackend route their failure paths through it), so its unit test
// covers the whole flag.

import { describe, it, expect } from "vitest";
import { pgUnavailable } from "./helpers/embedded-pg.mjs";

describe("REQUIRE_EMBEDDED_PG gate", () => {
  it("unset: a provisioning failure stays a clean skip ({ available:false, reason })", () => {
    expect(pgUnavailable("boom", {})).toEqual({ available: false, reason: "boom" });
  });

  it("set to anything but '1': still a clean skip", () => {
    expect(pgUnavailable("boom", { REQUIRE_EMBEDDED_PG: "0" })).toEqual({ available: false, reason: "boom" });
    expect(pgUnavailable("boom", { REQUIRE_EMBEDDED_PG: "" })).toEqual({ available: false, reason: "boom" });
  });

  it("REQUIRE_EMBEDDED_PG=1: a provisioning failure THROWS, carrying the reason", () => {
    expect(() => pgUnavailable("postgres exited early", { REQUIRE_EMBEDDED_PG: "1" })).toThrow(
      /REQUIRE_EMBEDDED_PG=1.*postgres exited early/,
    );
  });
});
