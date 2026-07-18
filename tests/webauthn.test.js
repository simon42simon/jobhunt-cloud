// SIM-394 - pure-helper coverage for the WebAuthn second factor
// (server/webauthn.js): the strict flag parse (default OFF, fail-loud
// misconfigs), the MFA pending-token key separation (a pending token must
// NEVER pass the session gate), the single-use TTL challenge store, and the
// >=2-credential enforcement semantics (the anti-lockout core).
//
// RED-CHECKED alongside tests/webauthn-endpoints.test.js: with the SIM-394
// code absent the import below throws (module not found) and every assertion
// here fails, proving the feature code - not the fixtures - satisfies the suite.

import { describe, it, expect } from "vitest";
import {
  resolveWebauthn,
  deriveMfaSecret,
  signMfaToken,
  verifyMfaToken,
  createChallengeStore,
  enforcementState,
  sanitizeLabel,
  toCredentialMeta,
  challengeOfResponse,
  createSecondFactorGate,
  MIN_CREDENTIALS_FOR_ENFORCEMENT,
  CHALLENGE_TTL_MS,
  MFA_TTL_MS,
} from "../server/webauthn.js";
import { verifySession, signSession, SESSION_TTL_MS } from "../server/auth.js";

const AUTH_ON = { enabled: true, hash: "$argon2id$fake", secret: "test-secret" };
const RP_ENV = {
  JOBHUNT_WEBAUTHN: "on",
  JOBHUNT_WEBAUTHN_RPID: "jobhunt.example.test",
  JOBHUNT_WEBAUTHN_ORIGIN: "https://jobhunt.example.test",
};

// ---------------------------------------------------------------------------
describe("resolveWebauthn (strict flag parse, fail-loud misconfigs)", () => {
  it("is OFF by default and on every off-spelling (the byte-identical guarantee's root)", () => {
    expect(resolveWebauthn({ env: {}, auth: AUTH_ON }).enabled).toBe(false);
    for (const v of ["off", "OFF", "0", "false", "", "  "]) {
      expect(resolveWebauthn({ env: { JOBHUNT_WEBAUTHN: v }, auth: AUTH_ON }).enabled).toBe(false);
    }
  });

  it("turns ON with rpID/origin from env - never hardcoded", () => {
    const w = resolveWebauthn({ env: RP_ENV, auth: AUTH_ON });
    expect(w.enabled).toBe(true);
    expect(w.rpID).toBe("jobhunt.example.test");
    expect(w.origin).toBe("https://jobhunt.example.test");
    expect(w.challengeTtlMs).toBe(CHALLENGE_TTL_MS);
  });

  it("throws on an unknown flag value (a typo can never silently change posture)", () => {
    expect(() => resolveWebauthn({ env: { JOBHUNT_WEBAUTHN: "enabled" }, auth: AUTH_ON })).toThrow(
      /must be "on" or "off"/,
    );
  });

  it("throws on=on without auth (a second factor needs a first)", () => {
    expect(() => resolveWebauthn({ env: RP_ENV, auth: { enabled: false } })).toThrow(/requires auth/);
    expect(() => resolveWebauthn({ env: RP_ENV, auth: null })).toThrow(/requires auth/);
  });

  it("throws on=on without rpID or origin", () => {
    expect(() =>
      resolveWebauthn({ env: { JOBHUNT_WEBAUTHN: "on", JOBHUNT_WEBAUTHN_ORIGIN: "https://x" }, auth: AUTH_ON }),
    ).toThrow(/RPID/);
    expect(() =>
      resolveWebauthn({ env: { JOBHUNT_WEBAUTHN: "on", JOBHUNT_WEBAUTHN_RPID: "x" }, auth: AUTH_ON }),
    ).toThrow(/ORIGIN/);
  });

  it("challenge TTL is env-tunable", () => {
    const w = resolveWebauthn({ env: { ...RP_ENV, JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS: "5000" }, auth: AUTH_ON });
    expect(w.challengeTtlMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
describe("MFA pending token (key separation from the session)", () => {
  const SECRET = "session-signing-secret";

  it("round-trips with its own derived key and rejects expiry/tampering", () => {
    const tok = signMfaToken(SECRET, { exp: Date.now() + MFA_TTL_MS });
    expect(verifyMfaToken(SECRET, tok)).toBe(true);
    expect(verifyMfaToken(SECRET, tok + "x")).toBe(false);
    expect(verifyMfaToken(SECRET, signMfaToken(SECRET, { exp: Date.now() - 1 }))).toBe(false);
  });

  it("a PENDING token can never pass the SESSION verifier (the auth-gate separation)", () => {
    const pending = signMfaToken(SECRET, { exp: Date.now() + MFA_TTL_MS });
    expect(verifySession(SECRET, pending)).toBe(false); // would otherwise skip the second factor entirely
  });

  it("a SESSION token can never pass the PENDING verifier (no lane crossing either way)", () => {
    const session = signSession(SECRET, { exp: Date.now() + SESSION_TTL_MS });
    expect(verifyMfaToken(SECRET, session)).toBe(false);
  });

  it("the derived key is stable and distinct from the input secret", () => {
    expect(deriveMfaSecret(SECRET)).toBe(deriveMfaSecret(SECRET));
    expect(deriveMfaSecret(SECRET)).not.toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
describe("challenge store (server-held, single-use, TTL, bounded)", () => {
  function harness(ttlMs = 1000, max = 100) {
    let t = 1_000_000;
    const store = createChallengeStore({ ttlMs, now: () => t, max });
    return { store, tick: (ms) => (t += ms) };
  }

  it("take() succeeds exactly once (replay of the same challenge fails)", () => {
    const { store } = harness();
    store.remember("ch-1", "authentication");
    expect(store.take("ch-1", "authentication")).toBe(true);
    expect(store.take("ch-1", "authentication")).toBe(false); // single-use
  });

  it("an expired challenge fails and unknown challenges fail", () => {
    const { store, tick } = harness(1000);
    store.remember("ch-2", "authentication");
    tick(1001);
    expect(store.take("ch-2", "authentication")).toBe(false);
    expect(store.take("never-issued", "authentication")).toBe(false);
  });

  it("a registration challenge cannot be redeemed on the authentication lane", () => {
    const { store } = harness();
    store.remember("ch-3", "registration");
    expect(store.take("ch-3", "authentication")).toBe(false);
    expect(store.take("ch-3", "registration")).toBe(false); // and it was consumed by the attempt
  });

  it("is bounded: beyond max, oldest entries are evicted (flood cannot grow memory)", () => {
    const { store } = harness(60_000, 3);
    for (let i = 0; i < 10; i++) store.remember(`ch-${i}`, "authentication");
    expect(store.size()).toBeLessThanOrEqual(3);
    expect(store.take("ch-0", "authentication")).toBe(false); // evicted
    expect(store.take("ch-9", "authentication")).toBe(true); // newest survives
  });

  it("expired entries are swept as new ones arrive", () => {
    const { store, tick } = harness(1000);
    store.remember("old", "authentication");
    tick(2000);
    store.remember("new", "authentication");
    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("enforcement semantics (the >=2 anti-lockout rule)", () => {
  const WA = { enabled: true, rpID: "x", origin: "https://x" };
  const storeWith = (n) => ({ countWebauthnCredentials: () => n });

  it("flag off -> nothing", () => {
    expect(enforcementState({ enabled: false }, storeWith(5))).toEqual({
      enabled: false,
      enforced: false,
      enrolling: false,
      credentials: 0,
    });
  });

  it("flag on with 0 or 1 credentials -> ENROLLMENT MODE (never enforced)", () => {
    for (const n of [0, 1]) {
      const s = enforcementState(WA, storeWith(n));
      expect(s.enforced).toBe(false);
      expect(s.enrolling).toBe(true);
    }
  });

  it(`flag on with >=${MIN_CREDENTIALS_FOR_ENFORCEMENT} credentials -> ENFORCED`, () => {
    for (const n of [2, 3, 10]) {
      const s = enforcementState(WA, storeWith(n));
      expect(s.enforced).toBe(true);
      expect(s.enrolling).toBe(false);
    }
  });

  it("createSecondFactorGate.required() tracks the live credential count", () => {
    let n = 0;
    const gate = createSecondFactorGate({
      webauthn: WA,
      auth: AUTH_ON,
      store: { countWebauthnCredentials: () => n },
    });
    expect(gate.required()).toBe(false); // enrollment mode
    n = 2;
    expect(gate.required()).toBe(true); // armed the moment the floor is met
    expect(gate.statusFields()).toEqual({ webauthn: { enabled: true, enforced: true, enrolling: false } });
  });
});

// ---------------------------------------------------------------------------
describe("small pure helpers", () => {
  it("sanitizeLabel bounds, trims, strips control chars, defaults", () => {
    expect(sanitizeLabel("  laptop-touchid  ")).toBe("laptop-touchid");
    expect(sanitizeLabel("a\x00b\x1fc")).toBe("abc");
    expect(sanitizeLabel("x".repeat(200)).length).toBe(64);
    expect(sanitizeLabel("")).toBe("passkey");
    expect(sanitizeLabel(null)).toBe("passkey");
  });

  it("toCredentialMeta whitelists (no publicKey/counter ever leaves)", () => {
    const meta = toCredentialMeta({
      id: "abc",
      publicKey: "SECRETISH",
      counter: 7,
      transports: ["internal"],
      label: "phone",
      created: "2026-07-17T00:00:00.000Z",
    });
    expect(meta).toEqual({ id: "abc", label: "phone", created: "2026-07-17T00:00:00.000Z", transports: ["internal"] });
    expect(JSON.stringify(meta)).not.toContain("SECRETISH");
  });

  it("challengeOfResponse pulls the base64url challenge; malformed -> null", () => {
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "ch-x", origin: "o" })).toString(
      "base64url",
    );
    expect(challengeOfResponse({ response: { clientDataJSON: cd } })).toBe("ch-x");
    expect(challengeOfResponse({})).toBe(null);
    expect(challengeOfResponse({ response: { clientDataJSON: "!!notb64" } })).toBe(null);
  });
});
