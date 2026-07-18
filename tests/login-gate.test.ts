import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAuthStatus,
  loginErrorMessage,
  notifyUnauthorized,
  passkeyErrorMessage,
  resetAuthForTests,
  setAuthStatus,
} from "../src/lib/authSession";

// The login gate for the auth-walled private instance (SIM-391; server side is
// server/auth.js + tests/auth.test.js). The client's session store and its one
// copy rule are pure (src/lib/authSession.ts), tested here without a DOM; the
// wiring contracts - the gate wraps the WHOLE app so data fetches are
// structurally deferred, the generic-error line, auth-off/demo rendering
// unchanged - are pinned by static source checks (the run-dock/demo-tour
// posture; no jsdom in this project). The live passphrase walk is qa-tester's.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

beforeEach(() => resetAuthForTests());

// --- the session store -----------------------------------------------------

describe("authSession store", () => {
  it("starts unprobed (null) - the gate holds ALL rendering until the first status answer", () => {
    expect(getAuthStatus()).toBeNull();
  });

  it("stores the probe verdict", () => {
    setAuthStatus({ authRequired: true, authenticated: false });
    expect(getAuthStatus()).toEqual({ authRequired: true, authenticated: false });
  });

  it("notifyUnauthorized (a mid-session 401) flips to the locked state", () => {
    setAuthStatus({ authRequired: true, authenticated: true });
    notifyUnauthorized();
    expect(getAuthStatus()).toEqual({ authRequired: true, authenticated: false });
  });

  it("identical writes are dropped - parallel 401s cannot churn subscribers", () => {
    // setAuthStatus with equal values must be a no-op write (same reference).
    setAuthStatus({ authRequired: true, authenticated: false });
    const ref = getAuthStatus();
    notifyUnauthorized();
    notifyUnauthorized();
    expect(getAuthStatus()).toBe(ref);
  });
});

// --- the copy rule (generic-error contract) ----------------------------------

describe("loginErrorMessage", () => {
  it("a credential 401 gets ONE generic line, leaking nothing", () => {
    expect(loginErrorMessage(401)).toBe("Passphrase not accepted.");
  });

  it("the server's rate limit (10/15min) surfaces honestly", () => {
    expect(loginErrorMessage(429)).toBe("Too many attempts - wait a few minutes.");
  });

  it("anything else is a transport problem, not a credential verdict", () => {
    expect(loginErrorMessage(500)).toBe("Could not reach the server - try again.");
    expect(loginErrorMessage(null)).toBe("Could not reach the server - try again.");
  });
});

// --- wiring contracts (static source pins) -----------------------------------

describe("login gate wiring contracts", () => {
  const gate = read("../src/components/LoginGate.tsx");
  const main = read("../src/main.tsx");
  const apiSrc = read("../src/api.ts");
  const topbar = read("../src/components/TopBar.tsx");
  const app = read("../src/App.tsx");

  it("the gate wraps the WHOLE app (main.tsx), so App's data hooks cannot mount before the status verdict", () => {
    expect(main).toMatch(/<LoginGate>\s*<App \/>\s*<\/LoginGate>/);
    // and the gate structurally defers: nothing renders pre-probe, children
    // render only when auth is off or the session is live.
    expect(gate).toContain("if (!status) return null;");
    expect(gate).toContain("if (status.authRequired && !status.authenticated) return <LoginCard />;");
  });

  it("auth off (laptop AND the public demo) renders exactly today's app - probe failure maps to no gate, and the gate never keys on appMode", () => {
    expect(gate).toContain('setAuthStatus({ authRequired: false, authenticated: true })');
    expect(gate).not.toContain("appMode");
    // the TopBar's only new chrome is gated on authRequired, off by default
    expect(topbar).toMatch(/\{authRequired && \(/);
  });

  it("the login POST rides same-origin credentials and returns the RAW response (its 401 never trips the global back-to-gate hook)", () => {
    // isolate api.login's own arrow (up to its closing `}),`) and assert on it
    const login = apiSrc.match(/login: \(passphrase: string\) =>\s*fetch\("\/api\/auth\/login",[\s\S]*?\}\),/)?.[0];
    expect(login).toBeTruthy();
    expect(login).toContain('credentials: "same-origin"');
    // api.login has no .then(json) - the gate reads res.status itself
    expect(login).not.toContain(".then");
    expect(login).not.toContain("json<");
  });

  it("a mid-session 401 from ANY api call flips back to the gate instead of a dead board", () => {
    expect(apiSrc).toContain("if (res.status === 401) notifyUnauthorized();");
  });

  it("the card carries the required input semantics and the exact copy", () => {
    expect(gate).toContain('type="password"');
    expect(gate).toContain("autoFocus");
    expect(gate).toContain('autoComplete="current-password"');
    expect(gate).toContain("Private instance · Session required");
    // the error line is ALWAYS the pure copy rule - never server body detail
    expect(gate).toContain("loginErrorMessage(res.status)");
    expect(gate).not.toMatch(/setErr\((?:body|data|json)/);
  });

  it("Log out lives in the TopBar, calls the logout endpoint, then returns to the gate", () => {
    expect(topbar).toContain("Log out");
    expect(app).toMatch(/api\.logout\(\)[\s\S]{0,200}setAuthStatus\(\{ authRequired: true, authenticated: false \}\)/);
  });
});

// --- SIM-394: the two-step reconciliation (guardian mirror condition M1) ------
// The dev-repo build grew a SECOND LoginGate because SIM-391 was never
// back-ported there; the mirror reconciles to ONE component - THIS repo's gate,
// extended. These pins prove the three SIM-391 properties survive the extension
// and that the flag-off render path is structurally unchanged. The server-side
// byte-identity (login body {ok:true}, status body deep-equal, no
// /api/webauthn/* route) is pinned by tests/webauthn-endpoints.test.js block 1.

describe("SIM-394 two-step login reconciliation (one gate, extended)", () => {
  const gate = read("../src/components/LoginGate.tsx");
  const session = read("../src/lib/authSession.ts");
  const passkeys = read("../src/lib/passkeys.ts");

  it("property 1 - status-gated boot survives: nothing renders before the /api/auth/status verdict, both steps stay inside LoginCard behind the same branch", () => {
    expect(gate).toContain("if (!status) return null;");
    expect(gate).toContain("if (status.authRequired && !status.authenticated) return <LoginCard />;");
    // the second step is a LoginCard-internal state, not a second gate or route
    expect(gate).toContain('useState<"passphrase" | "passkey">("passphrase")');
  });

  it("property 2 - generic error copy survives on BOTH factors: pure copy rules only, never server/browser detail", () => {
    // passphrase lane: unchanged rule
    expect(gate).toContain("loginErrorMessage(res.status)");
    // passkey lane: its own pure rule; the caught error's own text is never shown
    expect(gate).toContain("passkeyErrorMessage(e instanceof PasskeyStepError ? e.status : null)");
    expect(gate).not.toMatch(/setErr\((?:body|data|json|e\.message|String\(e\))/);
    // and the rule itself leaks nothing per class (server 401s are uniform too)
    expect(passkeyErrorMessage(401)).toBe("Passkey not accepted - try again.");
    expect(passkeyErrorMessage(400)).toBe("Passkey step did not complete - try again.");
    expect(passkeyErrorMessage(null)).toBe("Passkey step did not complete - try again.");
  });

  it("property 3 - 429 surfacing survives: the assertion lane shares the login limiter and surfaces the same honest line", () => {
    expect(passkeyErrorMessage(429)).toBe("Too many attempts - wait a few minutes.");
    expect(loginErrorMessage(429)).toBe("Too many attempts - wait a few minutes.");
  });

  it("flag-off render is IDENTICAL: the unlocked path returns bare children before any webauthn chrome, and the passkey step is reachable only from the server's webauthnRequired verdict", () => {
    expect(gate).toContain("if (!status.webauthn?.enabled) return <>{children}</>;");
    // exactly one transition into the passkey step, gated on the login body
    expect(gate.match(/setStep\("passkey"\)/g)?.length).toBe(1);
    expect(gate).toMatch(/if \(body\.webauthnRequired\) \{/);
    // the locked card's passphrase branch keeps its exact SIM-391 semantics
    expect(gate).toContain('type="password"');
    expect(gate).toContain('autoComplete="current-password"');
    expect(gate).toContain("Private instance · Session required");
  });

  it("the status store carries the optional webauthn block without churning on identical writes", () => {
    setAuthStatus({ authRequired: true, authenticated: true, webauthn: { enabled: true, enforced: false, enrolling: true } });
    const ref = getAuthStatus();
    setAuthStatus({ authRequired: true, authenticated: true, webauthn: { enabled: true, enforced: false, enrolling: true } });
    expect(getAuthStatus()).toBe(ref); // identical write dropped
    setAuthStatus({ authRequired: true, authenticated: true, webauthn: { enabled: true, enforced: true, enrolling: false } });
    expect(getAuthStatus()).not.toBe(ref); // enforcement flip propagates
  });

  it("the passkey lane never rides api.ts json() - its 401 cannot trip the global back-to-gate hook mid-ceremony", () => {
    expect(passkeys).not.toMatch(/from "\.\.\/api"|notifyUnauthorized/);
    expect(passkeys).toContain('credentials: "same-origin"');
  });

  it("enrollment chrome (nag banner, Passkeys pill, manager) mounts ONLY when the server reports the flag on", () => {
    // everything after the flag-off early return is flag-on territory by
    // construction; pin the early return's position before the banner JSX
    const offReturn = gate.indexOf("if (!status.webauthn?.enabled) return <>{children}</>;");
    const banner = gate.indexOf("Passkey enrollment incomplete");
    const pill = gate.indexOf(">\n        Passkeys\n      </button>");
    expect(offReturn).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(offReturn);
    expect(gate).toContain("<PasskeyManager onClose=");
    expect(pill === -1 || pill > offReturn).toBe(true);
  });
});
